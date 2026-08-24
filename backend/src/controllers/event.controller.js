import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all, transaction } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';

export const createTriggerSchema = z.object({
  projectId: z.string().min(1),
  eventName: z.string().min(1),
  queueId: z.string().min(1),
  name: z.string().min(1),
  jobType: z.enum(['http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script']),
  payloadTemplate: z.record(z.any()).optional().default({}),
  priority: z.number().int().min(1).max(100).optional().default(10)
});

export const emitEventSchema = z.object({
  projectId: z.string().min(1),
  eventName: z.string().min(1),
  payload: z.record(z.any()).optional().default({}),
  source: z.string().optional().default('api_emitter')
});

export class EventController {
  static async _checkProjectAccess(req, projectId) {
    const project = await get('SELECT org_id FROM projects WHERE id = ?', [projectId]);
    if (!project) return { exists: false, hasAccess: false };
    if (req.user.role === 'admin') return { exists: true, hasAccess: true, project };

    const membership = await get(
      'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
      [project.org_id, req.user.id]
    );
    return { exists: true, hasAccess: !!membership, project };
  }

  static async emitEvent(req, res, next) {
    try {
      const parsed = emitEventSchema.parse(req.body);
      const access = await EventController._checkProjectAccess(req, parsed.projectId);
      if (!access.exists) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }
      if (!access.hasAccess) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const now = new Date().toISOString();
      const eventId = uuidv4();

      await QueueManager.publishEvent('EVENT_EMITTED', {
        eventId,
        projectId: parsed.projectId,
        eventName: parsed.eventName,
        payload: parsed.payload,
        source: parsed.source,
        emittedAt: now
      });

      const triggers = await all(
        `SELECT et.*, q.name as queue_name
         FROM event_triggers et
         JOIN queues q ON et.queue_id = q.id
         WHERE et.project_id = ? AND et.event_name = ? AND et.is_active = 1`,
        [parsed.projectId, parsed.eventName]
      );

      const dispatchedJobs = [];

      for (const trigger of triggers) {
        const jobId = uuidv4();
        const triggerPayloadTemplate = trigger.payload_template ? JSON.parse(trigger.payload_template) : {};
        
        const mergedPayload = {
          ...triggerPayloadTemplate,
          ...parsed.payload,
          _event_context: {
            eventId,
            eventName: parsed.eventName,
            source: parsed.source,
            emittedAt: now
          }
        };

        const jobName = `[Event: ${parsed.eventName}] ${trigger.name}`;

        await transaction(async () => {
          await run(
            `INSERT INTO jobs (
              id, project_id, queue_id, name, job_type, status, priority, payload,
              timeout_seconds, scheduled_at, max_retries, retry_count,
              retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 60, ?, 3, 0, 'exponential_backoff', 5, 300, ?, ?)`,
            [
              jobId,
              parsed.projectId,
              trigger.queue_id,
              jobName,
              trigger.job_type,
              trigger.priority || 10,
              JSON.stringify(mergedPayload),
              now,
              now,
              now
            ]
          );

          await run(
            'UPDATE event_triggers SET total_triggers = total_triggers + 1, updated_at = ? WHERE id = ?',
            [now, trigger.id]
          );
        });

        const jobRecord = await get('SELECT * FROM jobs WHERE id = ?', [jobId]);
        await QueueManager.enqueueJob(trigger.queue_id, jobRecord, trigger.priority);

        await QueueManager.publishEvent('JOB_CREATED', {
          jobId,
          projectId: parsed.projectId,
          queueId: trigger.queue_id,
          name: jobName,
          jobType: trigger.job_type,
          status: 'queued',
          triggerId: trigger.id,
          eventName: parsed.eventName
        });

        dispatchedJobs.push({
          jobId,
          jobName,
          queueId: trigger.queue_id,
          queueName: trigger.queue_name,
          jobType: trigger.job_type,
          priority: trigger.priority,
          status: 'queued'
        });
      }

      res.status(200).json({
        success: true,
        data: {
          eventId,
          eventName: parsed.eventName,
          projectId: parsed.projectId,
          matchedTriggersCount: triggers.length,
          dispatchedJobsCount: dispatchedJobs.length,
          dispatchedJobs
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async listTriggers(req, res, next) {
    try {
      const { projectId } = req.query;
      let sql = `
        SELECT et.*, q.name as queue_name, p.name as project_name, p.org_id
        FROM event_triggers et
        JOIN queues q ON et.queue_id = q.id
        JOIN projects p ON et.project_id = p.id
        WHERE 1=1
      `;
      const params = [];

      if (req.user.role !== 'admin') {
        sql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      }

      if (projectId) {
        sql += ' AND et.project_id = ?';
        params.push(projectId);
      }
      sql += ' ORDER BY et.created_at DESC';

      const triggers = await all(sql, params);
      const parsed = triggers.map((t) => ({
        ...t,
        payload_template: t.payload_template ? JSON.parse(t.payload_template) : {}
      }));

      res.json({ success: true, data: parsed });
    } catch (err) {
      next(err);
    }
  }

  static async createTrigger(req, res, next) {
    try {
      const parsed = createTriggerSchema.parse(req.body);
      const access = await EventController._checkProjectAccess(req, parsed.projectId);
      if (!access.exists) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }
      if (!access.hasAccess) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const validQueue = await get('SELECT id FROM queues WHERE id = ? AND project_id = ?', [parsed.queueId, parsed.projectId]);
      if (!validQueue) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_QUEUE', message: `Queue "${parsed.queueId}" does not exist in project "${parsed.projectId}"` }
        });
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      await run(
        `INSERT INTO event_triggers (
          id, project_id, event_name, queue_id, name, job_type, payload_template,
          priority, is_active, total_triggers, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        [
          id,
          parsed.projectId,
          parsed.eventName,
          parsed.queueId,
          parsed.name,
          parsed.jobType,
          JSON.stringify(parsed.payloadTemplate || {}),
          parsed.priority,
          now,
          now
        ]
      );

      const created = await get('SELECT * FROM event_triggers WHERE id = ?', [id]);
      res.status(201).json({
        success: true,
        data: {
          ...created,
          payload_template: created.payload_template ? JSON.parse(created.payload_template) : {}
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async deleteTrigger(req, res, next) {
    try {
      const { id } = req.params;
      const trigger = await get(
        `SELECT et.*, p.org_id
         FROM event_triggers et
         JOIN projects p ON et.project_id = p.id
         WHERE et.id = ?`,
        [id]
      );

      if (!trigger) {
        return res.status(404).json({ success: false, error: { message: 'Event trigger not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [trigger.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      await run('DELETE FROM event_triggers WHERE id = ?', [id]);
      res.json({ success: true, message: 'Event trigger deleted' });
    } catch (err) {
      next(err);
    }
  }

  static async toggleTrigger(req, res, next) {
    try {
      const { id } = req.params;
      const trigger = await get(
        `SELECT et.*, p.org_id
         FROM event_triggers et
         JOIN projects p ON et.project_id = p.id
         WHERE et.id = ?`,
        [id]
      );

      if (!trigger) {
        return res.status(404).json({ success: false, error: { message: 'Event trigger not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [trigger.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const newStatus = trigger.is_active === 1 ? 0 : 1;
      const now = new Date().toISOString();
      await run('UPDATE event_triggers SET is_active = ?, updated_at = ? WHERE id = ?', [newStatus, now, id]);

      res.json({ success: true, message: `Event trigger ${newStatus === 1 ? 'activated' : 'paused'}`, isActive: newStatus === 1 });
    } catch (err) {
      next(err);
    }
  }
}

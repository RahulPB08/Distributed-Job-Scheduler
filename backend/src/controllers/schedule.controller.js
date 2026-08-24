import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';
import { JOB_TYPE_TO_SERVICE_QUEUE, ensureServiceQueues } from './queue.controller.js';

export const scheduleCreateSchema = z.object({
  projectId: z.string().min(1),
  queueId: z.string().optional(),
  name: z.string().min(1),
  jobType: z.enum(['http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script']),
  cronExpression: z.string().min(5).optional(),
  delaySeconds: z.number().int().min(1).optional(),
  payload: z.record(z.any()),
  priority: z.number().int().min(1).max(100).default(10)
});

export class ScheduleController {
  static async list(req, res, next) {
    try {
      const { projectId } = req.query;
      let sql = `
        SELECT s.*, p.name as project_name, q.name as queue_name, p.org_id
        FROM scheduled_jobs s
        JOIN projects p ON s.project_id = p.id
        JOIN queues q ON s.queue_id = q.id
        WHERE 1=1
      `;
      const params = [];

      if (req.user.role !== 'admin') {
        sql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      }

      if (projectId) {
        sql += ' AND s.project_id = ?';
        params.push(projectId);
      }
      sql += ' ORDER BY s.created_at DESC';

      const schedules = await all(sql, params);
      res.json({
        success: true,
        data: schedules.map((s) => ({
          ...s,
          payload: JSON.parse(s.payload || '{}')
        }))
      });
    } catch (err) {
      next(err);
    }
  }

  static async create(req, res, next) {
    try {
      const { projectId, queueId, name, jobType, cronExpression, delaySeconds, payload, priority } = req.body;
      const project = await get('SELECT * FROM projects WHERE id = ?', [projectId]);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Project not found' }
        });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [project.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      await ensureServiceQueues(projectId);

      let effectiveQueueId = queueId;
      if (!effectiveQueueId) {
        const expectedQueueName = JOB_TYPE_TO_SERVICE_QUEUE[jobType] || 'http-service-queue';
        const serviceQueue = await get('SELECT id FROM queues WHERE project_id = ? AND name = ?', [projectId, expectedQueueName]);
        effectiveQueueId = serviceQueue?.id;
      }

      const validQueue = await get('SELECT id FROM queues WHERE id = ? AND project_id = ?', [effectiveQueueId, projectId]);
      if (!validQueue) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_QUEUE', message: `Queue not found in project "${projectId}"` }
        });
      }

      const id = uuidv4();
      const now = new Date();
      let nextRunAt = null;

      if (delaySeconds) {
        nextRunAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
      } else {
        nextRunAt = new Date(now.getTime() + 60 * 1000).toISOString();
      }

      await run(
        'INSERT INTO scheduled_jobs (id, project_id, queue_id, name, job_type, cron_expression, delay_seconds, payload, priority, is_active, next_run_at, total_runs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)',
        [
          id,
          projectId,
          effectiveQueueId,
          name,
          jobType,
          cronExpression || null,
          delaySeconds || null,
          JSON.stringify(payload),
          priority || 10,
          nextRunAt,
          now.toISOString(),
          now.toISOString()
        ]
      );

      const created = await get('SELECT * FROM scheduled_jobs WHERE id = ?', [id]);
      res.status(201).json({
        success: true,
        data: {
          ...created,
          payload: JSON.parse(created.payload || '{}')
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const schedule = await get(
        `SELECT s.*, p.name as project_name, q.name as queue_name, p.org_id
         FROM scheduled_jobs s
         JOIN projects p ON s.project_id = p.id
         JOIN queues q ON s.queue_id = q.id
         WHERE s.id = ?`,
        [req.params.id]
      );

      if (!schedule) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Schedule not found' }
        });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [schedule.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      res.json({
        success: true,
        data: {
          ...schedule,
          payload: JSON.parse(schedule.payload || '{}')
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async update(req, res, next) {
    try {
      const schedule = await get('SELECT s.*, p.org_id FROM scheduled_jobs s JOIN projects p ON s.project_id = p.id WHERE s.id = ?', [req.params.id]);
      if (!schedule) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Schedule not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [schedule.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const { name, cronExpression, delaySeconds, payload, priority, isActive } = req.body;
      const now = new Date().toISOString();

      await run(
        'UPDATE scheduled_jobs SET name = COALESCE(?, name), cron_expression = COALESCE(?, cron_expression), delay_seconds = COALESCE(?, delay_seconds), payload = COALESCE(?, payload), priority = COALESCE(?, priority), is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?',
        [
          name,
          cronExpression,
          delaySeconds,
          payload ? JSON.stringify(payload) : null,
          priority,
          isActive !== undefined ? (isActive ? 1 : 0) : null,
          now,
          req.params.id
        ]
      );

      const updated = await get('SELECT * FROM scheduled_jobs WHERE id = ?', [req.params.id]);
      res.json({
        success: true,
        data: {
          ...updated,
          payload: JSON.parse(updated.payload || '{}')
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async toggle(req, res, next) {
    try {
      const schedule = await get('SELECT s.*, p.org_id FROM scheduled_jobs s JOIN projects p ON s.project_id = p.id WHERE s.id = ?', [req.params.id]);
      if (!schedule) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Schedule not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [schedule.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const newStatus = schedule.is_active ? 0 : 1;
      const now = new Date().toISOString();

      await run('UPDATE scheduled_jobs SET is_active = ?, updated_at = ? WHERE id = ?', [
        newStatus,
        now,
        req.params.id
      ]);

      res.json({
        success: true,
        data: { id: req.params.id, is_active: newStatus }
      });
    } catch (err) {
      next(err);
    }
  }

  static async trigger(req, res, next) {
    try {
      const schedule = await get('SELECT s.*, p.org_id FROM scheduled_jobs s JOIN projects p ON s.project_id = p.id WHERE s.id = ?', [req.params.id]);
      if (!schedule) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Schedule not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [schedule.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const jobId = uuidv4();
      const now = new Date().toISOString();

      await run(
        'INSERT INTO jobs (id, project_id, queue_id, name, job_type, status, priority, payload, timeout_seconds, scheduled_at, max_retries, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, "scheduled", ?, ?, 60, ?, 3, 0, ?, ?)',
        [
          jobId,
          schedule.project_id,
          schedule.queue_id,
          `${schedule.name} (Manual Trigger)`,
          schedule.job_type,
          schedule.priority,
          schedule.payload,
          now,
          now,
          now
        ]
      );

      await run('UPDATE scheduled_jobs SET total_runs = total_runs + 1, last_run_at = ? WHERE id = ?', [
        now,
        req.params.id
      ]);

      const job = await get('SELECT * FROM jobs WHERE id = ?', [jobId]);
      res.json({
        success: true,
        message: 'Scheduled job triggered immediately',
        data: {
          ...job,
          payload: JSON.parse(job.payload || '{}')
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async delete(req, res, next) {
    try {
      const schedule = await get('SELECT s.*, p.org_id FROM scheduled_jobs s JOIN projects p ON s.project_id = p.id WHERE s.id = ?', [req.params.id]);
      if (!schedule) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Schedule not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [schedule.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      await run('DELETE FROM scheduled_jobs WHERE id = ?', [req.params.id]);
      res.json({ success: true, message: 'Schedule deleted successfully' });
    } catch (err) {
      next(err);
    }
  }
}

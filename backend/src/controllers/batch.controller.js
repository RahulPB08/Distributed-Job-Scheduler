import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all, transaction } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';
import { ShardRouterService } from '../services/shard_router.service.js';
import { ensureServiceQueues, JOB_TYPE_TO_SERVICE_QUEUE } from './queue.controller.js';

export const createBatchSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  jobs: z.array(
    z.object({
      queueId: z.string().optional(),
      name: z.string().min(1),
      jobType: z.enum(['http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script']),
      payload: z.record(z.any()),
      priority: z.number().int().min(1).max(100).default(10),
      timeoutSeconds: z.number().int().min(1).max(3600).default(60),
      maxRetries: z.number().int().min(0).max(10).default(3)
    })
  ).optional(),
  templateJob: z.object({
    queueId: z.string().optional(),
    name: z.string().min(1),
    jobType: z.enum(['http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script']),
    payload: z.record(z.any()),
    priority: z.number().int().min(1).max(100).default(10),
    timeoutSeconds: z.number().int().min(1).max(3600).default(60),
    maxRetries: z.number().int().min(0).max(10).default(3)
  }).optional(),
  count: z.number().int().min(1).max(50000).optional()
}).refine(
  (data) => (data.jobs && data.jobs.length > 0) || (data.templateJob && data.count && data.count > 0),
  { message: 'Either a jobs array or a templateJob with count must be provided' }
);

export const batchCreateSchema = createBatchSchema;

export class BatchController {
  static async list(req, res, next) {
    try {
      const { projectId } = req.query;
      let sql = `
        SELECT b.id, b.project_id, b.name, b.created_at, b.updated_at,
               p.name as project_name, p.org_id,
               COUNT(j.id) as total_jobs,
               SUM(CASE WHEN j.status IN ('queued', 'scheduled') THEN 1 ELSE 0 END) as pending_jobs,
               SUM(CASE WHEN j.status IN ('running', 'claimed') THEN 1 ELSE 0 END) as running_jobs,
               SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) as completed_jobs,
               SUM(CASE WHEN j.status IN ('failed', 'dlq', 'cancelled') THEN 1 ELSE 0 END) as failed_jobs,
               CASE
                 WHEN COUNT(j.id) = 0 THEN b.status
                 WHEN SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) = COUNT(j.id) THEN 'completed'
                 WHEN SUM(CASE WHEN j.status IN ('failed', 'dlq') THEN 1 ELSE 0 END) = COUNT(j.id) THEN 'failed'
                 WHEN SUM(CASE WHEN j.status IN ('running', 'claimed') THEN 1 ELSE 0 END) > 0 THEN 'running'
                 WHEN SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) > 0 THEN 'running'
                 ELSE b.status
               END as status
        FROM batches b
        JOIN projects p ON b.project_id = p.id
        LEFT JOIN jobs j ON j.batch_id = b.id
        WHERE 1=1
      `;
      const params = [];

      if (req.user.role !== 'admin') {
        sql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      }

      if (projectId) {
        sql += ' AND b.project_id = ?';
        params.push(projectId);
      }
      sql += ' GROUP BY b.id, b.project_id, b.name, b.created_at, b.updated_at, p.name, p.org_id ORDER BY b.created_at DESC';

      const batches = await all(sql, params);
      res.json({ success: true, data: batches });
    } catch (err) {
      next(err);
    }
  }

  static async create(req, res, next) {
    try {
      const parsed = createBatchSchema.parse(req.body);

      const project = await get('SELECT * FROM projects WHERE id = ?', [parsed.projectId]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
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

      // Auto-ensure service queues for this project
      await ensureServiceQueues(parsed.projectId);

      // Build the list of jobs: either from jobs array or generated from templateJob * count
      let jobList = [];
      if (parsed.templateJob && parsed.count) {
        const count = parsed.count;
        for (let i = 1; i <= count; i++) {
          jobList.push({
            queueId: parsed.templateJob.queueId,
            name: `${parsed.templateJob.name} #${i}`,
            jobType: parsed.templateJob.jobType,
            payload: parsed.templateJob.payload,
            priority: parsed.templateJob.priority,
            timeoutSeconds: parsed.templateJob.timeoutSeconds,
            maxRetries: parsed.templateJob.maxRetries
          });
        }
      } else {
        jobList = parsed.jobs || [];
      }

      if (jobList.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'No jobs specified for batch' } });
      }

      const batchId = uuidv4();
      const now = new Date().toISOString();
      const totalJobs = jobList.length;

      // Adaptive Situation-Aware Scheduling & Multi-Queue Distribution:
      // Balances batch jobs across all service queues & shards proportionally
      const { AdaptiveLoadBalancerService } = await import('../autoscaling/index.js');
      const balancedJobList = await AdaptiveLoadBalancerService.distributeBatch(parsed.projectId, jobList);

      // Wrap batch and job creation in high-performance atomic SQLite transaction
      await transaction(async () => {
        await run(
          'INSERT INTO batches (id, project_id, name, total_jobs, pending_jobs, running_jobs, completed_jobs, failed_jobs, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, "pending", ?, ?)',
          [batchId, parsed.projectId, parsed.name, totalJobs, totalJobs, now, now]
        );

        // Insert jobs in chunks of 500 for optimal write speed
        const CHUNK_SIZE = 500;
        for (let i = 0; i < balancedJobList.length; i += CHUNK_SIZE) {
          const chunk = balancedJobList.slice(i, i + CHUNK_SIZE);
          for (let j = 0; j < chunk.length; j++) {
            const item = chunk[j];
            const jobId = uuidv4();

            await run(
              `INSERT INTO jobs (
                id, project_id, queue_id, shard_id, shard_index, batch_id, name, job_type,
                status, priority, payload, timeout_seconds, scheduled_at, max_retries,
                retry_count, retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "queued", ?, ?, ?, ?, ?, 0, "exponential_backoff", 5, 300, ?, ?)`,
              [
                jobId,
                parsed.projectId,
                item.queueId,
                item.shardId,
                item.shardIndex ?? 0,
                batchId,
                item.name,
                item.jobType,
                item.priority,
                JSON.stringify(item.payload),
                item.timeoutSeconds,
                now,
                item.maxRetries,
                now,
                now
              ]
            );
          }
        }
      });

      const created = await get('SELECT * FROM batches WHERE id = ?', [batchId]);

      try {
        await QueueManager.publishEvent('BATCH_CREATED', {
          batchId,
          projectId: parsed.projectId,
          totalJobs,
          timestamp: now
        });
      } catch (e) {}

      res.status(201).json({
        success: true,
        data: {
          ...created,
          totalJobsDispatched: totalJobs
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const { id } = req.params;
      const batch = await get(
        `SELECT b.id, b.project_id, b.name, b.created_at, b.updated_at,
                p.name as project_name, p.org_id,
                COUNT(j.id) as total_jobs,
                SUM(CASE WHEN j.status IN ('queued', 'scheduled') THEN 1 ELSE 0 END) as pending_jobs,
                SUM(CASE WHEN j.status IN ('running', 'claimed') THEN 1 ELSE 0 END) as running_jobs,
                SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) as completed_jobs,
                SUM(CASE WHEN j.status IN ('failed', 'dlq', 'cancelled') THEN 1 ELSE 0 END) as failed_jobs,
                CASE
                  WHEN COUNT(j.id) = 0 THEN b.status
                  WHEN SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) = COUNT(j.id) THEN 'completed'
                  WHEN SUM(CASE WHEN j.status IN ('failed', 'dlq') THEN 1 ELSE 0 END) = COUNT(j.id) THEN 'failed'
                  WHEN SUM(CASE WHEN j.status IN ('running', 'claimed') THEN 1 ELSE 0 END) > 0 THEN 'running'
                  WHEN SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) > 0 THEN 'running'
                  ELSE b.status
                END as status
         FROM batches b
         JOIN projects p ON b.project_id = p.id
         LEFT JOIN jobs j ON j.batch_id = b.id
         WHERE b.id = ?
         GROUP BY b.id, b.project_id, b.name, b.created_at, b.updated_at, p.name, p.org_id`,
        [id]
      );

      if (!batch) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Batch not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [batch.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const jobs = await all(
        `SELECT j.*, q.name as queue_name
         FROM jobs j
         LEFT JOIN queues q ON j.queue_id = q.id
         WHERE j.batch_id = ?
         ORDER BY j.created_at ASC
         LIMIT 100`,
        [id]
      );

      res.json({
        success: true,
        data: {
          ...batch,
          jobs: jobs.map((j) => ({
            ...j,
            payload: JSON.parse(j.payload || '{}'),
            result: j.result ? JSON.parse(j.result) : null,
            error_details: j.error_details ? JSON.parse(j.error_details) : null
          }))
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async cancel(req, res, next) {
    try {
      const { id } = req.params;
      const batch = await get('SELECT b.*, p.org_id FROM batches b JOIN projects p ON b.project_id = p.id WHERE b.id = ?', [id]);
      if (!batch) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Batch not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [batch.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const now = new Date().toISOString();
      await run('UPDATE batches SET status = "cancelled", updated_at = ? WHERE id = ?', [now, id]);
      await run('UPDATE jobs SET status = "cancelled", updated_at = ? WHERE batch_id = ? AND status IN ("scheduled", "queued")', [now, id]);

      res.json({ success: true, message: 'Batch and pending jobs cancelled' });
    } catch (err) {
      next(err);
    }
  }
}

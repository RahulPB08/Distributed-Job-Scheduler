import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all } from '../database/db.js';
import { QueueManager, QueueKeys } from '../redis/queue_manager.js';
import { ShardRouterService } from '../autoscaling/shard_router.service.js';
import { JOB_TYPE_TO_SERVICE_QUEUE, ensureServiceQueues } from './queue.controller.js';

export const createJobSchema = z.object({
  projectId: z.string().min(1),
  queueId: z.string().optional().nullable(),
  name: z.string().min(1),
  jobType: z.enum(['http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script']),
  payload: z.any().optional().default({}),
  priority: z.coerce.number().int().min(1).max(100).default(10),
  timeoutSeconds: z.coerce.number().int().min(1).max(3600).default(60),
  maxRetries: z.coerce.number().int().min(0).max(10).default(3),
  retryStrategy: z.enum(['none', 'fixed', 'linear_backoff', 'exponential_backoff']).optional().default('exponential_backoff'),
  retryBaseDelay: z.coerce.number().int().min(1).max(3600).optional().default(5),
  retryMaxDelay: z.coerce.number().int().min(1).max(86400).optional().default(300),
  scheduledAt: z.string().optional().nullable(),
  delaySeconds: z.coerce.number().int().min(0).optional(),
  idempotencyKey: z.string().optional().nullable()
});

export const jobCreateSchema = createJobSchema;

export class JobController {
  static async checkProjectOwnership(req, projectId) {
    const project = await get('SELECT id, org_id FROM projects WHERE id = ?', [projectId]);
    if (!project) return { exists: false, hasAccess: false };
    if (req.user.role === 'admin') return { exists: true, hasAccess: true, project };
    const membership = await get(
      'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
      [project.org_id, req.user.id]
    );
    return { exists: true, hasAccess: !!membership, project };
  }

  static async list(req, res, next) {
    try {
      const { projectId, queueId, status, page = '1', limit = '20', search } = req.query;
      const parsedPage = Math.max(1, parseInt(page, 10) || 1);
      const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (parsedPage - 1) * parsedLimit;

      let sql = `
        SELECT j.*, q.name as queue_name, p.name as project_name, p.org_id,
               w.hostname as worker_hostname, w.ip_address as worker_ip
        FROM jobs j
        JOIN queues q ON j.queue_id = q.id
        JOIN projects p ON j.project_id = p.id
        LEFT JOIN workers w ON j.worker_id = w.id
        WHERE 1=1
      `;
      let countSql = `
        SELECT COUNT(*) as total
        FROM jobs j
        JOIN projects p ON j.project_id = p.id
        WHERE 1=1
      `;
      const params = [];
      const countParams = [];

      if (req.user.role !== 'admin') {
        sql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        countSql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
        countParams.push(req.user.id);
      }

      if (projectId) {
        sql += ' AND j.project_id = ?';
        countSql += ' AND j.project_id = ?';
        params.push(projectId);
        countParams.push(projectId);
      }

      if (queueId) {
        sql += ' AND j.queue_id = ?';
        countSql += ' AND j.queue_id = ?';
        params.push(queueId);
        countParams.push(queueId);
      }

      if (status) {
        sql += ' AND j.status = ?';
        countSql += ' AND j.status = ?';
        params.push(status);
        countParams.push(status);
      }

      if (search) {
        sql += ' AND (j.name LIKE ? OR j.id LIKE ?)';
        countSql += ' AND (j.name LIKE ? OR j.id LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
        countParams.push(`%${search}%`, `%${search}%`);
      }

      const { sortBy = 'newest' } = req.query;
      if (sortBy === 'priority') {
        sql += ' ORDER BY j.priority DESC, j.created_at DESC LIMIT ? OFFSET ?';
      } else {
        sql += ' ORDER BY j.created_at DESC LIMIT ? OFFSET ?';
      }
      params.push(parsedLimit, offset);

      const totalResult = await get(countSql, countParams);
      const jobs = await all(sql, params);

      const safeJson = (val, fallback = null) => {
        if (!val) return fallback;
        if (typeof val === 'object') return val;
        try { return JSON.parse(val); } catch (e) { return val; }
      };

      const formatted = jobs.map((job) => ({
        ...job,
        payload: safeJson(job.payload, {}),
        result: safeJson(job.result, null),
        error_details: safeJson(job.error_details, null)
      }));

      res.json({
        success: true,
        data: {
          jobs: formatted,
          total: totalResult ? totalResult.total : 0,
          page: parseInt(page, 10),
          limit: parsedLimit,
          totalPages: Math.ceil((totalResult ? totalResult.total : 0) / parsedLimit)
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async create(req, res, next) {
    try {
      const parsed = createJobSchema.parse(req.body);

      const ownership = await JobController.checkProjectOwnership(req, parsed.projectId);
      if (!ownership.exists) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Project not found' }
        });
      }
      if (!ownership.hasAccess) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Unauthorized project access' }
        });
      }

      // Ensure dedicated service queues exist for this project
      await ensureServiceQueues(parsed.projectId);

      const idempotencyKey = parsed.idempotencyKey || req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

      if (idempotencyKey) {
        const existing = await get(
          'SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?',
          [parsed.projectId, idempotencyKey]
        );
        if (existing) {
          return res.json({
            success: true,
            data: {
              ...existing,
              payload: JSON.parse(existing.payload),
              idempotent: true
            }
          });
        }
      }

      // Adaptive Situation-Aware Scheduling & Distribution Algorithm:
      // Dynamically selects optimal queue & shard based on live congestion & capacity
      const { AdaptiveLoadBalancerService } = await import('../autoscaling/index.js');
      let effectiveQueueId = parsed.queueId;
      let targetShardId = null;
      let targetShardIndex = 0;

      if (!effectiveQueueId) {
        const balanced = await AdaptiveLoadBalancerService.selectOptimalQueueAndShard(
          parsed.projectId,
          parsed.jobType,
          { affinityKey: idempotencyKey }
        );
        effectiveQueueId = balanced.queueId;
        targetShardId = balanced.shardId;
        targetShardIndex = balanced.shardIndex;
      } else {
        const targetShard = await ShardRouterService.routeJob(effectiveQueueId, {
          strategy: 'least_loaded',
          affinityKey: idempotencyKey
        });
        targetShardId = targetShard?.id || null;
        targetShardIndex = targetShard?.shard_index ?? 0;
      }

      const queue = await get('SELECT id, name FROM queues WHERE id = ? AND project_id = ?', [
        effectiveQueueId,
        parsed.projectId
      ]);

      if (!queue) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'System queue not found for this service/project' }
        });
      }

      const id = uuidv4();
      const now = new Date();
      let scheduledAt = now.toISOString();
      let initialStatus = 'queued';

      if (parsed.delaySeconds) {
        scheduledAt = new Date(now.getTime() + parsed.delaySeconds * 1000).toISOString();
        initialStatus = 'scheduled';
      } else if (parsed.scheduledAt && new Date(parsed.scheduledAt) > now) {
        scheduledAt = new Date(parsed.scheduledAt).toISOString();
        initialStatus = 'scheduled';
      }

      await run(
        `INSERT INTO jobs (
          id, project_id, queue_id, shard_id, shard_index, name, job_type, status, priority, payload,
          timeout_seconds, scheduled_at, max_retries, retry_count,
          retry_strategy, retry_base_delay, retry_max_delay, idempotency_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          parsed.projectId,
          effectiveQueueId,
          targetShardId,
          targetShardIndex,
          parsed.name,
          parsed.jobType,
          initialStatus,
          parsed.priority,
          JSON.stringify(parsed.payload),
          parsed.timeoutSeconds,
          scheduledAt,
          parsed.maxRetries,
          parsed.retryStrategy,
          parsed.retryBaseDelay,
          parsed.retryMaxDelay,
          parsed.idempotencyKey || null,
          now.toISOString(),
          now.toISOString()
        ]
      );

      const created = await get('SELECT * FROM jobs WHERE id = ?', [id]);
      const formatted = {
        ...created,
        payload: JSON.parse(created.payload)
      };

      if (initialStatus === 'queued') {
        try {
          await QueueManager.enqueueJob(effectiveQueueId, formatted, parsed.priority, targetShard?.shard_index ?? 0);
        } catch (e) {}
      } else {
        try {
          await QueueManager.publishEvent('JOB_CREATED', {
            jobId: id,
            projectId: parsed.projectId,
            queueId: effectiveQueueId,
            shardIndex: targetShard?.shard_index ?? 0,
            status: initialStatus,
            timestamp: now.toISOString()
          });
        } catch (e) {}
      }

      res.status(201).json({ success: true, data: formatted });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const { id } = req.params;
      const job = await get(
        `SELECT j.*, q.name as queue_name, p.name as project_name, p.org_id,
                w.hostname as worker_hostname, w.ip_address as worker_ip
         FROM jobs j
         JOIN queues q ON j.queue_id = q.id
         JOIN projects p ON j.project_id = p.id
         LEFT JOIN workers w ON j.worker_id = w.id
         WHERE j.id = ?`,
        [id]
      );

      if (!job) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [job.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const executions = await all(
        'SELECT * FROM job_executions WHERE job_id = ? ORDER BY attempt_number DESC',
        [id]
      );

      const logs = await all(
        'SELECT * FROM job_logs WHERE job_id = ? ORDER BY timestamp ASC',
        [id]
      );

      const safeJson = (val, fallback = null) => {
        if (!val) return fallback;
        if (typeof val === 'object') return val;
        try { return JSON.parse(val); } catch (e) { return val; }
      };

      res.json({
        success: true,
        data: {
          ...job,
          payload: safeJson(job.payload, {}),
          result: safeJson(job.result, null),
          error_details: safeJson(job.error_details, null),
          executions,
          logs
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async retry(req, res, next) {
    try {
      const { id } = req.params;
      const job = await get(
        'SELECT j.*, p.org_id FROM jobs j JOIN projects p ON j.project_id = p.id WHERE j.id = ?',
        [id]
      );

      if (!job) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [job.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const now = new Date().toISOString();
      await run(
        'UPDATE jobs SET status = "queued", scheduled_at = ?, retry_count = 0, error_details = NULL, updated_at = ? WHERE id = ?',
        [now, now, id]
      );

      try {
        await QueueManager.enqueueJob(job.queue_id, {
          ...job,
          payload: JSON.parse(job.payload),
          status: 'queued'
        }, job.priority);
      } catch (e) {}

      res.json({ success: true, message: 'Job requeued successfully' });
    } catch (err) {
      next(err);
    }
  }

  static async cancel(req, res, next) {
    try {
      const { id } = req.params;
      const job = await get(
        'SELECT j.*, p.org_id FROM jobs j JOIN projects p ON j.project_id = p.id WHERE j.id = ?',
        [id]
      );

      if (!job) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [job.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      if (['completed', 'failed', 'dlq', 'cancelled'].includes(job.status)) {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: `Cannot cancel job in ${job.status} status` }
        });
      }

      const now = new Date().toISOString();
      await run('UPDATE jobs SET status = "cancelled", updated_at = ? WHERE id = ?', [now, id]);

      try {
        await QueueManager.removeJob(job.queue_id, id);
      } catch (e) {}

      res.json({ success: true, message: 'Job cancelled successfully' });
    } catch (err) {
      next(err);
    }
  }

  static async getLogs(req, res, next) {
    try {
      const { id } = req.params;
      const job = await get(
        'SELECT j.*, p.org_id FROM jobs j JOIN projects p ON j.project_id = p.id WHERE j.id = ?',
        [id]
      );
      if (!job) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [job.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const logs = await all(
        'SELECT * FROM job_logs WHERE job_id = ? ORDER BY timestamp ASC',
        [id]
      );
      res.json({ success: true, data: logs });
    } catch (err) {
      next(err);
    }
  }
}

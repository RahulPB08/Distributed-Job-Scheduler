import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { z } from 'zod';
import { run, get, all } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';
import { QueueAutoScalerService } from '../autoscaling/queue_autoscaler.service.js';

export const JOB_TYPE_TO_SERVICE_QUEUE = {
  http_request: 'http-service-queue',
  db_query: 'db-service-queue',
  cpu_compute: 'compute-service-queue',
  notification_event: 'notification-service-queue',
  custom_script: 'script-service-queue'
};

export const DEFAULT_SERVICE_QUEUES = [
  { name: 'http-service-queue', jobType: 'http_request', description: 'Automated System Queue for HTTP Services', priority: 10, maxConcurrency: 5, minShards: 2 },
  { name: 'db-service-queue', jobType: 'db_query', description: 'Automated System Queue for Database Operations', priority: 15, maxConcurrency: 5, minShards: 2 },
  { name: 'compute-service-queue', jobType: 'cpu_compute', description: 'Automated System Queue for CPU Compute Services', priority: 20, maxConcurrency: 5, minShards: 2 },
  { name: 'notification-service-queue', jobType: 'notification_event', description: 'Automated System Queue for Notifications & Alerts', priority: 25, maxConcurrency: 5, minShards: 2 },
  { name: 'script-service-queue', jobType: 'custom_script', description: 'Automated System Queue for Custom Script Workloads', priority: 10, maxConcurrency: 5, minShards: 2 },
];

/**
 * Ensures that all 5 dedicated service queues with exactly 2 baseline shards
 * exist for the specified project.
 */
export async function ensureServiceQueues(projectId) {
  if (!projectId) return;
  const projectExists = await get('SELECT id FROM projects WHERE id = ?', [projectId]);
  if (!projectExists) return;

  const now = new Date().toISOString();
  for (const sq of DEFAULT_SERVICE_QUEUES) {
    let q = await get('SELECT * FROM queues WHERE project_id = ? AND name = ?', [projectId, sq.name]);
    if (!q) {
      const qId = uuidv4();
      await run(
        `INSERT INTO queues (
          id, project_id, name, description, priority, max_concurrency, is_paused,
          min_shards, max_shards, jobs_per_shard, shard_count, shard_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 16, 15, 2, 0, ?, ?)`,
        [qId, projectId, sq.name, sq.description, sq.priority, sq.maxConcurrency, sq.minShards, now, now]
      );
      // Provision 2 baseline shards
      for (let i = 0; i < 2; i++) {
        const shardId = `qs_${qId.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        await run(
          'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, qId, i, now, now]
        );
      }
    } else {
      // Ensure at least 2 shards exist
      const existingShards = await all('SELECT * FROM queue_shards WHERE logical_queue_id = ? ORDER BY shard_index ASC', [q.id]);
      if (existingShards.length < 2) {
        for (let i = existingShards.length; i < 2; i++) {
          const shardId = `qs_${q.id.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
          await run(
            'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
            [shardId, q.id, i, now, now]
          );
        }
        await run('UPDATE queues SET min_shards = 2, shard_count = MAX(shard_count, 2) WHERE id = ?', [q.id]);
      }
    }
  }
}

export const queueSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  priority: z.coerce.number().int().min(1).max(100).default(10),
  maxConcurrency: z.coerce.number().int().min(1).max(100).default(5),
  minShards: z.coerce.number().int().min(2).max(64).optional(),
  maxShards: z.coerce.number().int().min(2).max(128).optional(),
  jobsPerShard: z.coerce.number().int().min(10).max(50000).optional(),
  retryPolicyId: z.string().nullish()
});

export class QueueController {
  static async list(req, res, next) {
    try {
      const { projectId } = req.query;

      // Auto-ensure service queues for all accessible projects
      if (projectId) {
        await ensureServiceQueues(projectId);
      } else {
        let accessibleProjects = [];
        if (req.user.role === 'admin') {
          accessibleProjects = await all('SELECT id FROM projects');
        } else {
          accessibleProjects = await all(
            'SELECT p.id FROM projects p JOIN organization_members om ON p.org_id = om.org_id WHERE om.user_id = ?',
            [req.user.id]
          );
        }
        for (const p of accessibleProjects) {
          await ensureServiceQueues(p.id);
        }
      }

      let sql = `
        SELECT q.*, p.name as project_name, rp.name as retry_policy_name, p.org_id
        FROM queues q
        JOIN projects p ON q.project_id = p.id
        LEFT JOIN retry_policies rp ON q.retry_policy_id = rp.id
        WHERE 1=1
      `;
      const params = [];

      if (req.user.role !== 'admin') {
        sql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      }

      if (projectId) {
        sql += ' AND q.project_id = ?';
        params.push(projectId);
      }
      sql += ' ORDER BY q.priority DESC, q.created_at ASC';

      const queues = await all(sql, params);

      for (const queue of queues) {
        try {
          const dbDepth = (await get('SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = "queued"', [queue.id]))?.count || 0;
          const runningJobs = (await get('SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status IN ("running", "claimed")', [queue.id]))?.count || 0;
          let redisDepth = 0;
          try {
            redisDepth = await QueueManager.getQueueDepth(queue.id);
          } catch (e) {}
          queue.live_depth = Math.max(dbDepth, redisDepth);
          queue.running_count = runningJobs;

          // Fetch child shards for this logical queue
          let shards = await all(
            'SELECT * FROM queue_shards WHERE logical_queue_id = ? ORDER BY shard_index ASC',
            [queue.id]
          );

          if (!shards || shards.length < 2) {
            const initialCount = 2;
            const now = new Date().toISOString();
            for (let i = shards ? shards.length : 0; i < initialCount; i++) {
              const shardId = `qs_${queue.id.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
              await run(
                'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
                [shardId, queue.id, i, now, now]
              );
            }
            shards = await all(
              'SELECT * FROM queue_shards WHERE logical_queue_id = ? ORDER BY shard_index ASC',
              [queue.id]
            );
          }

          // Per-shard telemetry counts
          const shardStats = await all(
            `SELECT shard_index, 
                    SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as pending_count,
                    SUM(CASE WHEN status IN ('running', 'claimed') THEN 1 ELSE 0 END) as running_count,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
                    SUM(CASE WHEN status IN ('failed', 'dlq') THEN 1 ELSE 0 END) as failed_count,
                    COUNT(*) as total_jobs
             FROM jobs 
             WHERE queue_id = ? 
             GROUP BY shard_index`,
            [queue.id]
          );

          const statsMap = new Map();
          for (const s of shardStats) {
            statsMap.set(s.shard_index, s);
          }

          queue.shards = shards.map((shard) => {
            const stats = statsMap.get(shard.shard_index) || {};
            return {
              ...shard,
              pending_count: stats.pending_count || 0,
              running_count: stats.running_count || 0,
              completed_count: stats.completed_count || 0,
              failed_count: stats.failed_count || 0,
              total_jobs: stats.total_jobs || 0
            };
          });
          queue.shard_count = shards.length;
        } catch (e) {
          queue.live_depth = 0;
          queue.running_count = 0;
          queue.shards = [];
        }
      }

      res.json({ success: true, data: queues });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const queue = await get(
        `SELECT q.*, p.name as project_name, rp.name as retry_policy_name, p.org_id
         FROM queues q
         JOIN projects p ON q.project_id = p.id
         LEFT JOIN retry_policies rp ON q.retry_policy_id = rp.id
         WHERE q.id = ?`,
        [req.params.id]
      );

      if (!queue) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [queue.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const dbDepth = (await get('SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = "queued"', [queue.id]))?.count || 0;
      const runningJobs = (await get('SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status IN ("running", "claimed")', [queue.id]))?.count || 0;
      queue.live_depth = dbDepth;
      queue.running_count = runningJobs;

      const shards = await all(
        'SELECT * FROM queue_shards WHERE logical_queue_id = ? ORDER BY shard_index ASC',
        [queue.id]
      );
      queue.shards = shards || [];
      queue.shard_count = queue.shards.length;

      res.json({ success: true, data: queue });
    } catch (err) {
      next(err);
    }
  }

  static async create(req, res, next) {
    // Automatically handled by system
    try {
      const { projectId, name, description, priority, maxConcurrency } = req.body;
      const project = await get('SELECT * FROM projects WHERE id = ?', [projectId]);

      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }

      const existing = await get('SELECT id FROM queues WHERE project_id = ? AND name = ?', [projectId, name]);
      if (existing) {
        return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Queue with this name already exists' } });
      }

      const id = uuidv4();
      const now = new Date().toISOString();
      await run(
        `INSERT INTO queues (
          id, project_id, name, description, priority, max_concurrency, is_paused,
          min_shards, max_shards, jobs_per_shard, shard_count, shard_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 2, 16, 15, 2, 0, ?, ?)`,
        [id, projectId, name, description || '', priority || 10, maxConcurrency || 5, now, now]
      );

      for (let i = 0; i < 2; i++) {
        const shardId = `qs_${id.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        await run(
          'INSERT INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, id, i, now, now]
        );
      }

      const created = await get('SELECT * FROM queues WHERE id = ?', [id]);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      next(err);
    }
  }

  static async pause(req, res, next) {
    try {
      const queue = await get('SELECT q.*, p.org_id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = ?', [req.params.id]);
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      await run('UPDATE queues SET is_paused = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), req.params.id]);
      res.json({ success: true, message: `Queue [${queue.name}] paused` });
    } catch (err) {
      next(err);
    }
  }

  static async resume(req, res, next) {
    try {
      const queue = await get('SELECT q.*, p.org_id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = ?', [req.params.id]);
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      await run('UPDATE queues SET is_paused = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), req.params.id]);
      res.json({ success: true, message: `Queue [${queue.name}] resumed` });
    } catch (err) {
      next(err);
    }
  }

  static async update(req, res, next) {
    try {
      const { priority, maxConcurrency, description } = req.body;
      const queue = await get('SELECT q.*, p.org_id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = ?', [req.params.id]);
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      await run(
        'UPDATE queues SET priority = COALESCE(?, priority), max_concurrency = COALESCE(?, max_concurrency), description = COALESCE(?, description), updated_at = ? WHERE id = ?',
        [priority, maxConcurrency, description, new Date().toISOString(), req.params.id]
      );
      const updated = await get('SELECT * FROM queues WHERE id = ?', [req.params.id]);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }

  static async purge(req, res, next) {
    try {
      const queue = await get('SELECT q.*, p.org_id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = ?', [req.params.id]);
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      await run("DELETE FROM jobs WHERE queue_id = ? AND status = 'queued'", [req.params.id]);
      try {
        await QueueManager.purgeQueue(req.params.id);
      } catch (_) {}
      res.json({ success: true, message: `Queue [${queue.name}] purged` });
    } catch (err) {
      next(err);
    }
  }

  static async scaleShards(req, res, next) {
    try {
      const { targetShards } = req.body;
      const target = Math.max(2, Math.min(16, parseInt(targetShards || '2', 10)));
      const queue = await get('SELECT q.*, p.org_id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = ?', [req.params.id]);
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      const currentShards = await all('SELECT * FROM queue_shards WHERE logical_queue_id = ? ORDER BY shard_index ASC', [req.params.id]);
      const now = new Date().toISOString();

      if (target > currentShards.length) {
        for (let i = currentShards.length; i < target; i++) {
          const shardId = `qs_${req.params.id.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
          await run(
            'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
            [shardId, req.params.id, i, now, now]
          );
        }
      } else if (target < currentShards.length) {
        for (let i = target; i < currentShards.length; i++) {
          await run('DELETE FROM queue_shards WHERE id = ?', [currentShards[i].id]);
        }
      }

      await run('UPDATE queues SET shard_count = ?, updated_at = ? WHERE id = ?', [target, now, req.params.id]);
      res.json({ success: true, data: { queueId: req.params.id, shardCount: target } });
    } catch (err) {
      next(err);
    }
  }

  static async getStats(req, res, next) {
    try {
      const queue = await get('SELECT * FROM queues WHERE id = ?', [req.params.id]);
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      const pending = (await get("SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = 'queued'", [req.params.id]))?.count || 0;
      const running = (await get("SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status IN ('running', 'claimed')", [req.params.id]))?.count || 0;
      const completed = (await get("SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = 'completed'", [req.params.id]))?.count || 0;
      const failed = (await get("SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status IN ('failed', 'dlq')", [req.params.id]))?.count || 0;

      res.json({
        success: true,
        data: {
          queueId: req.params.id,
          pending,
          running,
          completed,
          failed,
          total: pending + running + completed + failed
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async purge(req, res, next) {
    try {
      const queue = await get(
        `SELECT q.*, p.org_id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = ?`,
        [req.params.id]
      );
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [queue.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      await run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE queue_id = ? AND status = 'queued'", [new Date().toISOString(), req.params.id]);
      res.json({ success: true, message: 'Queue purged successfully' });
    } catch (err) {
      next(err);
    }
  }

  static async delete(req, res, next) {
    try {
      const queue = await get('SELECT q.*, p.org_id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = ?', [req.params.id]);
      if (!queue) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Queue not found' } });

      await run('DELETE FROM queue_shards WHERE logical_queue_id = ?', [req.params.id]);
      await run('DELETE FROM queues WHERE id = ?', [req.params.id]);
      res.json({ success: true, message: `Queue [${queue.name}] deleted` });
    } catch (err) {
      next(err);
    }
  }
}


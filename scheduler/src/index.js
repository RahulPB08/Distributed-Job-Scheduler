/**
 * Distributed Job Scheduler — Single Authoritative Scheduler Service
 *
 * Architecture:
 * ─────────────────────────────────────────
 * 1. Single Authoritative Scheduler Instance (No leader election complexity / no multi-scheduler scaling).
 * 2. Industry-Standard Priority + Weighted Fair Queuing + Aging (Starvation Prevention):
 *    - Dynamically evaluates effective job priority = Base Priority + Aging Factor.
 *    - Guarantees latency-critical jobs execute first while preventing lower priority starvation.
 * 3. Promotes delayed & scheduled jobs to the appropriate service queue & least-loaded shard.
 * 4. Cron expression evaluation (5-field parsing) with automatic service queue routing.
 * 5. Worker health monitoring & stale worker job reclamation.
 * 6. DAG workflow dependency progression.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { CronExpression } from 'cron-parser';
import { CONFIG } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Visual Logging ────────────────────────────────────────────────────────────
const log = {
  info:    (msg) => console.log(`[${new Date().toISOString()}] [SCHEDULER] [INFO]  ${msg}`),
  warn:    (msg) => console.warn(`[${new Date().toISOString()}] [SCHEDULER] [WARN]  ${msg}`),
  error:   (msg, err) => console.error(`[${new Date().toISOString()}] [SCHEDULER] [ERROR] ${msg}`, err?.message || ''),
  success: (msg) => console.log(`\x1b[32m[${new Date().toISOString()}] [SCHEDULER] [OK]    ${msg}\x1b[0m`),
  header:  (msg) => console.log(`\n\x1b[35m${'═'.repeat(70)}\n  ${msg}\n${'═'.repeat(70)}\x1b[0m`),
};

// ─── SQLite Helpers ────────────────────────────────────────────────────────────
let db;

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });

// ─── Redis Helpers ─────────────────────────────────────────────────────────────
let redis;

const getRedis = () => redis;

const publishEvent = async (type, data) => {
  try {
    if (redis && redis.status === 'ready') {
      await redis.publish('djs:events', JSON.stringify({ type, data, timestamp: new Date().toISOString() }));
    }
  } catch (_) { /* Redis optional */ }
};

// ─── Cron next-run calculation ─────────────────────────────────────────────────
const calculateNextRun = (cronExpr, delaySeconds) => {
  if (delaySeconds && delaySeconds > 0) {
    return new Date(Date.now() + delaySeconds * 1000).toISOString();
  }
  if (cronExpr) {
    try {
      const interval = CronExpression.parse(cronExpr, { utc: true });
      return interval.next().toDate().toISOString();
    } catch (e) {
      log.warn(`Invalid cron expression "${cronExpr}": ${e.message} — defaulting to +1h`);
    }
  }
  return new Date(Date.now() + 3600 * 1000).toISOString();
};

/**
 * Selects an optimal shard (least loaded) for a queue.
 */
async function getOptimalShard(queueId) {
  try {
    const shards = await dbAll(
      'SELECT id, shard_index FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
      [queueId]
    );
    if (!shards || shards.length === 0) return { id: null, shard_index: 0 };

    const shardStats = await dbAll(
      "SELECT shard_index, COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = 'queued' GROUP BY shard_index",
      [queueId]
    );
    const countsMap = new Map();
    for (const s of shardStats) countsMap.set(s.shard_index, s.count);

    let bestShard = shards[0];
    let minLoad = countsMap.get(bestShard.shard_index) || 0;
    for (let i = 1; i < shards.length; i++) {
      const load = countsMap.get(shards[i].shard_index) || 0;
      if (load < minLoad) {
        minLoad = load;
        bestShard = shards[i];
      }
    }
    return bestShard;
  } catch (_) {
    return { id: null, shard_index: 0 };
  }
}

async function getSituationAwareTarget(projectId, queueId) {
  try {
    const qCount = await dbGet(
      "SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = 'queued'",
      [queueId]
    );
    if ((qCount?.count || 0) > 12) {
      const allQueues = await dbAll(
        `SELECT q.id, (SELECT COUNT(*) FROM jobs WHERE queue_id = q.id AND status = 'queued') as pending
         FROM queues q WHERE q.project_id = ? AND q.is_paused = 0 ORDER BY pending ASC`,
        [projectId]
      );
      if (allQueues.length > 0 && allQueues[0].pending < (qCount?.count || 0)) {
        const bestQueue = allQueues[0];
        const shard = await getOptimalShard(bestQueue.id);
        return { queueId: bestQueue.id, shardId: shard.id, shardIndex: shard.shard_index };
      }
    }
    const shard = await getOptimalShard(queueId);
    return { queueId, shardId: shard.id, shardIndex: shard.shard_index };
  } catch (_) {
    return { queueId, shardId: null, shardIndex: 0 };
  }
}

/**
 * Promotes delayed/scheduled jobs to 'queued' using Priority + Aging algorithm.
 */
async function promoteDelayedJobs() {
  const now = new Date().toISOString();

  // Industry Standard: Priority + Dynamic Aging Scheduling
  // Effective Score = (priority * 10) + (seconds waiting / 10)
  const readyJobs = await dbAll(
    `SELECT j.id, j.project_id, j.queue_id, j.name, j.priority, j.scheduled_at, j.payload,
            (j.priority * 10 + CAST(MAX(0, (strftime('%s', ?) - strftime('%s', j.scheduled_at))) / 10 AS INTEGER)) as effective_priority
     FROM jobs j
     WHERE j.status = 'scheduled' AND j.scheduled_at <= ?
     ORDER BY effective_priority DESC, j.scheduled_at ASC
     LIMIT 50`,
    [now, now]
  );

  let promoted = 0;
  for (const job of readyJobs) {
    // Verify DAG dependencies
    const blockers = await dbGet(
      `SELECT COUNT(*) as count
       FROM workflow_dependencies wd
       JOIN jobs parent ON wd.parent_job_id = parent.id
       WHERE wd.child_job_id = ? AND (
         (wd.condition = 'on_success' AND parent.status != 'completed') OR
         (wd.condition = 'on_failure' AND parent.status != 'failed')
       )`,
      [job.id]
    );

    if (blockers && blockers.count > 0) continue;

    // Situation-Aware Scheduling: Selects least-loaded shard or balances to alternative queue if congested
    const target = await getSituationAwareTarget(job.project_id, job.queue_id);

    const result = await dbRun(
      `UPDATE jobs 
       SET status = 'queued', queue_id = ?, shard_id = ?, shard_index = ?, updated_at = ? 
       WHERE id = ? AND status = 'scheduled'`,
      [target.queueId, target.shardId, target.shardIndex, now, job.id]
    );

    if (result.changes > 0) {
      promoted++;
      log.success(`Promoted job [${job.name}] (Priority: ${job.priority}, EffPriority: ${job.effective_priority}, Queue: ${target.queueId}, Shard: #${target.shardIndex}) → QUEUED`);

      // Push to Redis queue if Redis is ready
      try {
        if (redis && redis.status === 'ready') {
          const redisKey = `queue:${target.queueId}:shard:${target.shardIndex}:jobs`;
          const parsedPayload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
          await redis.zadd(redisKey, job.priority || 10, JSON.stringify({ ...job, queue_id: target.queueId, shard_id: target.shardId, shard_index: target.shardIndex, payload: parsedPayload, status: 'queued' }));
        }
      } catch (_) {}

      await publishEvent('JOB_PROMOTED', {
        jobId: job.id,
        queueId: target.queueId,
        shardIndex: target.shardIndex,
        projectId: job.project_id,
        effectivePriority: job.effective_priority,
        timestamp: now
      });
    }
  }

  if (promoted > 0) {
    log.info(`Promoted ${promoted} delayed job(s) using Priority+Aging scheduling`);
  }
}

/**
 * Evaluates recurring cron schedules and spawns new job instances.
 */
async function evaluateCronSchedules() {
  const now = new Date().toISOString();
  const activeSchedules = await dbAll(
    `SELECT * FROM scheduled_jobs
     WHERE is_active = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
     ORDER BY priority DESC
     LIMIT 30`,
    [now]
  );

  for (const sched of activeSchedules) {
    const newJobId = uuidv4();
    const jobName = `${sched.name} (Run #${(sched.total_runs || 0) + 1})`;
    const nextRun = calculateNextRun(sched.cron_expression, sched.delay_seconds);
    const targetShard = await getOptimalShard(sched.queue_id);

    try {
      await new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN IMMEDIATE');
          db.run(
            `INSERT INTO jobs (
               id, project_id, queue_id, shard_id, shard_index, name, job_type, status, priority, payload,
               timeout_seconds, scheduled_at, max_retries, retry_count,
               retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 60, ?, 3, 0, 'exponential_backoff', 5, 300, ?, ?)`,
            [
              newJobId, sched.project_id, sched.queue_id, targetShard.id, targetShard.shard_index,
              jobName, sched.job_type, sched.priority || 10, sched.payload, now, now, now
            ]
          );
          db.run(
            `UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ?, total_runs = total_runs + 1, updated_at = ? WHERE id = ?`,
            [now, nextRun, now, sched.id]
          );
          db.run('COMMIT', (err) => {
            if (err) { db.run('ROLLBACK'); reject(err); } else resolve();
          });
        });
      });

      log.success(`Cron schedule [${sched.name}] dispatched → Job [${newJobId}] (Shard ${targetShard.shard_index}) | Next run: ${nextRun}`);
      await publishEvent('SCHEDULE_TRIGGERED', { scheduleId: sched.id, jobId: newJobId, nextRunAt: nextRun });
    } catch (e) {
      log.error(`Failed to dispatch cron schedule [${sched.name}]`, e);
    }
  }
}

/**
 * Reaps workers that haven't sent a heartbeat within the stale threshold.
 */
async function reapStaleWorkers() {
  const thresholdDate = new Date(Date.now() - CONFIG.STALE_WORKER_THRESHOLD_SEC * 1000).toISOString();
  const staleWorkers = await dbAll(
    `SELECT id, hostname, last_heartbeat_at
     FROM workers
     WHERE status IN ('healthy', 'degraded') AND last_heartbeat_at < ?`,
    [thresholdDate]
  );

  for (const worker of staleWorkers) {
    await dbRun(`UPDATE workers SET status = 'dead' WHERE id = ?`, [worker.id]);
    log.warn(`Reaper: Worker ${worker.hostname} (${worker.id}) declared DEAD (last heartbeat: ${worker.last_heartbeat_at})`);

    const stuckJobs = await dbAll(
      `SELECT id, name, queue_id, retry_count, max_retries, retry_strategy, retry_base_delay, retry_max_delay
       FROM jobs
       WHERE worker_id = ? AND status IN ('claimed', 'running')`,
      [worker.id]
    );

    const now = new Date().toISOString();
    for (const job of stuckJobs) {
      try {
        if (redis && job.queue_id) {
          await redis.srem(`queue:${job.queue_id}:running_jobs`, job.id);
        }
      } catch (_) {}

      const canRetry = (job.retry_count || 0) < (job.max_retries || 3);
      if (canRetry) {
        await dbRun(
          `UPDATE jobs SET status = 'queued', worker_id = NULL, retry_count = retry_count + 1, updated_at = ? WHERE id = ?`,
          [now, job.id]
        );
        log.info(`Re-queued orphaned job [${job.name}] (${job.id}) from dead worker ${worker.id}`);
      } else {
        const dlqId = uuidv4();
        const payloadRow = await dbGet('SELECT payload FROM jobs WHERE id = ?', [job.id]);
        await dbRun(
          `INSERT INTO dead_letter_queue (id, job_id, queue_id, project_id, failure_reason, retry_attempts, payload, archived_at)
           SELECT ?, ?, queue_id, project_id, 'Worker crash + max retries exceeded', ?, ?, ?
           FROM jobs WHERE id = ?`,
          [dlqId, job.id, job.retry_count, payloadRow?.payload || '{}', now, job.id]
        );
        await dbRun(
          `UPDATE jobs SET status = 'dlq', worker_id = NULL, updated_at = ? WHERE id = ?`,
          [now, job.id]
        );
        log.warn(`Moved job [${job.name}] (${job.id}) → DLQ (max retries exhausted after worker crash)`);
      }

      await dbRun(
        `INSERT INTO job_logs (id, job_id, log_level, message, timestamp) VALUES (?, ?, 'warn', ?, ?)`,
        [uuidv4(), job.id, `Reclaimed by single scheduler: heartbeat timeout (${CONFIG.STALE_WORKER_THRESHOLD_SEC}s)`, now]
      );
    }

    await publishEvent('WORKER_STALE', {
      workerId: worker.id,
      hostname: worker.hostname,
      reclaimedJobsCount: stuckJobs.length,
      timestamp: now
    });
  }
}

/**
 * Resolves DAG workflow dependencies.
 */
async function resolveDAGDependencies() {
  const now = new Date().toISOString();
  const recentlyFinished = await dbAll(
    `SELECT DISTINCT j.id, j.status
     FROM jobs j
     JOIN workflow_dependencies wd ON wd.parent_job_id = j.id
     JOIN jobs child ON wd.child_job_id = child.id
     WHERE j.status IN ('completed', 'failed', 'dlq')
       AND child.status IN ('scheduled', 'blocked')
       AND j.updated_at >= ?`,
    [new Date(Date.now() - CONFIG.POLL_INTERVAL_MS * 3).toISOString()]
  );

  for (const parent of recentlyFinished) {
    const children = await dbAll(
      `SELECT child_job_id FROM workflow_dependencies WHERE parent_job_id = ?`,
      [parent.id]
    );

    for (const dep of children) {
      const childId = dep.child_job_id;
      const allParents = await dbAll(
        `SELECT wd.condition, p.status
         FROM workflow_dependencies wd
         JOIN jobs p ON wd.parent_job_id = p.id
         WHERE wd.child_job_id = ?`,
        [childId]
      );

      const satisfied = allParents.every((p) => {
        if (p.condition === 'on_success') return p.status === 'completed';
        if (p.condition === 'on_failure') return p.status === 'failed' || p.status === 'dlq';
        return true;
      });

      if (satisfied) {
        const result = await dbRun(
          `UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'blocked')`,
          [now, childId]
        );
        if (result.changes > 0) {
          log.success(`DAG: Child job [${childId}] unlocked → QUEUED`);
          await publishEvent('DAG_NODE_UNLOCKED', { childJobId: childId, parentJobId: parent.id, timestamp: now });
        }
      }
    }
  }
}

// ─── Service Queue Definitions (one per job type) ─────────────────────────────
const DEFAULT_SERVICE_QUEUES = [
  { name: 'http-service-queue',          jobType: 'http_request',         description: 'System Queue — HTTP Services',            priority: 10,  maxConcurrency: 5 },
  { name: 'db-service-queue',            jobType: 'db_query',             description: 'System Queue — Database Operations',        priority: 15,  maxConcurrency: 5 },
  { name: 'compute-service-queue',       jobType: 'cpu_compute',          description: 'System Queue — CPU Compute Services',       priority: 20,  maxConcurrency: 5 },
  { name: 'notification-service-queue',  jobType: 'notification_event',   description: 'System Queue — Notifications & Alerts',     priority: 25,  maxConcurrency: 5 },
  { name: 'script-service-queue',        jobType: 'custom_script',        description: 'System Queue — Custom Script Workloads',    priority: 10,  maxConcurrency: 5 },
];

/**
 * Auto-creates the 5 dedicated service queues for every project that doesn't
 * already have them. Also provisions 2 baseline shards per queue.
 * Safe to call on every tick — fully idempotent via INSERT OR IGNORE.
 */
async function ensureAllProjectQueues() {
  try {
    const projects = await dbAll('SELECT id FROM projects');
    if (!projects || projects.length === 0) return;

    const now = new Date().toISOString();

    for (const project of projects) {
      const projectId = project.id;

      for (const sq of DEFAULT_SERVICE_QUEUES) {
        // Check if queue already exists
        const existing = await dbGet(
          'SELECT id, shard_count FROM queues WHERE project_id = ? AND name = ?',
          [projectId, sq.name]
        );

        let queueId;
        if (!existing) {
          // Create queue
          queueId = uuidv4();
          await dbRun(
            `INSERT OR IGNORE INTO queues (
               id, project_id, name, description, priority, max_concurrency, is_paused,
               min_shards, max_shards, jobs_per_shard, shard_count, shard_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 0, 2, 16, 15, 2, 0, ?, ?)`,
            [queueId, projectId, sq.name, sq.description, sq.priority, sq.maxConcurrency, now, now]
          );
          log.success(`Auto-created queue [${sq.name}] for project [${projectId}]`);
        } else {
          queueId = existing.id;
        }

        // Ensure at least 2 shards exist for this queue
        const shards = await dbAll(
          'SELECT id FROM queue_shards WHERE logical_queue_id = ?',
          [queueId]
        );

        for (let i = shards.length; i < 2; i++) {
          const shardId = `qs_${queueId.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
          await dbRun(
            `INSERT OR IGNORE INTO queue_shards
               (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at)
             VALUES (?, ?, ?, 'active', 0, ?, ?)`,
            [shardId, queueId, i, now, now]
          );
        }
      }
    }
  } catch (err) {
    log.error('ensureAllProjectQueues error', err);
  }
}

// ─── Main Scheduler Loop ───────────────────────────────────────────────────────
let isRunning = false;
let tickTimer = null;
// Run queue provisioning every 30s, not on every tick (performance)
let queueProvisionCounter = 0;

async function tick() {
  if (!isRunning) return;

  try {
    // Ensure service queues exist for all projects every ~30s (20 ticks × 1.5s)
    queueProvisionCounter++;
    if (queueProvisionCounter >= 20 || queueProvisionCounter === 1) {
      queueProvisionCounter = 0;
      await ensureAllProjectQueues();
    }

    await promoteDelayedJobs();
    await evaluateCronSchedules();
    await reapStaleWorkers();
    await resolveDAGDependencies();
  } catch (err) {
    log.error('Scheduler cycle error', err);
  }

  if (isRunning) {
    tickTimer = setTimeout(tick, CONFIG.POLL_INTERVAL_MS);
  }
}

// ─── Startup & Shutdown ────────────────────────────────────────────────────────
async function start() {
  log.header('DJS Single Authoritative Scheduler Service');
  log.info(`Mode:             Single Authoritative (No Leader Election / HA Overhead)`);
  log.info(`Algorithm:        Priority + Fair Queuing + Aging (Starvation Prevention)`);
  log.info(`DB path:          ${CONFIG.DB_PATH}`);
  log.info(`Poll interval:    ${CONFIG.POLL_INTERVAL_MS}ms`);
  log.info(`Stale threshold:  ${CONFIG.STALE_WORKER_THRESHOLD_SEC}s`);

  if (!fs.existsSync(CONFIG.DB_PATH)) {
    log.warn(`Database not found at ${CONFIG.DB_PATH} — waiting for backend initialization...`);
    await new Promise((r) => setTimeout(r, 4000));
  }

  const sqlt = sqlite3.verbose();
  db = new sqlt.Database(CONFIG.DB_PATH, (err) => {
    if (err) {
      log.error('Failed to open database', err);
      process.exit(1);
    }
  });

  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA busy_timeout = 15000;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run('PRAGMA foreign_keys = ON;');
  });

  try {
    redis = new Redis(CONFIG.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
      enableOfflineQueue: false
    });
    await redis.connect();
    log.info(`Connected to Redis at ${CONFIG.REDIS_URL}`);
  } catch (e) {
    log.warn('Redis unavailable — proceeding with SQLite-only scheduling mode');
  }

  isRunning = true;
  tick();
  log.success('Scheduler loop running successfully');

  const shutdown = async (sig) => {
    log.warn(`Received ${sig}. Shutting down scheduler gracefully...`);
    isRunning = false;
    if (tickTimer) clearTimeout(tickTimer);
    if (redis) try { await redis.quit(); } catch (_) {}
    if (db) db.close(() => log.info('SQLite database closed'));
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  log.error('Fatal scheduler startup error', err);
  process.exit(1);
});

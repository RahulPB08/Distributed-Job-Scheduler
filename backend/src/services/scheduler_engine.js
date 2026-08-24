import { v4 as uuidv4 } from 'uuid';
import { run, get, all, transaction } from '../database/db.js';
import { CheckpointLogger } from './checkpoint_logger.js';
import { RealtimeEventServer } from '../websocket/ws_server.js';
import { ShardRouterService } from '../autoscaling/shard_router.service.js';

export class SchedulerEngine {
  constructor(options = {}) {
    this.pollIntervalMs = options.pollIntervalMs || 1000;
    this.staleWorkerThresholdSec = options.staleWorkerThresholdSec || 30;
    this.timer = null;
    this.isRunning = false;
    this.wsServer = options.wsServer || null;
  }

  setWsServer(wsServer) {
    this.wsServer = wsServer;
  }

  broadcast(event, payload) {
    if (this.wsServer) {
      this.wsServer.broadcastEvent(event, payload);
    }
  }

  async start() {
    this.isRunning = true;
    CheckpointLogger.header('DJS Single Authoritative Scheduler Engine Started');
    CheckpointLogger.info(`Scheduler loop active (Priority+Aging mode, interval: ${this.pollIntervalMs}ms)`);
    this.tick();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    CheckpointLogger.info('Scheduler Engine stopped');
  }

  async tick() {
    if (!this.isRunning) return;

    try {
      await this.promoteDelayedJobs();
      if (!this.isRunning) return;
      await this.evaluateCronSchedules();
      if (!this.isRunning) return;
      await this.reapStaleWorkers();
    } catch (err) {
      if (this.isRunning && !err.message?.includes('Database handle is closed')) {
        CheckpointLogger.error('Scheduler tick error', err);
      }
    } finally {
      if (this.isRunning) {
        this.timer = setTimeout(() => this.tick(), this.pollIntervalMs);
      }
    }
  }

  /**
   * Promotes delayed/scheduled jobs to 'queued' using Priority + Aging algorithm.
   */
  async promoteDelayedJobs() {
    const now = new Date().toISOString();
    const readyJobs = await all(
      `SELECT j.id, j.project_id, j.queue_id, j.name, j.priority, j.scheduled_at,
              (j.priority * 10 + CAST(MAX(0, (strftime('%s', ?) - strftime('%s', j.scheduled_at))) / 10 AS INTEGER)) as effective_priority
       FROM jobs j
       WHERE j.status = 'scheduled' AND j.scheduled_at <= ?
       ORDER BY effective_priority DESC, j.scheduled_at ASC
       LIMIT 50`,
      [now, now]
    );

    for (const job of readyJobs) {
      // Check if job is part of a blocked DAG dependency
      const unsatisfiedParents = await get(
        `SELECT COUNT(*) as count FROM workflow_dependencies wd
         JOIN jobs parent ON wd.parent_job_id = parent.id
         WHERE wd.child_job_id = ? AND (
           (wd.condition = 'on_success' AND parent.status != 'completed') OR
           (wd.condition = 'on_failure' AND parent.status != 'failed')
         )`,
        [job.id]
      );

      if (unsatisfiedParents && unsatisfiedParents.count > 0) {
        continue;
      }

      const targetShard = await ShardRouterService.routeJob(job.queue_id, { strategy: 'least_loaded' });

      await run(
        "UPDATE jobs SET status = 'queued', shard_id = ?, shard_index = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'",
        [targetShard?.id || null, targetShard?.shard_index ?? 0, now, job.id]
      );

      CheckpointLogger.info(`Promoted delayed job [${job.name}] to QUEUED (Priority: ${job.priority}, Effective: ${job.effective_priority}, Shard: ${targetShard?.shard_index ?? 0})`, {
        jobId: job.id,
        scheduledAt: job.scheduled_at,
        promotedAt: now
      });

      this.broadcast('JOB_PROMOTED', {
        jobId: job.id,
        projectId: job.project_id,
        queueId: job.queue_id,
        shardIndex: targetShard?.shard_index ?? 0,
        name: job.name,
        status: 'queued',
        timestamp: now
      });
    }
  }

  /**
   * Evaluates recurring cron / delayed schedules and enqueues new job instances
   */
  async evaluateCronSchedules() {
    const now = new Date().toISOString();
    const activeSchedules = await all(
      'SELECT * FROM scheduled_jobs WHERE is_active = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY priority DESC LIMIT 20',
      [now]
    );

    for (const sched of activeSchedules) {
      const fresh = await get('SELECT * FROM scheduled_jobs WHERE id = ? AND is_active = 1 AND (next_run_at IS NULL OR next_run_at <= ?)', [sched.id, now]);
      if (!fresh) continue;

      const newJobId = uuidv4();
      const jobName = `${sched.name} (Run #${sched.total_runs + 1})`;
      const nextRun = this.calculateNextRun(sched.cron_expression, sched.delay_seconds);
      const targetShard = await ShardRouterService.routeJob(sched.queue_id, { strategy: 'least_loaded' });

      await transaction(async () => {
        await run(
          `INSERT INTO jobs (
            id, project_id, queue_id, shard_id, shard_index, name, job_type, status, priority, payload,
            timeout_seconds, scheduled_at, max_retries, retry_count,
            retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 60, ?, 3, 0, 'exponential_backoff', 5, 300, ?, ?)`,
          [
            newJobId,
            sched.project_id,
            sched.queue_id,
            targetShard?.id || null,
            targetShard?.shard_index ?? 0,
            jobName,
            sched.job_type,
            sched.priority || 10,
            sched.payload,
            now,
            now,
            now
          ]
        );

        await run(
          'UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ?, total_runs = total_runs + 1, updated_at = ? WHERE id = ?',
          [now, nextRun, now, sched.id]
        );
      });

      CheckpointLogger.info(`Scheduled job [${jobName}] triggered (Shard: ${targetShard?.shard_index ?? 0}, Next run: ${nextRun})`, {
        scheduleId: sched.id,
        newJobId,
        nextRunAt: nextRun
      });

      this.broadcast('SCHEDULE_TRIGGERED', {
        scheduleId: sched.id,
        newJobId,
        nextRunAt: nextRun,
        timestamp: now
      });
    }
  }

  /**
   * Reaps stale workers that missed heartbeats and returns claimed jobs to 'queued'
   */
  async reapStaleWorkers() {
    const thresholdDate = new Date(Date.now() - this.staleWorkerThresholdSec * 1000).toISOString();
    const staleWorkers = await all(
      "SELECT id, hostname, last_heartbeat_at FROM workers WHERE status IN ('healthy', 'degraded') AND last_heartbeat_at < ?",
      [thresholdDate]
    );

    for (const worker of staleWorkers) {
      await run("UPDATE workers SET status = 'dead' WHERE id = ?", [worker.id]);

      const stuckJobs = await all(
        "SELECT id, name, queue_id, retry_count, max_retries FROM jobs WHERE worker_id = ? AND status IN ('claimed', 'running')",
        [worker.id]
      );

      const now = new Date().toISOString();
      for (const job of stuckJobs) {
        if ((job.retry_count || 0) < (job.max_retries || 3)) {
          await run(
            "UPDATE jobs SET status = 'queued', worker_id = NULL, retry_count = retry_count + 1, updated_at = ? WHERE id = ?",
            [now, job.id]
          );
        } else {
          await run(
            "UPDATE jobs SET status = 'dlq', worker_id = NULL, updated_at = ? WHERE id = ?",
            [now, job.id]
          );
        }
      }

      this.broadcast('WORKER_STALE', {
        workerId: worker.id,
        hostname: worker.hostname,
        reclaimedJobsCount: stuckJobs.length,
        timestamp: now
      });
    }
  }

  calculateNextRun(cronExpression, delaySeconds) {
    const now = new Date();
    if (delaySeconds && delaySeconds > 0) {
      return new Date(now.getTime() + delaySeconds * 1000).toISOString();
    }
    if (cronExpression) {
      try {
        const parts = cronExpression.trim().split(/\s+/);
        if (parts.length >= 5) {
          const minutePart = parts[0];
          if (minutePart.startsWith('*/')) {
            const step = parseInt(minutePart.slice(2), 10) || 5;
            return new Date(now.getTime() + step * 60 * 1000).toISOString();
          }
        }
        return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      } catch (err) {
        return new Date(now.getTime() + 60 * 1000).toISOString();
      }
    }
    return new Date(now.getTime() + 60 * 1000).toISOString();
  }
}

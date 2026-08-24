import { run, get, all, transaction } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';

/**
 * QueueShardSnatcherService
 *
 * Implements autonomous Queue & Shard level Work-Stealing / Job Snatching:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Cross-Shard Job Snatching:
 *    When Shard #0 has a large backlog (e.g. 500+ jobs) and newly scaled / idle
 *    shards (Shard #1, #2, etc.) have 0 jobs, idle shards immediately snatch
 *    and rebalance batches of pending jobs from the overloaded shard.
 *
 * 2. Cross-Queue Job Snatching:
 *    When a service queue (e.g. http-service-queue) is heavily overloaded with
 *    backlog and other service queues (db, compute, notification, script) are idle,
 *    the idle queues snatch jobs to ensure all shards and capacity across the
 *    project are utilized with ZERO queue/shard idle time.
 *
 * 3. Structured Real-time Telemetry:
 *    Records snatch operations, tracks metrics, and broadcasts live WebSocket
 *    events to the frontend dashboard.
 */
export class QueueShardSnatcherService {
  static timer = null;
  static isRunning = false;

  static stats = {
    totalJobsSnatched: 0,
    crossShardSnatches: 0,
    crossQueueSnatches: 0,
    recentEvents: []
  };

  static start(intervalMs = 2000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.rebalanceAndSnatch().catch((err) => {
        console.error('[QUEUE_SHARD_SNATCHER] Snatching cycle error:', err.message);
      });
    }, intervalMs);
    console.log('[QUEUE_SHARD_SNATCHER] ⚡ Queue & Shard Work-Stealing Snatcher active (Cross-Shard & Cross-Queue)');
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Main snatching loop across all queues and shards.
   */
  static async rebalanceAndSnatch() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this._rebalanceCrossShards();
      await this._rebalanceCrossQueues();
    } catch (err) {
      console.error('[QUEUE_SHARD_SNATCHER] Error in snatch cycle:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 1. Cross-Shard Snatching within the same logical queue.
   * If Shard A has backlog and Shard B is empty/idle, Shard B snatches jobs from Shard A.
   */
  static async _rebalanceCrossShards() {
    const queues = await all('SELECT id, name, project_id FROM queues WHERE is_paused = 0');

    for (const queue of queues) {
      const shards = await all(
        'SELECT id, shard_index, status FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
        [queue.id]
      );

      if (!shards || shards.length <= 1) continue;

      // Count pending jobs per shard
      const shardLoads = await all(
        `SELECT shard_index, COUNT(*) as count 
         FROM jobs 
         WHERE queue_id = ? AND status = 'queued' 
         GROUP BY shard_index`,
        [queue.id]
      );

      const loadMap = new Map();
      shards.forEach((s) => loadMap.set(s.shard_index, 0));
      shardLoads.forEach((row) => loadMap.set(row.shard_index, row.count));

      // Find overloaded shard and underloaded / idle shards
      let maxShardIndex = shards[0].shard_index;
      let minShardIndex = shards[0].shard_index;
      let maxLoad = loadMap.get(maxShardIndex) || 0;
      let minLoad = loadMap.get(minShardIndex) || 0;

      for (const s of shards) {
        const load = loadMap.get(s.shard_index) || 0;
        if (load > maxLoad) {
          maxLoad = load;
          maxShardIndex = s.shard_index;
        }
        if (load < minLoad) {
          minLoad = load;
          minShardIndex = s.shard_index;
        }
      }

      // Snatch condition: difference is > 4 jobs and minLoad is lower
      const loadDiff = maxLoad - minLoad;
      if (loadDiff > 4) {
        const snatchCount = Math.min(Math.floor(loadDiff / 2), 50); // Snatch half the surplus up to 50 jobs
        const targetShard = shards.find((s) => s.shard_index === minShardIndex);

        // Find candidate jobs from the busy shard
        const candidateJobs = await all(
          `SELECT id FROM jobs 
           WHERE queue_id = ? AND shard_index = ? AND status = 'queued' 
           ORDER BY priority ASC, created_at DESC 
           LIMIT ?`,
          [queue.id, maxShardIndex, snatchCount]
        );

        if (candidateJobs && candidateJobs.length > 0) {
          const jobIds = candidateJobs.map((j) => j.id);
          const placeholders = jobIds.map(() => '?').join(',');
          const nowIso = new Date().toISOString();

          await run(
            `UPDATE jobs 
             SET shard_id = ?, shard_index = ?, updated_at = ? 
             WHERE id IN (${placeholders}) AND status = 'queued'`,
            [targetShard.id, targetShard.shard_index, nowIso, ...jobIds]
          );

          this.stats.totalJobsSnatched += jobIds.length;
          this.stats.crossShardSnatches += jobIds.length;

          const event = {
            type: 'CROSS_SHARD_JOB_SNATCH',
            queueId: queue.id,
            queueName: queue.name,
            fromShard: maxShardIndex,
            toShard: minShardIndex,
            jobsCount: jobIds.length,
            timestamp: nowIso
          };

          this._recordEvent(event);
          console.log(`[QUEUE_SHARD_SNATCHER] ⚡ Shard #${minShardIndex} snatched ${jobIds.length} job(s) from busy Shard #${maxShardIndex} in [${queue.name}]`);

          try {
            await QueueManager.publishEvent('QUEUE_SHARD_SNATCH_EVENT', event);
          } catch (_) {}
        }
      }
    }
  }

  /**
   * 2. Cross-Queue Snatching within the same project.
   * If Queue A (e.g. http) is overloaded and Queue B (e.g. compute) is idle,
   * Queue B's shards snatch jobs from Queue A.
   */
  static async _rebalanceCrossQueues() {
    const projects = await all('SELECT id, name FROM projects');

    for (const project of projects) {
      const queues = await all(
        'SELECT id, name, priority FROM queues WHERE project_id = ? AND is_paused = 0 ORDER BY priority DESC',
        [project.id]
      );

      if (!queues || queues.length <= 1) continue;

      // Check pending counts per queue
      const queueCounts = await all(
        `SELECT queue_id, COUNT(*) as count 
         FROM jobs 
         WHERE project_id = ? AND status = 'queued' 
         GROUP BY queue_id`,
        [project.id]
      );

      const qLoadMap = new Map();
      queues.forEach((q) => qLoadMap.set(q.id, 0));
      queueCounts.forEach((row) => qLoadMap.set(row.queue_id, row.count));

      // Overloaded queue has > 10 jobs, idle queue has 0 jobs
      const busyQueues = queues.filter((q) => (qLoadMap.get(q.id) || 0) > 10);
      const idleQueues = queues.filter((q) => (qLoadMap.get(q.id) || 0) === 0);

      for (const busyQ of busyQueues) {
        if (idleQueues.length === 0) break;

        const idleQ = idleQueues.shift();
        const busyLoad = qLoadMap.get(busyQ.id) || 0;
        const snatchCount = Math.min(Math.floor(busyLoad / 3), 25); // Snatch up to 25 jobs into idle queue lane

        if (snatchCount > 0) {
          const idleShards = await all(
            'SELECT id, shard_index FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
            [idleQ.id]
          );
          const targetShard = idleShards && idleShards.length > 0 ? idleShards[0] : { id: null, shard_index: 0 };

          const candidateJobs = await all(
            `SELECT id FROM jobs 
             WHERE queue_id = ? AND status = 'queued' 
             ORDER BY priority ASC, created_at DESC 
             LIMIT ?`,
            [busyQ.id, snatchCount]
          );

          if (candidateJobs && candidateJobs.length > 0) {
            const jobIds = candidateJobs.map((j) => j.id);
            const placeholders = jobIds.map(() => '?').join(',');
            const nowIso = new Date().toISOString();

            await run(
              `UPDATE jobs 
               SET queue_id = ?, shard_id = ?, shard_index = ?, updated_at = ? 
               WHERE id IN (${placeholders}) AND status = 'queued'`,
              [idleQ.id, targetShard.id, targetShard.shard_index, nowIso, ...jobIds]
            );

            this.stats.totalJobsSnatched += jobIds.length;
            this.stats.crossQueueSnatches += jobIds.length;

            const event = {
              type: 'CROSS_QUEUE_JOB_SNATCH',
              projectId: project.id,
              fromQueue: busyQ.name,
              toQueue: idleQ.name,
              targetShard: targetShard.shard_index,
              jobsCount: jobIds.length,
              timestamp: nowIso
            };

            this._recordEvent(event);
            console.log(`[QUEUE_SHARD_SNATCHER] ⚡ Idle Queue [${idleQ.name}] snatched ${jobIds.length} job(s) from overloaded Queue [${busyQ.name}]`);

            try {
              await QueueManager.publishEvent('QUEUE_SHARD_SNATCH_EVENT', event);
            } catch (_) {}
          }
        }
      }
    }
  }

  static _recordEvent(event) {
    this.stats.recentEvents.unshift(event);
    if (this.stats.recentEvents.length > 50) {
      this.stats.recentEvents.pop();
    }
  }

  static getTelemetry() {
    return {
      ...this.stats,
      isActive: true,
      mode: 'AUTONOMOUS_QUEUE_SHARD_WORK_STEALING'
    };
  }
}

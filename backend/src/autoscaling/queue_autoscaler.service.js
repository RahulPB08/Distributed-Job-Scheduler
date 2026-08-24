import { run, get, all } from '../database/db.js';
import { QueueManager, QueueKeys } from '../redis/queue_manager.js';
import { getRedisClient } from '../redis/redis_client.js';

/**
 * QueueAutoScalerService (Queue Shard Auto-Scaler)
 *
 * Design Principles:
 * ─────────────────────────────────────────
 * 1. Each service queue starts with exactly 2 shards (shard_0, shard_1).
 * 2. System solely manages queues and shards (no user manual control).
 * 3. Scale-Up: When backlog per shard exceeds capacity threshold, automatically
 *    provisions additional shards (up to max_shards).
 * 4. Scale-Down: After a cooldown period of sustained idle/zero backlog, gracefully
 *    drains and removes surplus shards back down to baseline 2 shards.
 * 5. Comprehensive terminal output with checkpoints and real-time WebSocket events.
 */
export class QueueAutoScalerService {
  static timer = null;
  static isRunning = false;

  // Per-queue idle tracking: queueId -> epoch ms when queue became idle
  static queueIdleTimestamps = new Map();

  // Per-queue scale-up cooldown: queueId -> epoch ms of last scale-up
  static lastScaleUpAt = new Map();

  // Per-queue scale-down cooldown: queueId -> epoch ms of last scale-down
  static lastScaleDownAt = new Map();

  // Cooldown durations
  static SCALE_DOWN_IDLE_MS = 20_000;    // 20s of sustained idle to scale down a shard
  static SCALE_UP_COOLDOWN_MS = 5_000;   // 5s reaction between consecutive scale-up events
  static JOBS_PER_SHARD_THRESHOLD = 15;  // Scale up when pending backlog per shard > 15 jobs
  static MIN_SHARDS = 2;                 // Never scale below 2 baseline shards
  static MAX_SHARDS = 16;                // Upper bound for shard scaling

  // Rolling scale events log
  static scaleEvents = [];

  static start(intervalMs = 3000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.evaluateAllQueues().catch(err => {
        console.error('[QUEUE_AUTOSCALER] Evaluation error:', err.message);
      });
    }, intervalMs);
    console.log(`[QUEUE_AUTOSCALER] ⚡ Queue Shard Autoscaler active (Baseline: ${this.MIN_SHARDS} shards, Scale-Down Cooldown: ${this.SCALE_DOWN_IDLE_MS / 1000}s)`);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluates all active queues for shard scaling.
   */
  static async evaluateAllQueues() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const queues = await all('SELECT * FROM queues WHERE is_paused = 0');
      for (const queue of queues) {
        await this.evaluateQueue(queue);
      }
    } catch (err) {
      console.error('[QUEUE_AUTOSCALER] Error iterating queues:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Evaluates a single queue for shard scale-up or scale-down.
   */
  static async evaluateQueue(queue) {
    const queueId = queue.id;
    const minShards = Math.max(this.MIN_SHARDS, queue.min_shards || this.MIN_SHARDS);
    const maxShards = Math.max(minShards, queue.max_shards || this.MAX_SHARDS);
    const jobsPerShardThreshold = queue.jobs_per_shard || this.JOBS_PER_SHARD_THRESHOLD;

    // Fetch existing active shards
    let existingShards = await all(
      'SELECT * FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
      [queueId]
    );

    // If fewer than minShards exist, initialize them immediately
    if (existingShards.length < minShards) {
      const now = new Date().toISOString();
      for (let i = existingShards.length; i < minShards; i++) {
        const shardId = `qs_${queueId.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        await run(
          'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, queueId, i, now, now]
        );
      }
      existingShards = await all(
        'SELECT * FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
        [queueId]
      );
    }

    const currentShardCount = existingShards.length;

    // Live backlog count in DB
    const pendingRes = await get(
      "SELECT COUNT(*) as total FROM jobs WHERE queue_id = ? AND status = 'queued'",
      [queueId]
    );
    const runningRes = await get(
      "SELECT COUNT(*) as total FROM jobs WHERE queue_id = ? AND status IN ('running', 'claimed')",
      [queueId]
    );

    const pendingJobs = pendingRes?.total || 0;
    const runningJobs = runningRes?.total || 0;
    const now = Date.now();
    const nowIso = new Date().toISOString();

    // ── 1. Scale-Up Evaluation ────────────────────────────────────────────────
    const desiredShards = Math.max(
      minShards,
      Math.min(maxShards, Math.ceil(pendingJobs / jobsPerShardThreshold) || minShards)
    );

    const lastScaleUp = this.lastScaleUpAt.get(queueId) || 0;
    const canScaleUp = (now - lastScaleUp) >= this.SCALE_UP_COOLDOWN_MS;

    if (desiredShards > currentShardCount && canScaleUp && currentShardCount < maxShards) {
      const shardsToAdd = Math.min(desiredShards - currentShardCount, 4); // Fast multi-shard burst scaling (+4 shards per cycle)
      const nowIso = new Date().toISOString();

      for (let s = 0; s < shardsToAdd; s++) {
        const targetShardIndex = currentShardCount + s;
        const shardId = `qs_${queueId.slice(0, 8)}_${targetShardIndex}_${Math.random().toString(36).slice(2, 8)}`;

        await run(
          'INSERT OR REPLACE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, queueId, targetShardIndex, nowIso, nowIso]
        );
      }

      const newShardCount = currentShardCount + shardsToAdd;
      await run('UPDATE queues SET shard_count = ?, updated_at = ? WHERE id = ?', [newShardCount, nowIso, queueId]);

      this.lastScaleUpAt.set(queueId, now);
      this.queueIdleTimestamps.delete(queueId);

      const logMsg = `[QUEUE_AUTOSCALER] 📈 Scaled UP queue [${queue.name}] shards: ${currentShardCount} -> ${newShardCount} (Pending: ${pendingJobs} jobs, Target: ${desiredShards})`;
      console.log(`\x1b[36m${logMsg}\x1b[0m`);

      const scaleEvent = {
        type: 'QUEUE_SHARD_SCALE_UP',
        queueId,
        queueName: queue.name,
        previousShards: currentShardCount,
        newShards: newShardCount,
        addedShards: shardsToAdd,
        pendingJobs,
        runningJobs,
        timestamp: nowIso
      };
      this._recordScaleEvent(scaleEvent);

      try {
        await QueueManager.publishEvent('QUEUE_SHARD_SCALE_EVENT', scaleEvent);
      } catch (_) {}

      return;
    }

    // ── 2. Scale-Down Evaluation ──────────────────────────────────────────────
    if (pendingJobs === 0 && runningJobs === 0) {
      if (!this.queueIdleTimestamps.has(queueId)) {
        this.queueIdleTimestamps.set(queueId, now);
      }

      const idleSince = this.queueIdleTimestamps.get(queueId);
      const idleDurationMs = now - idleSince;
      const lastScaleDown = this.lastScaleDownAt.get(queueId) || 0;
      const canScaleDown = (now - lastScaleDown) >= this.SCALE_DOWN_IDLE_MS;

      if (currentShardCount > minShards && idleDurationMs >= this.SCALE_DOWN_IDLE_MS && canScaleDown) {
        // Remove the highest index shard
        const highestShard = existingShards[existingShards.length - 1];

        // Check if this specific shard has no running jobs
        const shardRunning = await get(
          "SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND shard_index = ? AND status IN ('running', 'claimed')",
          [queueId, highestShard.shard_index]
        );

        if (!shardRunning || shardRunning.count === 0) {
          await run('DELETE FROM queue_shards WHERE id = ?', [highestShard.id]);

          const newShardCount = currentShardCount - 1;
          await run('UPDATE queues SET shard_count = ?, updated_at = ? WHERE id = ?', [newShardCount, nowIso, queueId]);

          this.lastScaleDownAt.set(queueId, now);
          this.queueIdleTimestamps.set(queueId, now); // Reset idle timer for next shard

          const logMsg = `[QUEUE_AUTOSCALER] 📉 Scaled DOWN queue [${queue.name}] shards: ${currentShardCount} -> ${newShardCount} (Idle: ${Math.round(idleDurationMs / 1000)}s, Baseline: ${minShards})`;
          console.log(`\x1b[33m${logMsg}\x1b[0m`);

          const scaleEvent = {
            type: 'QUEUE_SHARD_SCALE_DOWN',
            queueId,
            queueName: queue.name,
            previousShards: currentShardCount,
            newShards: newShardCount,
            idleSeconds: Math.round(idleDurationMs / 1000),
            timestamp: nowIso
          };
          this._recordScaleEvent(scaleEvent);

          try {
            await QueueManager.publishEvent('QUEUE_SHARD_SCALE_EVENT', scaleEvent);
          } catch (_) {}
        }
      }
    } else {
      // Workload active; reset idle timer
      this.queueIdleTimestamps.delete(queueId);
    }
  }

  static _recordScaleEvent(event) {
    this.scaleEvents.push(event);
    if (this.scaleEvents.length > 30) {
      this.scaleEvents.shift();
    }
  }

  /**
   * Returns current queue autoscaling telemetry.
   */
  static async getTelemetry() {
    const queues = await all('SELECT id, name, shard_count, min_shards, max_shards FROM queues WHERE is_paused = 0');
    const shards = await all('SELECT * FROM queue_shards ORDER BY logical_queue_id, shard_index');

    return {
      baselineMinShards: this.MIN_SHARDS,
      scaleDownIdleSec: this.SCALE_DOWN_IDLE_MS / 1000,
      scaleUpCooldownSec: this.SCALE_UP_COOLDOWN_MS / 1000,
      jobsPerShardThreshold: this.JOBS_PER_SHARD_THRESHOLD,
      totalActiveQueues: queues.length,
      totalActiveShards: shards.length,
      recentScaleEvents: this.scaleEvents,
      queueDetails: queues.map(q => ({
        id: q.id,
        name: q.name,
        currentShards: q.shard_count || this.MIN_SHARDS,
        minShards: q.min_shards || this.MIN_SHARDS,
        maxShards: q.max_shards || this.MAX_SHARDS,
        shards: shards.filter(s => s.logical_queue_id === q.id)
      }))
    };
  }

  /**
   * Directly sets the shard count for a queue (used by APIs or manual tests).
   */
  static async scaleQueueShards(queueId, targetShards, reason = 'manual') {
    const target = Math.max(1, parseInt(targetShards, 10));
    const existing = await all(
      'SELECT * FROM queue_shards WHERE logical_queue_id = ? ORDER BY shard_index ASC',
      [queueId]
    );
    const now = new Date().toISOString();

    if (target > existing.length) {
      for (let i = existing.length; i < target; i++) {
        const shardId = `qs_${queueId.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        await run(
          'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, queueId, i, now, now]
        );
      }
    } else if (target < existing.length) {
      for (let i = target; i < existing.length; i++) {
        await run('DELETE FROM queue_shards WHERE id = ?', [existing[i].id]);
      }
    }

    await run('UPDATE queues SET shard_count = ?, updated_at = ? WHERE id = ?', [target, now, queueId]);
  }
}

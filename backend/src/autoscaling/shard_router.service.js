import { run, get, all } from '../database/db.js';
import { createHash } from 'crypto';

/**
 * ShardRouterService
 *
 * Directs newly enqueued jobs to the optimal shard of a logical queue.
 * Supports:
 *  - least_loaded (default): routes to the active shard with lowest pending job count
 *  - affinity: consistent-hash routing based on idempotencyKey or partitionKey
 *  - round_robin: distributes evenly across active shards
 */
export class ShardRouterService {
  static roundRobinCounters = new Map();

  /**
   * Selects an active shard for a given logical queue.
   * @param {string} logicalQueueId
   * @param {Object} options { strategy: 'least_loaded'|'affinity'|'round_robin', affinityKey: string }
   * @returns {Promise<Object>} The selected shard record from queue_shards
   */
  static async routeJob(logicalQueueId, options = {}) {
    const strategy = options.strategy || 'least_loaded';
    const affinityKey = options.affinityKey || null;

    // Fetch active shards for this logical queue
    let shards = await all(
      'SELECT * FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
      [logicalQueueId]
    );

    // Fallback: If no shards exist yet, ensure initial 2 baseline shards are created
    if (!shards || shards.length === 0) {
      const now = new Date().toISOString();
      const initialCount = 2; // Baseline 2 shards per service queue
      for (let i = 0; i < initialCount; i++) {
        const shardId = `qs_${logicalQueueId.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        await run(
          'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, logicalQueueId, i, now, now]
        );
      }
      shards = await all(
        'SELECT * FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
        [logicalQueueId]
      );
    }

    if (!shards || shards.length === 0) {
      return { id: null, shard_index: 0, logical_queue_id: logicalQueueId };
    }

    // 1. Consistent Affinity Routing
    if (strategy === 'affinity' && affinityKey) {
      const hash = createHash('md5').update(String(affinityKey)).digest('hex');
      const numericHash = parseInt(hash.slice(0, 8), 16);
      const shardIndex = numericHash % shards.length;
      return shards[shardIndex];
    }

    // 2. Round-Robin Routing
    if (strategy === 'round_robin') {
      const current = this.roundRobinCounters.get(logicalQueueId) || 0;
      const selected = shards[current % shards.length];
      this.roundRobinCounters.set(logicalQueueId, current + 1);
      return selected;
    }

    // 3. Least-Loaded Routing (Default for optimal throughput)
    // Query live pending count in jobs table for absolute accuracy
    const shardStats = await all(
      `SELECT shard_index, COUNT(*) as count 
       FROM jobs 
       WHERE queue_id = ? AND status = 'queued' 
       GROUP BY shard_index`,
      [logicalQueueId]
    );

    const countsMap = new Map();
    for (const stat of shardStats) {
      countsMap.set(stat.shard_index, stat.count);
    }

    let minShard = shards[0];
    let minLoad = countsMap.get(minShard.shard_index) || 0;

    for (let i = 1; i < shards.length; i++) {
      const shard = shards[i];
      const load = countsMap.get(shard.shard_index) || 0;
      if (load < minLoad) {
        minLoad = load;
        minShard = shard;
      }
    }

    return minShard;
  }

  /**
   * Returns all active shards for a logical queue.
   */
  static async getActiveShards(logicalQueueId) {
    return all(
      'SELECT * FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
      [logicalQueueId]
    );
  }
}

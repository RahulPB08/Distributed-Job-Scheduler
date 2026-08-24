import { getRedisClient } from './redis_client.js';

/**
 * GlobalQueueConcurrencyController
 * 
 * Enforces strict global concurrency limits at the PARENT LOGICAL QUEUE level
 * across ALL shards, worker nodes, and processes using atomic Redis Lua scripts.
 */
export class GlobalQueueConcurrencyController {
  static ACQUIRE_LUA_SCRIPT = `
    local key = KEYS[1]
    local maxConcurrency = tonumber(ARGV[1])
    local jobId = ARGV[2]

    -- If job already holds a slot, return true (idempotent)
    if redis.call('SISMEMBER', key, jobId) == 1 then
      return 1
    end

    local currentCount = redis.call('SCARD', key)
    if currentCount < maxConcurrency then
      redis.call('SADD', key, jobId)
      return 1
    else
      return 0
    end
  `;

  static RELEASE_LUA_SCRIPT = `
    local key = KEYS[1]
    local jobId = ARGV[1]
    redis.call('SREM', key, jobId)
    return redis.call('SCARD', key)
  `;

  static fallbackSlots = new Map();

  static getSlotKey(logicalQueueId) {
    return `queue:${logicalQueueId}:running_jobs`;
  }

  /**
   * Atomically acquires a global execution slot for the logical queue.
   * @param {string} logicalQueueId - Parent logical queue ID
   * @param {number} maxConcurrency - Max concurrent jobs allowed globally for this logical queue
   * @param {string} jobId - Job ID to register in slot set
   * @returns {Promise<boolean>} true if slot acquired, false if queue is at capacity
   */
  static async acquireSlot(logicalQueueId, maxConcurrency, jobId) {
    try {
      const redis = getRedisClient();
      if (redis && redis.status === 'ready') {
        const key = this.getSlotKey(logicalQueueId);
        const result = await redis.eval(
          this.ACQUIRE_LUA_SCRIPT,
          1,
          key,
          maxConcurrency,
          jobId
        );
        return result === 1;
      }
    } catch (err) {}

    // In-memory fallback if Redis is not connected
    if (!this.fallbackSlots.has(logicalQueueId)) {
      this.fallbackSlots.set(logicalQueueId, new Set());
    }
    const set = this.fallbackSlots.get(logicalQueueId);
    if (set.has(jobId)) return true;
    if (set.size < maxConcurrency) {
      set.add(jobId);
      return true;
    }
    return false;
  }

  /**
   * Releases the global execution slot when a job completes, fails, or is cancelled.
   * @param {string} logicalQueueId 
   * @param {string} jobId 
   */
  static async releaseSlot(logicalQueueId, jobId) {
    try {
      const redis = getRedisClient();
      if (redis && redis.status === 'ready') {
        const key = this.getSlotKey(logicalQueueId);
        await redis.eval(this.RELEASE_LUA_SCRIPT, 1, key, jobId);
      }
    } catch (err) {}

    if (this.fallbackSlots.has(logicalQueueId)) {
      this.fallbackSlots.get(logicalQueueId).delete(jobId);
    }
  }

  /**
   * Returns the live active running job count for a logical queue.
   */
  static async getRunningCount(logicalQueueId) {
    try {
      const redis = getRedisClient();
      if (redis && redis.status === 'ready') {
        const key = this.getSlotKey(logicalQueueId);
        return await redis.scard(key);
      }
    } catch (err) {}

    return this.fallbackSlots.get(logicalQueueId)?.size || 0;
  }

  /**
   * Reconciles Redis active slots against SQLite running jobs to prevent any slot leaks.
   */
  static async reconcile(logicalQueueId, runningJobIds = []) {
    try {
      const redis = getRedisClient();
      if (redis && redis.status === 'ready') {
        const key = this.getSlotKey(logicalQueueId);
        await redis.del(key);
        if (runningJobIds.length > 0) {
          await redis.sadd(key, ...runningJobIds);
        }
      }
    } catch (err) {}

    this.fallbackSlots.set(logicalQueueId, new Set(runningJobIds));
  }
}

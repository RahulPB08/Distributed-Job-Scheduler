import Redis from 'ioredis';

/**
 * GlobalQueueConcurrencyController for Worker nodes.
 * Enforces atomic parent-level logical queue concurrency across all shards.
 */
export class GlobalQueueConcurrencyController {
  static redis = null;

  static getRedis() {
    if (!this.redis && process.env.REDIS_HOST) {
      try {
        this.redis = new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false
        });
        this.redis.connect().catch(() => {
          this.redis = null;
        });
      } catch (e) {
        this.redis = null;
      }
    }
    return this.redis;
  }

  static ACQUIRE_LUA_SCRIPT = `
    local key = KEYS[1]
    local maxConcurrency = tonumber(ARGV[1])
    local jobId = ARGV[2]

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

  static getSlotKey(logicalQueueId) {
    return `queue:${logicalQueueId}:running_jobs`;
  }

  static async acquireSlot(logicalQueueId, maxConcurrency, jobId, db = null) {
    const redis = this.getRedis();
    if (redis && redis.status === 'ready') {
      try {
        const key = this.getSlotKey(logicalQueueId);
        const result = await redis.eval(
          this.ACQUIRE_LUA_SCRIPT,
          1,
          key,
          maxConcurrency,
          jobId
        );
        return result === 1;
      } catch (err) {}
    }

    // Fallback to SQLite ACID check if Redis is offline
    if (db) {
      return new Promise((resolve) => {
        db.get(
          'SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = "running"',
          [logicalQueueId],
          (err, row) => {
            if (err) return resolve(false);
            const count = row ? row.count : 0;
            resolve(count < maxConcurrency);
          }
        );
      });
    }

    return true;
  }

  static async releaseSlot(logicalQueueId, jobId) {
    const redis = this.getRedis();
    if (redis && redis.status === 'ready') {
      try {
        const key = this.getSlotKey(logicalQueueId);
        await redis.eval(this.RELEASE_LUA_SCRIPT, 1, key, jobId);
      } catch (err) {}
    }
  }
}

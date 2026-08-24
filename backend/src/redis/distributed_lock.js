import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from './redis_client.js';
import { run, get, all } from '../database/db.js';

// Lua script for atomic safe lock release (releases only if token matches)
const RELEASE_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`;

export class DistributedLock {
  constructor(resource, options = {}) {
    if (!resource) throw new Error('Resource name is required for DistributedLock');
    this.resource = resource;
    this.key = `lock:djs:${resource}`;
    this.ttlMs = options.ttlMs || 5000;
    this.token = options.token || `token_${uuidv4().replace(/-/g, '')}`;
    this.isAcquired = false;
  }

  /**
   * Attempts to acquire the distributed lock with optional retries
   */
  async acquire(ttlMs = this.ttlMs, retryCount = 0, retryDelayMs = 100) {
    this.ttlMs = ttlMs;
    let attempts = 0;

    while (attempts <= retryCount) {
      const acquired = await this._tryAcquire(this.ttlMs);
      if (acquired) {
        this.isAcquired = true;
        return true;
      }

      attempts++;
      if (attempts <= retryCount) {
        await new Promise((res) => setTimeout(res, retryDelayMs));
      }
    }

    this.isAcquired = false;
    return false;
  }

  /**
   * Internal acquisition logic (Redis primary, SQLite fallback)
   */
  async _tryAcquire(ttlMs) {
    // 1. Try Redis acquisition
    try {
      const redis = getRedisClient();
      const result = await redis.set(this.key, this.token, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        return true;
      }
      return false;
    } catch (redisErr) {
      // 2. Fallback to SQLite system_locks table
      try {
        const now = new Date();
        const nowIso = now.toISOString();
        const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

        // Prune expired locks
        await run('DELETE FROM system_locks WHERE resource = ? AND expires_at <= ?', [this.resource, nowIso]);

        // Attempt insert
        await run(
          'INSERT INTO system_locks (resource, owner_token, expires_at, created_at) VALUES (?, ?, ?, ?)',
          [this.resource, this.token, expiresAt, nowIso]
        );
        return true;
      } catch (dbErr) {
        return false;
      }
    }
  }

  /**
   * Atomically releases the distributed lock if the token matches
   */
  async release() {
    if (!this.isAcquired) return false;

    let released = false;

    // 1. Try Redis Lua atomic release
    try {
      const redis = getRedisClient();
      const result = await redis.eval(RELEASE_LUA_SCRIPT, 1, this.key, this.token);
      released = Number(result) === 1;
    } catch (redisErr) {
      released = false;
    }

    // 2. If not released via Redis, check/clean SQLite fallback
    if (!released) {
      try {
        const res = await run(
          'DELETE FROM system_locks WHERE resource = ? AND owner_token = ?',
          [this.resource, this.token]
        );
        if (res && res.changes > 0) {
          released = true;
        }
      } catch (dbErr) {
        // ignore
      }
    }

    this.isAcquired = false;
    return released;
  }

  /**
   * Extends lock expiration
   */
  async extend(additionalTtlMs = 5000) {
    if (!this.isAcquired) return false;

    try {
      const redis = getRedisClient();
      const current = await redis.get(this.key);
      if (current === this.token) {
        await redis.pexpire(this.key, additionalTtlMs);
        return true;
      }
      return false;
    } catch (e) {
      try {
        const newExpire = new Date(Date.now() + additionalTtlMs).toISOString();
        const res = await run(
          'UPDATE system_locks SET expires_at = ? WHERE resource = ? AND owner_token = ?',
          [newExpire, this.resource, this.token]
        );
        return res.changes > 0;
      } catch (dbErr) {
        return false;
      }
    }
  }

  /**
   * Context wrapper executing a callback within an acquired lock
   */
  static async withLock(resource, ttlMs, callback, options = {}) {
    const lock = new DistributedLock(resource, { ttlMs, ...options });
    const acquired = await lock.acquire(ttlMs, options.retryCount || 0, options.retryDelayMs || 100);
    if (!acquired) {
      if (options.throwOnFail) {
        throw new Error(`Failed to acquire distributed lock for resource [${resource}]`);
      }
      return null;
    }

    try {
      return await callback(lock);
    } finally {
      await lock.release().catch(() => {});
    }
  }

  /**
   * Checks if a resource is currently locked
   */
  static async isLocked(resource) {
    const key = `lock:djs:${resource}`;
    try {
      const redis = getRedisClient();
      const val = await redis.get(key);
      if (val !== null && val !== undefined) return true;
    } catch (e) {}

    try {
      const nowIso = new Date().toISOString();
      const row = await get(
        'SELECT resource FROM system_locks WHERE resource = ? AND expires_at > ?',
        [resource, nowIso]
      );
      return !!row;
    } catch (e) {
      return false;
    }
  }

  /**
   * Lists all currently active distributed locks (for telemetry & monitoring)
   */
  static async listActiveLocks() {
    const activeLocks = [];

    // Check Redis keys
    try {
      const redis = getRedisClient();
      const keys = await redis.keys('lock:djs:*');
      for (const k of keys) {
        const resource = k.replace('lock:djs:', '');
        const token = await redis.get(k);
        let ttlMs = await redis.pttl(k);
        if (ttlMs < 0) ttlMs = 0;
        activeLocks.push({
          resource,
          key: k,
          token: token ? `${token.slice(0, 12)}...` : 'locked',
          ttlRemainingMs: ttlMs,
          source: 'Redis RESP Broker',
          status: 'ACTIVE'
        });
      }
    } catch (e) {}

    // Check SQLite system_locks
    try {
      const nowIso = new Date().toISOString();
      const rows = await all(
        'SELECT * FROM system_locks WHERE expires_at > ?',
        [nowIso]
      );
      for (const r of rows) {
        if (!activeLocks.find((l) => l.resource === r.resource)) {
          const remainingMs = Math.max(0, new Date(r.expires_at).getTime() - Date.now());
          activeLocks.push({
            resource: r.resource,
            key: `lock:djs:${r.resource}`,
            token: `${r.owner_token.slice(0, 12)}...`,
            ttlRemainingMs: remainingMs,
            source: 'SQLite Core Storage',
            status: 'ACTIVE'
          });
        }
      }
    } catch (e) {}

    return activeLocks;
  }
}

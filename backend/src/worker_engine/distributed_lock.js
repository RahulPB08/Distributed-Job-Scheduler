import { v4 as uuidv4 } from 'uuid';

export class DistributedLock {
  constructor(resource, options = {}) {
    if (!resource) throw new Error('Resource name is required for DistributedLock');
    this.resource = resource;
    this.key = `lock:djs:${resource}`;
    this.ttlMs = options.ttlMs || 5000;
    this.token = options.token || `worker_token_${uuidv4().replace(/-/g, '')}`;
    this.db = options.db || null;
    this.isAcquired = false;
  }

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

  async _tryAcquire(ttlMs) {
    if (!this.db) return false;
    return new Promise((resolve) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

      this.db.run(
        'DELETE FROM system_locks WHERE resource = ? AND expires_at <= ?',
        [this.resource, nowIso],
        () => {
          this.db.run(
            'INSERT INTO system_locks (resource, owner_token, expires_at, created_at) VALUES (?, ?, ?, ?)',
            [this.resource, this.token, expiresAt, nowIso],
            (err) => {
              if (err) return resolve(false);
              resolve(true);
            }
          );
        }
      );
    });
  }

  async release() {
    if (!this.isAcquired || !this.db) return false;
    return new Promise((resolve) => {
      this.db.run(
        'DELETE FROM system_locks WHERE resource = ? AND owner_token = ?',
        [this.resource, this.token],
        function () {
          resolve(this.changes > 0);
        }
      );
    });
  }

  static async withLock(db, resource, ttlMs, callback, options = {}) {
    const lock = new DistributedLock(resource, { db, ttlMs, ...options });
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
}

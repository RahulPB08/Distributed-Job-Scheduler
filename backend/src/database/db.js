import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENV } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(ENV.DB_PATH);
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = sqlite3.verbose();
export const db = new sqlite.Database(dbPath);

// Configure SQLite pragmas for high concurrency & reliability
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA busy_timeout = 15000;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA cache_size = -64000;'); // 64MB cache
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async (fn, maxRetries = 15) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if ((err?.code === 'SQLITE_BUSY' || err?.message?.includes('database is locked') || err?.message?.includes('SQLITE_BUSY')) && attempt < maxRetries) {
        await sleep(15 * attempt + Math.floor(Math.random() * 20));
        continue;
      }
      throw err;
    }
  }
};

export const run = (sql, params = []) => {
  return withRetry(() => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  });
};

export const get = (sql, params = []) => {
  return withRetry(() => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  });
};

export const all = (sql, params = []) => {
  return withRetry(() => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  });
};

export const exec = (sql) => {
  return withRetry(() => {
    return new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
};

export const transaction = async (callback) => {
  return withRetry(async () => {
    await run('BEGIN IMMEDIATE;');
    try {
      const result = await callback();
      await run('COMMIT;');
      return result;
    } catch (err) {
      try {
        await run('ROLLBACK;');
      } catch (rbErr) {}
      throw err;
    }
  });
};

export const resetDb = async () => {
  await exec('PRAGMA foreign_keys = OFF;');
  const tables = [
    'event_triggers', 'system_locks', 'system_events', 'workflow_dependencies', 'dead_letter_queue', 'worker_heartbeats', 'workers',
    'scheduled_jobs', 'job_logs', 'job_executions', 'jobs', 'batches', 'queues',
    'retry_policies', 'projects', 'organization_members', 'organizations', 'users'
  ];
  for (const table of tables) {
    try {
      await exec(`DROP TABLE IF EXISTS ${table};`);
    } catch (e) {}
  }
  await exec('PRAGMA foreign_keys = ON;');
  await initDb();
};

export const initDb = async () => {
  await exec('PRAGMA journal_mode = WAL;');
  await exec('PRAGMA busy_timeout = 15000;');
  await exec('PRAGMA foreign_keys = ON;');
  
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const stmts = schemaSql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of stmts) {
    try {
      await exec(stmt);
    } catch (e) {}
  }

  // Schema migrations for dynamic queue sharding
  try {
    const queueCols = await all('PRAGMA table_info(queues)');
    const qColNames = queueCols.map((c) => c.name);
    if (!qColNames.includes('shard_id')) {
      await exec('ALTER TABLE queues ADD COLUMN shard_id INTEGER NOT NULL DEFAULT 0;');
    }
    if (!qColNames.includes('min_shards')) {
      await exec('ALTER TABLE queues ADD COLUMN min_shards INTEGER NOT NULL DEFAULT 4;');
    }
    if (!qColNames.includes('max_shards')) {
      await exec('ALTER TABLE queues ADD COLUMN max_shards INTEGER NOT NULL DEFAULT 16;');
    }
    if (!qColNames.includes('jobs_per_shard')) {
      await exec('ALTER TABLE queues ADD COLUMN jobs_per_shard INTEGER NOT NULL DEFAULT 500;');
    }
    if (!qColNames.includes('shard_count')) {
      await exec('ALTER TABLE queues ADD COLUMN shard_count INTEGER NOT NULL DEFAULT 4;');
    }

    const jobCols = await all('PRAGMA table_info(jobs)');
    const jColNames = jobCols.map((c) => c.name);
    if (!jColNames.includes('shard_id')) {
      await exec('ALTER TABLE jobs ADD COLUMN shard_id TEXT REFERENCES queue_shards(id) ON DELETE SET NULL;');
    }
    if (!jColNames.includes('shard_index')) {
      await exec('ALTER TABLE jobs ADD COLUMN shard_index INTEGER NOT NULL DEFAULT 0;');
    }
    if (!jColNames.includes('scheduler_id')) {
      await exec('ALTER TABLE jobs ADD COLUMN scheduler_id TEXT DEFAULT "scheduler-leader-01";');
    }

    // Ensure queue_shards table exists
    await exec(`
      CREATE TABLE IF NOT EXISTS queue_shards (
        id TEXT PRIMARY KEY,
        logical_queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
        shard_index INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'draining', 'disabled')),
        pending_job_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(logical_queue_id, shard_index)
      );
      CREATE INDEX IF NOT EXISTS idx_queue_shards_logical ON queue_shards(logical_queue_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_queue_shard ON jobs(queue_id, shard_index, status);
    `);

    // Ensure every existing queue has its initial shards in queue_shards
    const existingQueues = await all('SELECT id, max_concurrency, min_shards, shard_count FROM queues');
    const now = new Date().toISOString();
    for (const q of existingQueues) {
      const initialCount = Math.max(1, q.min_shards || q.shard_count || q.max_concurrency || 4);
      for (let i = 0; i < initialCount; i++) {
        const shardId = `qs_${q.id.slice(0, 8)}_${i}`;
        await run(
          'INSERT OR IGNORE INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, q.id, i, now, now]
        );
      }
      await run('UPDATE queues SET shard_count = ? WHERE id = ?', [initialCount, q.id]);
    }
  } catch (e) {
    console.error('Migration error in initDb:', e.message);
  }

};

export const closeDb = () => {
  return new Promise((resolve) => {
    db.close(() => resolve());
  });
};

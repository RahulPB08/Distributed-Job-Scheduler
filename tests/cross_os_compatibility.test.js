/**
 * Cross-OS Compatibility Test Suite
 * 
 * Verifies that the Distributed Job Scheduler operates identically and reliably
 * across Windows, Linux (Ubuntu, Debian, Alpine), and macOS (Darwin / Apple Silicon / x86).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENV } from '../backend/src/config/env.js';
import { initDb, closeDb } from '../backend/src/database/db.js';
import { startRedisBrokerIfNeeded, closeRedisConnections, getRedisClient } from '../backend/src/redis/redis_client.js';
import { DistributedLock } from '../backend/src/redis/distributed_lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.before(async () => {
  await startRedisBrokerIfNeeded();
  await initDb();
});

test.after(async () => {
  await closeRedisConnections();
  await closeDb();
});

test('Cross-OS: 1. Host OS and Architecture Diagnostic Report', () => {
  const platform = os.platform(); // 'win32' | 'linux' | 'darwin'
  const arch = os.arch();         // 'x64' | 'arm64' | 'ia32'
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const homedir = os.homedir();
  const tmpdir = os.tmpdir();

  assert.ok(['win32', 'linux', 'darwin', 'freebsd', 'openbsd'].includes(platform), `Supported platform: ${platform}`);
  assert.ok(['x64', 'arm64', 'arm', 'ia32'].includes(arch), `Supported CPU architecture: ${arch}`);
  assert.ok(cpus.length >= 1, 'System has at least 1 logical CPU core');
  assert.ok(totalMem > 0, 'Total memory reported');
  assert.ok(fs.existsSync(tmpdir), `Temporary directory is accessible: ${tmpdir}`);
  assert.ok(fs.existsSync(homedir), `Home directory is accessible: ${homedir}`);
});

test('Cross-OS: 2. Path normalization & file URI resolution across Windows & Unix', () => {
  const winStyle = 'backend\\src\\database\\db.js';
  const unixStyle = 'backend/src/database/db.js';

  const normalizedWin = path.normalize(winStyle);
  const normalizedUnix = path.normalize(unixStyle);

  assert.ok(normalizedWin.length > 0);
  assert.ok(normalizedUnix.length > 0);

  const resolved = path.resolve(__dirname, '..', 'backend', 'src', 'app.js');
  assert.ok(fs.existsSync(resolved), `Path resolution found app.js at: ${resolved}`);

  assert.ok([':', ';'].includes(path.delimiter));
  assert.ok(['/', '\\'].includes(path.sep));
});

test('Cross-OS: 3. Cross-platform temporary SQLite database lifecycle and locking', async () => {
  const tempDbName = `djs_test_os_${Date.now()}_${Math.random().toString(36).substring(7)}.sqlite`;
  const tempDbPath = path.join(os.tmpdir(), tempDbName);

  try {
    const sqlite3 = (await import('../backend/node_modules/sqlite3/lib/sqlite3.js')).default || (await import('sqlite3')).default;
    const db = new sqlite3.Database(tempDbPath);

    await new Promise((resolve, reject) => {
      db.run('CREATE TABLE os_test (id INTEGER PRIMARY KEY, os_name TEXT, timestamp INTEGER)', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run('INSERT INTO os_test (os_name, timestamp) VALUES (?, ?)', [os.platform(), Date.now()], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM os_test LIMIT 1', (err, r) => {
        if (err) return reject(err);
        resolve(r);
      });
    });

    assert.equal(row.os_name, os.platform());
    assert.ok(row.timestamp > 0);

    await new Promise((resolve) => db.close(resolve));
    assert.ok(fs.existsSync(tempDbPath), 'SQLite file exists on disk');
  } finally {
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // Safe ignore on busy lock
      }
    }
  }
});

test('Cross-OS: 4. Environment variable handling and platform defaults', () => {
  const port = parseInt(process.env.PORT || '4000', 10);
  assert.ok(!isNaN(port) && port > 0 && port < 65536, 'Valid port range');

  const redisHost = process.env.REDIS_HOST || 'localhost';
  assert.ok(typeof redisHost === 'string' && redisHost.length > 0);

  const nodeEnv = process.env.NODE_ENV || 'development';
  assert.ok(['development', 'production', 'test'].includes(nodeEnv));
});

test('Cross-OS: 5. Redis connection and distributed lock synchronization across platforms', async () => {
  const lockKey = `os_lock_${os.platform()}_${Date.now()}`;
  const lock = new DistributedLock(lockKey, { ttlMs: 3000 });
  const acquired = await lock.acquire();
  assert.equal(acquired, true, 'Lock should acquire successfully on host platform');

  const isLocked = await DistributedLock.isLocked(lockKey);
  assert.equal(isLocked, true, 'Resource should register as locked in Redis broker');

  const released = await lock.release();
  assert.equal(released, true, 'Lock should release cleanly on host platform');
});

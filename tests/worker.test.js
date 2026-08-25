import test from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WorkerInstance } from '../worker/src/worker.js';
import { ConcurrencyController } from '../worker/src/concurrency.js';
import { RetryHandler } from '../worker/src/retry_handler.js';
import { DlqHandler } from '../worker/src/dlq_handler.js';
import { HttpExecutionService } from '../worker/src/services/http_execution_service.js';
import { CpuComputeService } from '../worker/src/services/cpu_compute_service.js';
import { NotificationExecutionService } from '../worker/src/services/notification_execution_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testDbPath = path.resolve(__dirname, 'worker_test.sqlite');

let db;

test.before(async () => {
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch (e) {}
  }

  const sqlite = sqlite3.verbose();
  db = new sqlite.Database(testDbPath);

  const schemaPath = path.resolve(__dirname, '../backend/src/database/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  await new Promise((resolve, reject) => {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000;' + schemaSql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  // Seed sample org, project, queue
  const now = new Date().toISOString();
  await new Promise((resolve) => {
    db.run(
      `INSERT INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at)
       VALUES ('u_test', 'test@djs.io', 'hash', 'Test User', 'admin', 'key_123', ?, ?)`,
      [now, now],
      () => resolve()
    );
  });

  await new Promise((resolve) => {
    db.run(
      `INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at)
       VALUES ('org_test', 'Test Org', 'test-org', 'u_test', ?, ?)`,
      [now, now],
      () => resolve()
    );
  });

  await new Promise((resolve) => {
    db.run(
      `INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at)
       VALUES ('proj_test', 'org_test', 'u_test', 'Test Project', 'test-proj', 'desc', ?, ?)`,
      [now, now],
      () => resolve()
    );
  });

  await new Promise((resolve) => {
    db.run(
      `INSERT INTO queues (id, project_id, name, description, priority, max_concurrency, is_paused, created_at, updated_at)
       VALUES ('q_worker_test', 'proj_test', 'worker-test-queue', 'desc', 10, 10, 0, ?, ?)`,
      [now, now],
      () => resolve()
    );
  });
});

test.after(async () => {
  if (db) {
    await new Promise((resolve) => db.close(resolve));
  }
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch (e) {}
  }
});

test('Worker: Concurrency Controller accurately manages capacity and active slots', () => {
  const controller = new ConcurrencyController(3);
  assert.equal(controller.canAcceptJob(), true);
  assert.equal(controller.getAvailableSlots(), 3);

  controller.acquireSlot('job_1');
  assert.equal(controller.getActiveCount(), 1);
  assert.equal(controller.getAvailableSlots(), 2);

  controller.acquireSlot('job_2');
  controller.acquireSlot('job_3');
  assert.equal(controller.canAcceptJob(), false);
  assert.equal(controller.getAvailableSlots(), 0);

  controller.releaseSlot('job_1');
  assert.equal(controller.canAcceptJob(), true);
  assert.equal(controller.getActiveCount(), 2);
});

test('Worker: RetryHandler calculates correct delays across backoff strategies', () => {
  const fixedDelay = RetryHandler.calculateDelay('fixed', 1, 5, 300);
  assert.equal(fixedDelay, 5);

  const linear1 = RetryHandler.calculateDelay('linear_backoff', 1, 5, 300);
  const linear2 = RetryHandler.calculateDelay('linear_backoff', 2, 5, 300);
  assert.equal(linear1, 5);
  assert.equal(linear2, 10);

  const exp1 = RetryHandler.calculateDelay('exponential_backoff', 1, 5, 300, 2.0);
  assert.ok(exp1 >= 5 && exp1 <= 10);
});

test('Worker: DlqHandler classifies error and creates AI Diagnostic Summary', async () => {
  const err = new Error('HTTP Request Failed with Status Code 404: Not Found');
  const summary = await DlqHandler.generateAIDiagnosticSummary(err, { job_type: 'http_request' });

  assert.equal(summary.category, 'ENDPOINT_NOT_FOUND');
  assert.ok(summary.confidence > 0.9);
  assert.ok(summary.remediation.includes('URL'));
});

test('Worker: CpuComputeService processes prime and hash calculations', async () => {
  const primeResult = await CpuComputeService.execute({ type: 'prime_sum', operations: 1000 }, 10);
  assert.equal(primeResult.computeType, 'prime_sum');
  assert.ok(primeResult.result.primesFound > 0);

  const hashResult = await CpuComputeService.execute({ type: 'hash_crunch', operations: 100 }, 10);
  assert.equal(hashResult.computeType, 'hash_crunch');
  assert.ok(hashResult.result.finalHash);
});

test('Worker: NotificationExecutionService dispatches mock notifications', async () => {
  const notifResult = await NotificationExecutionService.execute({
    to: 'dev@test.io',
    channel: 'email',
    subject: 'Alert'
  }, 10);
  assert.equal(notifResult.delivered, true);
  assert.equal(notifResult.recipient, 'dev@test.io');
});

test('Worker: Multi-Worker Concurrent Atomic Claim prevents duplicate execution', async () => {
  const now = new Date().toISOString();

  // Enqueue 5 jobs
  const jobIds = [];
  for (let i = 1; i <= 5; i++) {
    const jId = `job_atomic_${i}_${Date.now()}`;
    jobIds.push(jId);
    await new Promise((resolve) => {
      db.run(
        `INSERT INTO jobs (
          id, project_id, queue_id, name, job_type, status, priority, payload,
          timeout_seconds, scheduled_at, max_retries, retry_count, created_at, updated_at
        ) VALUES (?, 'proj_test', 'q_worker_test', ?, 'cpu_compute', 'queued', ?, '{"operations": 500}', 60, ?, 3, 0, ?, ?)`,
        [jId, `Atomic Task ${i}`, i * 10, now, now, now],
        () => resolve()
      );
    });
  }

  // Create 3 competing worker instances with 50ms polling loop
  const workerA = new WorkerInstance({ workerId: 'worker-A', concurrency: 5, pollInterval: 50, db });
  const workerB = new WorkerInstance({ workerId: 'worker-B', concurrency: 5, pollInterval: 50, db });
  const workerC = new WorkerInstance({ workerId: 'worker-C', concurrency: 5, pollInterval: 50, db });

  await workerA.start();
  await workerB.start();
  await workerC.start();

  // Wait for all 5 jobs to complete
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const pending = await new Promise((resolve) => {
      db.get("SELECT COUNT(*) as count FROM jobs WHERE status IN ('queued', 'claimed', 'running')", (err, row) => {
        resolve(row ? row.count : 0);
      });
    });
    if (pending === 0) break;
  }

  await workerA.shutdown();
  await workerB.shutdown();
  await workerC.shutdown();

  // Verify all 5 jobs are completed with exactly 1 execution each
  for (const jId of jobIds) {
    const jobRecord = await new Promise((resolve) => {
      db.get('SELECT * FROM jobs WHERE id = ?', [jId], (err, row) => resolve(row));
    });
    assert.equal(jobRecord.status, 'completed');

    const executions = await new Promise((resolve) => {
      db.all('SELECT * FROM job_executions WHERE job_id = ?', [jId], (err, rows) => resolve(rows || []));
    });
    assert.equal(executions.length, 1);
  }
});

test.after(async () => {
  if (db) {
    await new Promise((resolve) => db.close(resolve));
  }
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch (e) {}
  }
});

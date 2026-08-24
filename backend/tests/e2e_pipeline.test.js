import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from '../src/app.js';
import { resetDb, closeDb, get, all, db } from '../src/database/db.js';
import { seedDatabase } from '../src/database/seed.js';
import { startRedisBrokerIfNeeded, closeRedisConnections } from '../src/redis/redis_client.js';
import { WorkerInstance } from '../../worker/src/worker.js';
import { SchedulerEngine } from '../src/services/scheduler_engine.js';

let server;
let baseUrl;
let token;
let projectId;
let queueId;
let worker;
let scheduler;

test.before(async () => {
  await startRedisBrokerIfNeeded();
  await resetDb();
  await seedDatabase();

  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  scheduler = new SchedulerEngine({ pollIntervalMs: 50 });
  await scheduler.start();

  worker = new WorkerInstance({
    workerId: 'e2e-worker-instance',
    concurrency: 10,
    pollInterval: 50,
    db
  });
  await worker.start();
});

test.after(async () => {
  if (worker) await worker.shutdown();
  if (scheduler) scheduler.stop();
  if (server) {
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    server.close();
  }
});

test('E2E: Complete Pipeline Flow (API -> DB -> Scheduler Promotion -> Worker Claim & Execution -> DB Result)', async () => {
  // Login with seeded admin account
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@djs.io', password: 'AdminPassword123!' })
  });
  const loginData = await loginRes.json();
  assert.equal(loginRes.status, 200);
  assert.equal(loginData.success, true);
  token = loginData.data.token;

  const projRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      name: `E2E Pipeline Project ${Date.now()}`,
      slug: `e2e-proj-${Date.now()}`,
      description: 'End to end validation project'
    })
  });
  const projData = await projRes.json();
  assert.equal(projRes.status, 201);
  assert.equal(projData.success, true);
  projectId = projData.data.id;

  const queuesRes = await fetch(`${baseUrl}/api/queues?projectId=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const queuesData = await queuesRes.json();
  assert.ok(queuesData.data.length > 0);
  queueId = queuesData.data[0].id;

  // Create immediate CPU compute job
  const jobRes = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      projectId,
      queueId,
      name: 'E2E CPU Compute Job',
      jobType: 'cpu_compute',
      payload: { type: 'prime_sum', operations: 5000 },
      priority: 50
    })
  });
  const jobData = await jobRes.json();
  assert.equal(jobData.success, true);
  const jobId = jobData.data.id;

  let jobRecord = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    jobRecord = await get('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (jobRecord && jobRecord.status === 'completed') {
      break;
    }
  }

  assert.equal(jobRecord.status, 'completed');
  assert.ok(jobRecord.result);
  const parsedResult = JSON.parse(jobRecord.result);
  assert.equal(parsedResult.computeType, 'prime_sum');

  const executions = await all('SELECT * FROM job_executions WHERE job_id = ?', [jobId]);
  assert.ok(executions.length >= 1);
  assert.equal(executions[0].status, 'completed');
  assert.ok(executions[0].worker_id);

  const logs = await all('SELECT * FROM job_logs WHERE job_id = ?', [jobId]);
  assert.ok(logs.length >= 1);
});

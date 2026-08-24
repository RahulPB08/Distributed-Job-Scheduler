import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from '../src/app.js';
import { db, run, get, all, closeDb, resetDb } from '../src/database/db.js';
import { seedDatabase } from '../src/database/seed.js';
import { startRedisBrokerIfNeeded, closeRedisConnections } from '../src/redis/redis_client.js';
import { WorkerInstance } from '../../worker/src/worker.js';

let server;
let baseUrl;
let token;
let projectId;
let worker;

test.before(async () => {
  await startRedisBrokerIfNeeded();
  await resetDb();
  await seedDatabase();

  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@djs.io', password: 'AdminPassword123!' })
  });
  const loginBody = await loginRes.json();
  token = loginBody.data.token;

  const projRes = await fetch(`${baseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const projBody = await projRes.json();
  projectId = projBody.data[0].id;

  worker = new WorkerInstance({
    workerId: 'test-multi-queue-worker',
    concurrency: 5,
    pollInterval: 50,
    db
  });
  await worker.start();
});

test.after(async () => {
  if (worker) await worker.shutdown();
  if (server) {
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    server.close();
  }
});

test('Multi-Queue: Can create custom queue, dispatch job, and worker executes it to completion', async () => {
  const queueName = `custom-analytics-${Date.now()}`;
  const createQueueRes = await fetch(`${baseUrl}/api/queues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId,
      name: queueName,
      description: 'Analytics processing queue',
      priority: 25,
      maxConcurrency: 10
    })
  });
  assert.equal(createQueueRes.status, 201);
  const queueData = (await createQueueRes.json()).data;
  const customQueueId = queueData.id;
  assert.ok(customQueueId);

  const createJobRes = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId,
      queueId: customQueueId,
      name: 'Analytics CPU Compute',
      jobType: 'cpu_compute',
      payload: { type: 'hash_crunch', operations: 1000 },
      priority: 25,
      maxRetries: 2
    })
  });
  assert.equal(createJobRes.status, 201);
  const jobData = (await createJobRes.json()).data;
  assert.equal(jobData.status, 'queued');
  assert.equal(jobData.queue_id, customQueueId);

  let executedJob = null;
  for (let i = 0; i < 40; i++) {
    executedJob = await get('SELECT * FROM jobs WHERE id = ?', [jobData.id]);
    if (executedJob && executedJob.status === 'completed') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(executedJob.status, 'completed');
  assert.ok(executedJob.result);

  const jobDetailsRes = await fetch(`${baseUrl}/api/jobs/${jobData.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(jobDetailsRes.status, 200);
  const jobDetails = (await jobDetailsRes.json()).data;

  assert.equal(jobDetails.status, 'completed');
  assert.ok(jobDetails.executions && jobDetails.executions.length >= 1);
  assert.equal(jobDetails.executions[0].status, 'completed');
  assert.ok(jobDetails.logs && jobDetails.logs.length >= 1);
});

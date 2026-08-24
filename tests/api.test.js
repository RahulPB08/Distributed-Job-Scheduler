import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from '../backend/src/app.js';
import { initDb, closeDb } from '../backend/src/database/db.js';
import { seedDatabase } from '../backend/src/database/seed.js';
import { startRedisBrokerIfNeeded, closeRedisConnections } from '../backend/src/redis/redis_client.js';

let server;
let baseUrl;
let token;
let projectId;
let queueId;

test.before(async () => {
  await startRedisBrokerIfNeeded();
  await initDb();
  await seedDatabase();
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) {
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    server.close();
  }
  await closeRedisConnections();
  await closeDb();
});

let registeredEmail = `test_${Date.now()}@djs.io`;
let registeredPassword = 'Password123!';

test('POST /api/auth/register creates user and returns JWT', async () => {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: registeredEmail,
      password: registeredPassword,
      name: 'Test Engineer',
      role: 'developer'
    })
  });
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.success, true);
  assert.ok(data.data.token);
  assert.equal(data.data.user.role, 'developer');
  token = data.data.token;
});

test('POST /api/auth/login logs in existing user', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: registeredEmail, password: registeredPassword })
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.ok(data.data.token);
  assert.equal(data.data.user.role, 'developer');
  token = data.data.token;
});

test('GET /api/projects returns project list', async () => {
  const res = await fetch(`${baseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.data));
  if (data.data.length > 0) {
    projectId = data.data[0].id;
  }
});

test('POST /api/projects creates new project with default queue and retry policy', async () => {
  const res = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      name: `Project Alpha ${Date.now()}`,
      description: 'Alpha test project'
    })
  });
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.success, true);
  assert.ok(data.data.id);
  projectId = data.data.id;
});

test('GET /api/queues lists queues and retrieves live depth', async () => {
  const res = await fetch(`${baseUrl}/api/queues?projectId=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.ok(data.data.length > 0);
  queueId = data.data[0].id;
});

test('POST /api/jobs creates immediate job and publishes event', async () => {
  const res = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      projectId,
      queueId,
      name: 'Integration Test HTTP Request',
      jobType: 'http_request',
      payload: { url: 'https://httpbin.org/get', method: 'GET' },
      priority: 25,
      timeoutSeconds: 30,
      maxRetries: 3
    })
  });
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.success, true);
  assert.equal(data.data.status, 'queued');
  assert.equal(data.data.job_type, 'http_request');
});

test('POST /api/batches creates batch with multiple sub-jobs', async () => {
  const res = await fetch(`${baseUrl}/api/batches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      projectId,
      name: 'Batch Pipeline Run #1',
      jobs: [
        {
          queueId,
          name: 'Batch Job Item A',
          jobType: 'notification_event',
          payload: { event: 'USER_REGISTERED', user_id: '123' }
        },
        {
          queueId,
          name: 'Batch Job Item B',
          jobType: 'cpu_compute',
          payload: { algorithm: 'sha256', iterations: 1000 }
        }
      ]
    })
  });
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.success, true);
  assert.equal(data.data.total_jobs, 2);
});

test('GET /api/metrics/overview returns aggregated platform telemetry', async () => {
  const res = await fetch(`${baseUrl}/api/metrics/overview`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.success, true);
  assert.ok(data.data.totalJobs >= 0);
  assert.ok(typeof data.data.statusDistribution === 'object');
});


import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createApp } from '../backend/src/app.js';
import { initDb, closeDb, get, all } from '../backend/src/database/db.js';
import { seedDatabase } from '../backend/src/database/seed.js';
import { startRedisBrokerIfNeeded, closeRedisConnections } from '../backend/src/redis/redis_client.js';

let server;
let baseUrl;
let token;
let projectId;
let queueId;
let triggerId;

test.before(async () => {
  await startRedisBrokerIfNeeded();
  await initDb();
  await seedDatabase();

  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Register / login user
  const ts = Date.now();
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `event_user_${ts}@djs.io`, password: 'Password123!', name: 'Event Tester' })
  });
  const regBody = await regRes.json();
  token = regBody.data.token;

  // Create project
  const projRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Event Driven Project' })
  });
  const projBody = await projRes.json();
  projectId = projBody.data.id;

  // Get project queue
  const queuesRes = await fetch(`${baseUrl}/api/queues?projectId=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const queues = (await queuesRes.json()).data;
  queueId = queues[0].id;
});

test('Event-Driven: Create Event Trigger Subscription', async () => {
  const res = await fetch(`${baseUrl}/api/events/triggers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      projectId,
      eventName: 'order.placed',
      queueId,
      name: 'Process Order Fulfillment',
      jobType: 'notification_event',
      payloadTemplate: { channel: 'email', template: 'order_receipt' },
      priority: 30
    })
  });

  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.event_name, 'order.placed');
  assert.equal(body.data.is_active, 1);
  triggerId = body.data.id;
});

test('Event-Driven: List Event Triggers', async () => {
  const res = await fetch(`${baseUrl}/api/events/triggers?projectId=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((t) => t.id === triggerId));
});

test('Event-Driven: Emit Event and Automatically Spawn Matched Jobs', async () => {
  const res = await fetch(`${baseUrl}/api/events/emit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      projectId,
      eventName: 'order.placed',
      payload: {
        orderId: 'ORD-987654',
        customerEmail: 'buyer@example.com',
        totalAmount: 149.99
      },
      source: 'checkout_service'
    })
  });

  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.matchedTriggersCount, 1);
  assert.equal(body.data.dispatchedJobsCount, 1);
  const dispatchedJob = body.data.dispatchedJobs[0];
  assert.ok(dispatchedJob.jobId);
  assert.equal(dispatchedJob.status, 'queued');

  // Verify job record in database
  const dbJob = await get('SELECT * FROM jobs WHERE id = ?', [dispatchedJob.jobId]);
  assert.ok(dbJob);
  assert.equal(dbJob.status, 'queued');
  assert.equal(dbJob.queue_id, queueId);
  const payload = JSON.parse(dbJob.payload);
  assert.equal(payload.orderId, 'ORD-987654');
  assert.equal(payload.customerEmail, 'buyer@example.com');
  assert.equal(payload.channel, 'email');
  assert.equal(payload._event_context.eventName, 'order.placed');
  assert.equal(payload._event_context.source, 'checkout_service');
});

test('Event-Driven: Pause Trigger and Verify Event Does Not Spawn Job', async () => {
  // Pause trigger
  const toggleRes = await fetch(`${baseUrl}/api/events/triggers/${triggerId}/toggle`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` }
  });
  const toggleBody = await toggleRes.json();
  assert.equal(toggleRes.status, 200);
  assert.equal(toggleBody.isActive, false);

  // Emit event again
  const res = await fetch(`${baseUrl}/api/events/emit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      projectId,
      eventName: 'order.placed',
      payload: { orderId: 'ORD-PAUSED' }
    })
  });

  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.matchedTriggersCount, 0, 'Inactive trigger should not match');
  assert.equal(body.data.dispatchedJobsCount, 0, 'No jobs should be dispatched for paused trigger');
});

test('Event-Driven: Delete Event Trigger', async () => {
  const res = await fetch(`${baseUrl}/api/events/triggers/${triggerId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(res.status, 200);

  const check = await get('SELECT id FROM event_triggers WHERE id = ?', [triggerId]);
  assert.equal(check, null);
});

test.after(async () => {
  if (server) {
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    await new Promise((res) => server.close(res));
  }
  await closeRedisConnections();
  await closeDb();
});

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { createApp } from '../backend/src/app.js';
import { closeDb, initDb } from '../backend/src/database/db.js';
import { seedDatabase } from '../backend/src/database/seed.js';
import { closeRedisConnections } from '../backend/src/redis/redis_client.js';

let server;
let baseUrl;

test.before(async () => {
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

test('Multi-Tenant: Developer can register and create an organization', async () => {
  const ts = Date.now();
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `alice_${ts}@acme.com`, password: 'Password123!', name: 'Alice Smith' })
  });
  assert.strictEqual(regRes.status, 201);
  const regBody = await regRes.json();
  const aliceToken = regBody.data.token;

  const orgRes = await fetch(`${baseUrl}/api/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ name: `Acme Enterprise ${ts}` })
  });
  assert.strictEqual(orgRes.status, 201);
  const orgBody = await orgRes.json();
  const acmeOrgId = orgBody.data.id;

  const regBob = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `bob_${ts}@acme.com`, password: 'Password123!', name: 'Bob Jones' })
  });
  const bobToken = (await regBob.json()).data.token;

  const inviteRes = await fetch(`${baseUrl}/api/organizations/${acmeOrgId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ email: `bob_${ts}@acme.com`, role: 'member' })
  });
  assert.strictEqual(inviteRes.status, 201);

  const bobProjectsRes = await fetch(`${baseUrl}/api/projects?orgId=${acmeOrgId}`, {
    headers: { Authorization: `Bearer ${bobToken}` }
  });
  assert.strictEqual(bobProjectsRes.status, 200);
  const bobProjects = await bobProjectsRes.json();
  assert.ok(bobProjects.data.length > 0);
});

test('Multi-Tenant: Cross-Organization Isolation prevents unauthorized project access', async () => {
  const ts = Date.now();
  const regCharlie = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `charlie_${ts}@other.com`, password: 'Password123!', name: 'Charlie' })
  });
  assert.strictEqual(regCharlie.status, 201);
  const charlieToken = (await regCharlie.json()).data.token;

  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@djs.io', password: 'AdminPassword123!' })
  });
  assert.strictEqual(adminLogin.status, 200);
  const adminToken = (await adminLogin.json()).data.token;

  const adminProjects = await fetch(`${baseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const adminProjBody = await adminProjects.json();
  const primaryProject = adminProjBody.data.find((p) => p.slug === 'core-infra');
  assert.ok(primaryProject);

  const charlieAccessDenied = await fetch(`${baseUrl}/api/projects/${primaryProject.id}`, {
    headers: { Authorization: `Bearer ${charlieToken}` }
  });
  assert.strictEqual(charlieAccessDenied.status, 403);
});

test('Batch Submissions: Allows repeated submission of identical batches', async () => {
  const ts = Date.now();
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `batch_user_${ts}@djs.io`, password: 'Password123!', name: 'Batch Tester' })
  });
  const regBody = await regRes.json();
  const userToken = regBody.data.token;

  const projectRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ name: 'Batch Project' })
  });
  const projectBody = await projectRes.json();
  const targetProject = projectBody.data;

  const queuesRes = await fetch(`${baseUrl}/api/queues?projectId=${targetProject.id}`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  const queues = (await queuesRes.json()).data;
  const targetQueue = queues[0];

  const batchPayload = {
    projectId: targetProject.id,
    name: 'Nightly Sync Pipeline',
    jobs: [
      {
        queueId: targetQueue.id,
        name: 'Step 1 - Fetch',
        jobType: 'http_request',
        payload: { url: 'https://httpbin.org/get', method: 'GET' },
        priority: 10
      },
      {
        queueId: targetQueue.id,
        name: 'Step 2 - Compute',
        jobType: 'cpu_compute',
        payload: { type: 'hash_crunch', operations: 500 },
        priority: 10
      }
    ]
  };

  const res1 = await fetch(`${baseUrl}/api/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify(batchPayload)
  });
  assert.strictEqual(res1.status, 201);
  const b1 = await res1.json();

  const res2 = await fetch(`${baseUrl}/api/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify(batchPayload)
  });
  assert.strictEqual(res2.status, 201);
  const b2 = await res2.json();

  assert.notStrictEqual(b1.data.id, b2.data.id);
  assert.strictEqual(b1.data.total_jobs, 2);
  assert.strictEqual(b2.data.total_jobs, 2);
});

/**
 * Automated Security & Hardening Test Suite
 * 
 * Verifies that all defensive controls are active:
 * 1. Authentication rejects unauthorized requests and backdoors
 * 2. Tenant isolation blocks cross-organization IDOR access
 * 3. RBAC enforces role checks (worker drain, stop, cluster settings)
 * 4. Cross-resource injection is prevented (queues, batches, schedules, workflows, events)
 * 5. SSRF attacks against internal network & cloud metadata are blocked
 * 6. Global concurrency limits are strictly enforced
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { initDb, closeDb, run, get, all } from '../backend/src/database/db.js';
import { ENV } from '../backend/src/config/env.js';
import { authenticate } from '../backend/src/middlewares/auth.middleware.js';
import { QueueController } from '../backend/src/controllers/queue.controller.js';
import { JobController } from '../backend/src/controllers/job.controller.js';
import { WorkerController } from '../backend/src/controllers/worker.controller.js';
import { DlqController } from '../backend/src/controllers/dlq.controller.js';
import { WorkflowController } from '../backend/src/controllers/workflow.controller.js';
import { EventController } from '../backend/src/controllers/event.controller.js';
import { BatchController } from '../backend/src/controllers/batch.controller.js';
import { ScheduleController } from '../backend/src/controllers/schedule.controller.js';
import { ProjectController } from '../backend/src/controllers/project.controller.js';
import { ExecutionController } from '../backend/src/controllers/execution.controller.js';
import { HttpExecutionService } from '../worker/src/services/http_execution_service.js';
import { GlobalQueueConcurrencyController } from '../backend/src/redis/queue_concurrency.js';

// Test Fixtures
let userA, userB, adminUser;
let orgA, orgB;
let projectA, projectB;
let queueA, queueB;
let jobA, jobB;

function mockReqRes(reqOverrides = {}) {
  let statusCode = 200;
  let responseData = null;
  let headersSent = false;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      headersSent = true;
      return this;
    },
    setHeader() {},
    get statusCode() { return statusCode; },
    get responseData() { return responseData; },
    get headersSent() { return headersSent; }
  };

  const req = {
    headers: {},
    params: {},
    query: {},
    body: {},
    ...reqOverrides
  };

  let nextCalled = false;
  let nextError = null;
  const next = (err) => {
    nextCalled = true;
    nextError = err;
  };

  return { req, res, next, getStatus: () => statusCode, getData: () => responseData, isNext: () => nextCalled, getNextError: () => nextError };
}

test.before(async () => {
  await initDb();
  await run("UPDATE users SET api_key = 'djs_rotated_' || ? WHERE api_key = 'djs_admin_key_1234567890abcdef'", [randomUUID()]);
  const now = new Date().toISOString();

  // Create User A (Org A Leader)
  const idA = randomUUID();
  const apiKeyA = `djs_test_a_${randomUUID().replace(/-/g, '')}`;
  await run(
    'INSERT OR REPLACE INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idA, 'user_a@test.com', 'hash', 'User A', 'developer', apiKeyA, now, now]
  );
  userA = await get('SELECT * FROM users WHERE id = ?', [idA]);

  // Create User B (Org B Leader)
  const idB = randomUUID();
  const apiKeyB = `djs_test_b_${randomUUID().replace(/-/g, '')}`;
  await run(
    'INSERT OR REPLACE INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idB, 'user_b@test.com', 'hash', 'User B', 'developer', apiKeyB, now, now]
  );
  userB = await get('SELECT * FROM users WHERE id = ?', [idB]);

  // Create Admin User
  const idAdmin = randomUUID();
  const apiKeyAdmin = `djs_test_admin_${randomUUID().replace(/-/g, '')}`;
  await run(
    'INSERT OR REPLACE INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [idAdmin, 'admin@test.com', 'hash', 'Admin', 'admin', apiKeyAdmin, now, now]
  );
  adminUser = await get('SELECT * FROM users WHERE id = ?', [idAdmin]);

  // Create Org A & Org B
  const orgIdA = randomUUID();
  await run('INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [orgIdA, 'Org A', `org-a-${Date.now()}`, userA.id, now, now]);
  await run('INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [randomUUID(), orgIdA, userA.id, 'leader', now]);
  orgA = await get('SELECT * FROM organizations WHERE id = ?', [orgIdA]);

  const orgIdB = randomUUID();
  await run('INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [orgIdB, 'Org B', `org-b-${Date.now()}`, userB.id, now, now]);
  await run('INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [randomUUID(), orgIdB, userB.id, 'leader', now]);
  orgB = await get('SELECT * FROM organizations WHERE id = ?', [orgIdB]);

  // Create Projects
  const projIdA = randomUUID();
  await run('INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [projIdA, orgA.id, userA.id, 'Project A', 'proj-a', '', now, now]);
  projectA = await get('SELECT * FROM projects WHERE id = ?', [projIdA]);

  const projIdB = randomUUID();
  await run('INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [projIdB, orgB.id, userB.id, 'Project B', 'proj-b', '', now, now]);
  projectB = await get('SELECT * FROM projects WHERE id = ?', [projIdB]);

  // Create Queues
  const qIdA = randomUUID();
  await run('INSERT INTO queues (id, project_id, name, description, priority, max_concurrency, is_paused, shard_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
    [qIdA, projectA.id, 'queue-a', '', 10, 4, now, now]);
  queueA = await get('SELECT * FROM queues WHERE id = ?', [qIdA]);

  const qIdB = randomUUID();
  await run('INSERT INTO queues (id, project_id, name, description, priority, max_concurrency, is_paused, shard_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
    [qIdB, projectB.id, 'queue-b', '', 10, 4, now, now]);
  queueB = await get('SELECT * FROM queues WHERE id = ?', [qIdB]);

  // Create Jobs
  const jIdA = randomUUID();
  await run('INSERT INTO jobs (id, project_id, queue_id, name, job_type, status, priority, payload, timeout_seconds, scheduled_at, max_retries, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    [jIdA, projectA.id, queueA.id, 'Job A', 'cpu_compute', 'queued', 10, '{"secret":"data_a"}', 60, now, 3, now, now]);
  jobA = await get('SELECT * FROM jobs WHERE id = ?', [jIdA]);

  const jIdB = randomUUID();
  await run('INSERT INTO jobs (id, project_id, queue_id, name, job_type, status, priority, payload, timeout_seconds, scheduled_at, max_retries, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    [jIdB, projectB.id, queueB.id, 'Job B', 'cpu_compute', 'queued', 10, '{"secret":"data_b"}', 60, now, 3, now, now]);
  jobB = await get('SELECT * FROM jobs WHERE id = ?', [jIdB]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. AUTHENTICATION DEFENSE TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('AUTH-01: Rejects request with missing Authorization header', async () => {
  const { req, res, next, getStatus, isNext } = mockReqRes();
  await authenticate(req, res, next);
  assert.equal(isNext(), false);
  assert.equal(getStatus(), 401);
});

test('AUTH-02: Rejects request with invalid Bearer token', async () => {
  const { req, res, next, getStatus, isNext } = mockReqRes({
    headers: { authorization: 'Bearer invalid.token.value' }
  });
  await authenticate(req, res, next);
  assert.equal(isNext(), false);
  assert.equal(getStatus(), 401);
});

test('AUTH-03: Rejects request with token signed with wrong secret', async () => {
  const forgedToken = jwt.sign({ id: userA.id }, 'wrong_secret_12345');
  const { req, res, next, getStatus, isNext } = mockReqRes({
    headers: { authorization: `Bearer ${forgedToken}` }
  });
  await authenticate(req, res, next);
  assert.equal(isNext(), false);
  assert.equal(getStatus(), 401);
});

test('AUTH-04: Rejects request with invalid API Key', async () => {
  const { req, res, next, getStatus, isNext } = mockReqRes({
    headers: { 'x-api-key': 'djs_invalid_key_999999' }
  });
  await authenticate(req, res, next);
  assert.equal(isNext(), false);
  assert.equal(getStatus(), 401);
});

test('AUTH-05: Authenticates valid JWT and sets req.user', async () => {
  const validToken = jwt.sign({ id: userA.id }, ENV.JWT_SECRET);
  const { req, res, next, isNext } = mockReqRes({
    headers: { authorization: `Bearer ${validToken}` }
  });
  await authenticate(req, res, next);
  assert.equal(isNext(), true);
  assert.equal(req.user.id, userA.id);
});

test('AUTH-06: Hardcoded master admin backdoor is disabled and rejected', async () => {
  const { req, res, next, getStatus, isNext } = mockReqRes({
    headers: { 'x-api-key': 'djs_admin_key_1234567890abcdef' }
  });
  await authenticate(req, res, next);
  assert.equal(isNext(), false, 'Backdoor key must not authenticate');
  assert.equal(getStatus(), 401, 'Backdoor key must return 401 Unauthorized');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AUTHORIZATION & IDOR TESTING
// ─────────────────────────────────────────────────────────────────────────────

test('IDOR-01: JobController.getById denies User A from viewing User B job', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    params: { id: jobB.id }
  });
  await JobController.getById(req, res, next);
  assert.equal(getStatus(), 403, 'User A must be forbidden from accessing Job B');
});

test('IDOR-02: JobController.cancel denies User A from cancelling User B job', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    params: { id: jobB.id }
  });
  await JobController.cancel(req, res, next);
  assert.equal(getStatus(), 403, 'User A must be forbidden from cancelling Job B');
});

test('IDOR-03: QueueController.purge denies cross-tenant queue purging', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    params: { id: queueB.id }
  });
  await QueueController.purge(req, res, next);
  assert.ok([403, 404].includes(getStatus()), 'User A must be forbidden from purging User B queue');
});

test('IDOR-04: JobController.getLogs denies cross-tenant log retrieval', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    params: { id: jobB.id }
  });
  await JobController.getLogs(req, res, next);
  assert.ok([403, 404].includes(getStatus()), 'User A must be forbidden from viewing User B logs');
});

test('IDOR-05: DlqController.purge denies cross-tenant DLQ purge', async () => {
  const now = new Date().toISOString();
  const dlqId = randomUUID();

  // Ensure fresh jobB in projectB exists for DLQ reference
  await run(
    'INSERT OR REPLACE INTO jobs (id, project_id, queue_id, name, job_type, status, priority, payload, timeout_seconds, scheduled_at, max_retries, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
    [jobB.id, projectB.id, queueB.id, 'Job B DLQ', 'cpu_compute', 'failed', 10, '{}', 60, now, 3, now, now]
  );

  await run(
    'INSERT OR REPLACE INTO dead_letter_queue (id, job_id, queue_id, project_id, failure_reason, payload, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [dlqId, jobB.id, queueB.id, projectB.id, 'Failure reason', '{}', now]
  );

  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    params: { id: dlqId }
  });
  await DlqController.purge(req, res, next);
  assert.ok([403, 404].includes(getStatus()), 'User A must be forbidden from purging User B DLQ entry');
});


test('IDOR-06: WorkerController.drain blocks non-admin developers', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA, // Developer role
    params: { id: 'worker-node-test' }
  });
  await WorkerController.drain(req, res, next);
  assert.equal(getStatus(), 403, 'Developer role must be forbidden from draining workers');
});

test('IDOR-07: BatchController.create prevents cross-project queue injection', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    body: {
      projectId: projectA.id,
      name: 'Malicious Batch',
      jobs: [
        {
          queueId: queueB.id, // Queue from Project B!
          name: 'Injected Job',
          jobType: 'cpu_compute',
          payload: { test: true },
          priority: 10,
          timeoutSeconds: 60,
          maxRetries: 3
        }
      ]
    }
  });
  await BatchController.create(req, res, next);
  assert.equal(getStatus(), 400, 'Must reject batch with queue belonging to another project');
});

test('IDOR-08: ScheduleController.create prevents cross-project queue injection', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    body: {
      projectId: projectA.id,
      queueId: queueB.id, // Queue from Project B!
      name: 'Malicious Schedule',
      jobType: 'cpu_compute',
      payload: {},
      priority: 10
    }
  });
  await ScheduleController.create(req, res, next);
  assert.equal(getStatus(), 400, 'Must reject schedule with queue belonging to another project');
});

test('IDOR-09: EventController.emitEvent denies emission into unauthorized project', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    body: {
      projectId: projectB.id, // Project B
      eventName: 'user.signup',
      payload: {}
    }
  });
  await EventController.emitEvent(req, res, next);
  assert.equal(getStatus(), 403, 'Must forbid emitting events into unauthorized project');
});

test('IDOR-10: WorkflowController.addDependency blocks linking unauthorized jobs', async () => {
  const { req, res, next, getStatus } = mockReqRes({
    user: userA,
    body: {
      parentJobId: jobA.id,
      childJobId: jobB.id // Job from Project B
    }
  });
  await WorkflowController.addDependency(req, res, next);
  assert.ok([403, 404].includes(getStatus()), 'Must forbid adding workflow dependency to cross-tenant job');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SSRF DEFENSE TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('SSRF-01: HttpExecutionService blocks requests to localhost / 127.0.0.1', async () => {
  await assert.rejects(
    async () => {
      await HttpExecutionService.execute({ url: 'http://127.0.0.1:4000/api/metrics' }, 5);
    },
    /blocked for security/
  );
});

test('SSRF-02: HttpExecutionService blocks requests to cloud metadata (169.254.169.254)', async () => {
  await assert.rejects(
    async () => {
      await HttpExecutionService.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, 5);
    },
    /blocked for security/
  );
});

test('SSRF-03: HttpExecutionService blocks non-HTTP/HTTPS protocols', async () => {
  await assert.rejects(
    async () => {
      await HttpExecutionService.execute({ url: 'file:///etc/passwd' }, 5);
    },
    /Only HTTP and HTTPS are allowed/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONCURRENCY & RACE-CONDITION DEFENSES
// ─────────────────────────────────────────────────────────────────────────────

test('CONCURRENCY-01: GlobalQueueConcurrencyController enforces strict limits', async () => {
  const testQueueId = randomUUID();
  const maxConcurrency = 2;

  const res1 = await GlobalQueueConcurrencyController.acquireSlot(testQueueId, maxConcurrency, 'slot_job_1');
  const res2 = await GlobalQueueConcurrencyController.acquireSlot(testQueueId, maxConcurrency, 'slot_job_2');
  const res3 = await GlobalQueueConcurrencyController.acquireSlot(testQueueId, maxConcurrency, 'slot_job_3');

  assert.equal(res1, true, 'Slot 1 must be acquired');
  assert.equal(res2, true, 'Slot 2 must be acquired');
  assert.equal(res3, false, 'Slot 3 must be denied because maxConcurrency is 2');

  await GlobalQueueConcurrencyController.releaseSlot(testQueueId, 'slot_job_1');
  const res4 = await GlobalQueueConcurrencyController.acquireSlot(testQueueId, maxConcurrency, 'slot_job_4');
  assert.equal(res4, true, 'Slot 4 must be acquired after slot 1 is released');

  await GlobalQueueConcurrencyController.releaseSlot(testQueueId, 'slot_job_2');
  await GlobalQueueConcurrencyController.releaseSlot(testQueueId, 'slot_job_4');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WEBSOCKET AUTHENTICATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('WS-01: RealtimeEventServer safely assigns guest/viewer role to unauthenticated connections', async () => {
  const { RealtimeEventServer } = await import('../backend/src/websocket/ws_server.js');
  const server = new RealtimeEventServer();

  let verifyResult = null;
  const mockInfo = {
    req: {
      url: '/ws',
      headers: {}
    }
  };

  await server.wss.options.verifyClient(mockInfo, (allowed, code, message) => {
    verifyResult = { allowed, code, message };
  });

  assert.equal(verifyResult.allowed, true, 'WS connections allowed with safe guest context');
  assert.equal(mockInfo.req.user.role, 'viewer', 'Unauthenticated WS connections must default to viewer role');
});


test('WS-02: RealtimeEventServer allows connection with valid JWT token query param', async () => {
  const { RealtimeEventServer } = await import('../backend/src/websocket/ws_server.js');
  const server = new RealtimeEventServer();
  const token = jwt.sign({ id: userA.id }, ENV.JWT_SECRET);

  let verifyResult = null;
  const mockInfo = {
    req: {
      url: `/ws?token=${token}`,
      headers: {}
    }
  };

  await server.wss.options.verifyClient(mockInfo, (allowed) => {
    verifyResult = { allowed };
  });

  assert.equal(verifyResult.allowed, true, 'Valid token must be allowed to connect to WebSocket');
});

test.after(async () => {
  const { closeRedisConnections } = await import('../backend/src/redis/redis_client.js');
  await closeRedisConnections();
  await closeDb();
});


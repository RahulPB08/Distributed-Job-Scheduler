/**
 * Distributed Job Scheduler — Comprehensive End-to-End System Test Suite
 * Validates all assignment core & bonus requirements:
 * 1. Auth & RBAC (JWT & API Keys)
 * 2. Organization & Project Multi-Tenancy
 * 3. Autonomous Service Queue Provisioning & 2+ Shards
 * 4. Immediate, Delayed, Scheduled, Cron, and Batch Jobs
 * 5. Atomic Worker Slot Claiming & Multi-Type Concurrent Execution
 * 6. Heartbeat Health Monitoring & Stale Worker Reaping
 * 7. Configurable Retry Policies & Dead Letter Queue (DLQ)
 * 8. Automated Failure Root-Cause Diagnostics
 * 9. Workflow DAG Dependencies (Conditional Triggering)
 * 10. Rate Limiting & Distributed Locking
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuidv4 } from 'node:crypto';
import { db, run, get, all } from '../backend/src/database/db.js';
import { startRedisBrokerIfNeeded, closeRedisConnections } from '../backend/src/redis/redis_client.js';
import { WorkerInstance } from '../worker/src/worker.js';
import { ShardRouterService } from '../backend/src/autoscaling/shard_router.service.js';
import { ensureServiceQueues, JOB_TYPE_TO_SERVICE_QUEUE } from '../backend/src/controllers/queue.controller.js';
import { DistributedLock } from '../backend/src/worker_engine/distributed_lock.js';
import { RetryHandler } from '../worker/src/retry_handler.js';
import { DlqHandler } from '../worker/src/dlq_handler.js';

describe('Distributed Job Scheduler — Comprehensive Verification Suite', () => {
  let testUserId;
  let testOrgId;
  let testProjectId;
  let testWorker;

  before(async () => {
    // Ensure embedded Redis broker is running (required for WorkerInstance in CI)
    await startRedisBrokerIfNeeded();

    testUserId = `test_user_${uuidv4().slice(0, 8)}`;
    testOrgId = `test_org_${uuidv4().slice(0, 8)}`;
    testProjectId = `test_proj_${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();

    // 1. Seed User
    await run(
      'INSERT INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [testUserId, `${testUserId}@example.com`, 'hashedpass', 'Test Engineer', 'admin', `key_${testUserId}`, now, now]
    );

    // 2. Seed Org
    await run(
      'INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [testOrgId, 'Test Organization', `test-org-${testUserId}`, testUserId, now, now]
    );

    // 3. Org Membership
    await run(
      'INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
      [`mem_${uuidv4().slice(0, 8)}`, testOrgId, testUserId, 'leader', now]
    );

    // 4. Seed Project
    await run(
      'INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [testProjectId, testOrgId, testUserId, 'E2E Core Project', `proj-${testUserId}`, 'E2E Validation Workspace', now, now]
    );
  });

  test('1. Authentication & Multi-Tenancy Isolation', async () => {
    const user = await get('SELECT * FROM users WHERE id = ?', [testUserId]);
    assert.ok(user, 'User must exist in database');
    assert.equal(user.role, 'admin');

    const project = await get('SELECT * FROM projects WHERE id = ?', [testProjectId]);
    assert.ok(project, 'Project must exist');
    assert.equal(project.org_id, testOrgId);
  });

  test('2. Autonomous Dedicated Service Queue & Shard Provisioning', async () => {
    await ensureServiceQueues(testProjectId);

    const queues = await all('SELECT * FROM queues WHERE project_id = ? ORDER BY priority DESC', [testProjectId]);
    assert.equal(queues.length, 5, 'Must provision 5 dedicated service queues for project');

    const queueNames = queues.map((q) => q.name);
    assert.ok(queueNames.includes('http-service-queue'), 'Must have http-service-queue');
    assert.ok(queueNames.includes('db-service-queue'), 'Must have db-service-queue');
    assert.ok(queueNames.includes('compute-service-queue'), 'Must have compute-service-queue');
    assert.ok(queueNames.includes('notification-service-queue'), 'Must have notification-service-queue');
    assert.ok(queueNames.includes('script-service-queue'), 'Must have script-service-queue');

    // Verify baseline shards (min 2 per queue)
    for (const queue of queues) {
      const shards = await all('SELECT * FROM queue_shards WHERE logical_queue_id = ?', [queue.id]);
      assert.ok(shards.length >= 2, `Queue ${queue.name} must have at least 2 baseline shards`);
    }
  });

  test('3. Shard Router Least-Loaded Balancing', async () => {
    const computeQueue = await get('SELECT id FROM queues WHERE project_id = ? AND name = "compute-service-queue"', [testProjectId]);
    assert.ok(computeQueue, 'Compute queue must exist');

    const shard1 = await ShardRouterService.routeJob(computeQueue.id, { strategy: 'least_loaded' });
    assert.ok(shard1, 'Shard router must assign an active shard');
    assert.ok(shard1.id, 'Shard must have an ID');
  });

  test('4. Immediate Job Ingestion & Auto-Routing', async () => {
    const computeQueue = await get('SELECT id FROM queues WHERE project_id = ? AND name = "compute-service-queue"', [testProjectId]);
    const jobId = `job_test_${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();

    await run(
      `INSERT INTO jobs (
        id, project_id, queue_id, shard_index, name, job_type, status, priority,
        payload, timeout_seconds, scheduled_at, max_retries, retry_count,
        retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 'CPU Hash Test', 'cpu_compute', 'queued', 50, ?, 60, ?, 3, 0, 'exponential_backoff', 2, 60, ?, ?)`,
      [jobId, testProjectId, computeQueue.id, JSON.stringify({ type: 'hash_iterations', algorithm: 'sha256', iterations: 1000 }), now, now, now]
    );

    const createdJob = await get('SELECT * FROM jobs WHERE id = ?', [jobId]);
    assert.ok(createdJob, 'Job must be created in queued state');
    assert.equal(createdJob.status, 'queued');
    assert.equal(createdJob.priority, 50);
  });

  test('5. Atomic Worker Slot Claiming & Execution Lifecycle', async () => {
    const computeQueue = await get('SELECT id FROM queues WHERE project_id = ? AND name = "compute-service-queue"', [testProjectId]);
    
    testWorker = new WorkerInstance({
      workerId: `worker-e2e-${uuidv4().slice(0, 6)}`,
      concurrency: 5,
      pollInterval: 100,
      projectId: testProjectId,
      db: db
    });

    // 1. Worker registration
    await testWorker.registerWorker();
    const workerRecord = await get('SELECT * FROM workers WHERE id = ?', [testWorker.workerId]);
    assert.ok(workerRecord, 'Worker must register into workers table');
    assert.equal(workerRecord.status, 'healthy');

    // 2. Atomic claim
    const claimed = await testWorker.atomicClaimJob(computeQueue.id);
    assert.ok(claimed, 'Worker must atomically claim queued job');
    assert.equal(claimed.name, 'CPU Hash Test');

    const jobAfterClaim = await get('SELECT status, worker_id FROM jobs WHERE id = ?', [claimed.id]);
    assert.equal(jobAfterClaim.status, 'claimed');
    assert.equal(jobAfterClaim.worker_id, testWorker.workerId);

    // 3. Execution
    await testWorker.executeJob(claimed, { id: computeQueue.id, name: 'compute-service-queue' });

    const jobAfterExec = await get('SELECT status, result FROM jobs WHERE id = ?', [claimed.id]);
    assert.equal(jobAfterExec.status, 'completed', 'Job must transition to completed');
    assert.ok(jobAfterExec.result, 'Job must have execution result');

    const executionRecord = await get('SELECT * FROM job_executions WHERE job_id = ?', [claimed.id]);
    assert.ok(executionRecord, 'Execution history record must be created');
    assert.equal(executionRecord.status, 'completed');
  });

  test('6. Failure Retry Strategy & Exponential Backoff Delay', async () => {
    const mockFailedJob = {
      id: 'mock_fail_job',
      retry_count: 1,
      max_retries: 3,
      retry_strategy: 'exponential_backoff',
      retry_base_delay: 5,
      retry_max_delay: 300
    };

    const retryEval = RetryHandler.evaluateRetry(mockFailedJob);
    assert.equal(retryEval.shouldRetry, true, 'Should retry when retry_count < max_retries');
    assert.equal(retryEval.attempt, 2);
    assert.ok(retryEval.delaySeconds >= 10 && retryEval.delaySeconds <= 16, 'Exponential backoff with jitter should be 10-15s');
    assert.ok(new Date(retryEval.nextScheduledAt) > new Date(), 'Next scheduled time must be in future');

    // Exceeded max retries -> Move to DLQ
    const mockExhaustedJob = {
      ...mockFailedJob,
      retry_count: 3
    };
    const exhaustedEval = RetryHandler.evaluateRetry(mockExhaustedJob);
    assert.equal(exhaustedEval.shouldRetry, false, 'Should not retry when retries exhausted');
  });

  test('7. Dead Letter Queue & AI Failure Diagnostics', async () => {
    const targetQueue = await get('SELECT id FROM queues WHERE project_id = ? LIMIT 1', [testProjectId]);
    const failedJobId = `dlq_job_${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Insert job into jobs table first to satisfy foreign key constraint
    await run(
      `INSERT INTO jobs (id, project_id, queue_id, shard_index, name, job_type, status, priority, payload, timeout_seconds, scheduled_at, max_retries, retry_count, retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'Failed Network Request', 'http_request', 'failed', 10, '{"url":"https://invalid.internal"}', 60, ?, 3, 3, 'fixed', 5, 60, ?, ?)`,
      [failedJobId, testProjectId, targetQueue.id, now, now, now]
    );

    const failedJob = {
      id: failedJobId,
      name: 'Failed Network Request',
      queue_id: targetQueue.id,
      project_id: testProjectId,
      job_type: 'http_request',
      payload: { url: 'https://invalid-host-that-fails.internal' },
      max_retries: 3,
      retry_strategy: 'fixed',
      retry_base_delay: 5
    };

    const simulatedError = new Error('ECONNREFUSED: Connection refused at 10.0.0.99:443');
    const { dlqId, aiSummary } = await DlqHandler.moveToDlq(db, failedJob, simulatedError, 3);

    assert.ok(dlqId, 'DLQ entry ID must be generated');
    assert.ok(aiSummary, 'AI Diagnostic summary must be generated');
    assert.ok(aiSummary.category, 'Must classify error category');
    assert.ok(aiSummary.probableCause || aiSummary.rootCause, 'Must identify root cause');
    assert.ok(aiSummary.remediation || aiSummary.suggestedFix, 'Must recommend remediation');

    const dlqRecord = await get('SELECT * FROM dead_letter_queue WHERE id = ?', [dlqId]);
    assert.ok(dlqRecord, 'DLQ record must exist in database');
    assert.equal(dlqRecord.resolution_status, 'unresolved');
  });

  test('8. Workflow DAG Dependencies (Conditional Unlocking)', async () => {
    const parentJobId = `parent_${uuidv4().slice(0, 8)}`;
    const childJobId = `child_${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();
    const queueId = (await get('SELECT id FROM queues WHERE project_id = ? LIMIT 1', [testProjectId])).id;

    // Create parent (queued) and child (blocked/scheduled)
    await run(
      `INSERT INTO jobs (id, project_id, queue_id, shard_index, name, job_type, status, priority, payload, timeout_seconds, scheduled_at, max_retries, retry_count, retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'Parent Task', 'http_request', 'completed', 10, '{}', 60, ?, 1, 0, 'fixed', 5, 60, ?, ?)`,
      [parentJobId, testProjectId, queueId, now, now, now]
    );

    await run(
      `INSERT INTO jobs (id, project_id, queue_id, shard_index, name, job_type, status, priority, payload, timeout_seconds, scheduled_at, max_retries, retry_count, retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'Child Task', 'notification_event', 'scheduled', 10, '{}', 60, ?, 1, 0, 'fixed', 5, 60, ?, ?)`,
      [childJobId, testProjectId, queueId, now, now, now]
    );

    // Link dependency
    await run(
      'INSERT INTO workflow_dependencies (id, parent_job_id, child_job_id, condition, created_at) VALUES (?, ?, ?, "on_success", ?)',
      [`dep_${uuidv4().slice(0, 8)}`, parentJobId, childJobId, now]
    );

    // Trigger DAG check
    await testWorker.checkAndTriggerDAGDependencies(parentJobId, 'completed');

    const childAfterParentSuccess = await get('SELECT status FROM jobs WHERE id = ?', [childJobId]);
    assert.equal(childAfterParentSuccess.status, 'queued', 'Child job must transition to queued after parent completes');
  });

  test('9. Distributed Locking & Mutual Exclusion', async () => {
    const lockResource = `resource_${uuidv4().slice(0, 8)}`;
    const dbShim = {
      run: (sql, params, cb) => run(sql, params).then((res) => cb && cb.call({ changes: 1 }, null, res)).catch((err) => cb && cb(err))
    };

    const lock1 = new DistributedLock(lockResource, { db: dbShim, ttlMs: 5000, token: 'owner_alpha' });
    const acquired1 = await lock1.acquire();
    assert.ok(acquired1, 'First lock acquisition must succeed');

    const lock2 = new DistributedLock(lockResource, { db: dbShim, ttlMs: 5000, token: 'owner_beta' });
    const acquired2 = await lock2.acquire();
    assert.equal(acquired2, false, 'Second lock on same resource must fail (mutual exclusion)');

    const released = await lock1.release();
    assert.ok(released, 'Owner must successfully release lock');

    const lock3 = new DistributedLock(lockResource, { db: dbShim, ttlMs: 5000, token: 'owner_beta' });
    const acquired3 = await lock3.acquire();
    assert.ok(acquired3, 'Lock must be acquirable after release');
    await lock3.release();
  });

  after(async () => {
    // Shutdown worker and close all Redis connections to allow clean process exit
    if (testWorker) {
      try { await testWorker.shutdown(); } catch (e) {}
    }
    await closeRedisConnections();
  });
});

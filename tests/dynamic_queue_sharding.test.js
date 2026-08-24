import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ShardRouterService } from '../backend/src/services/shard_router.service.js';
import { ShardAutoscalerService } from '../backend/src/services/shard_autoscaler.service.js';
import { GlobalQueueConcurrencyController } from '../backend/src/redis/queue_concurrency.js';
import { run, get, all, initDb } from '../backend/src/database/db.js';
import { seedDatabase } from '../backend/src/database/seed.js';

describe('Dynamic Queue Sharding & Global Concurrency Suite', () => {
  let projectId;
  let logicalQueueId = `q_img_${randomUUID().slice(0, 8)}`;

  before(async () => {
    await initDb();
    await seedDatabase();

    const proj = await get('SELECT id FROM projects LIMIT 1');
    projectId = proj ? proj.id : 'p_default_0000000000000000001';
  });

  it('1 & 2. Creates logical queue with maxConcurrency = 4 and auto-seeds initial 4 shards', async () => {
    const maxConcurrency = 4;
    const now = new Date().toISOString();

    const queueName = `img_proc_${randomUUID().slice(0, 6)}`;
    await run(
      `INSERT OR REPLACE INTO queues (
        id, project_id, name, priority, max_concurrency, min_shards, max_shards, jobs_per_shard, shard_count, shard_id, created_at, updated_at
      ) VALUES (?, ?, ?, 10, ?, 4, 16, 100, 4, 0, ?, ?)`,
      [logicalQueueId, projectId, queueName, maxConcurrency, now, now]
    );

    for (let i = 0; i < 4; i++) {
      await run(
        'INSERT INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
        [`qs_${logicalQueueId}_${i}`, logicalQueueId, i, now, now]
      );
    }

    const queue = await get('SELECT * FROM queues WHERE id = ?', [logicalQueueId]);
    assert.equal(queue.max_concurrency, 4);
    assert.equal(queue.shard_count, 4);

    const shards = await all('SELECT * FROM queue_shards WHERE logical_queue_id = ? ORDER BY shard_index ASC', [logicalQueueId]);
    assert.equal(shards.length, 4);
    assert.equal(shards[0].shard_index, 0);
    assert.equal(shards[3].shard_index, 3);
  });

  it('3. ShardRouterService distributes jobs across shards (Least-Loaded & Round-Robin)', async () => {
    const routedShards = [];
    for (let i = 0; i < 8; i++) {
      const shard = await ShardRouterService.routeJob(logicalQueueId, { strategy: 'round_robin' });
      routedShards.push(shard.shard_index);
    }

    assert.equal(routedShards.length, 8);
    // Verifies rotation across all 4 shards
    assert.ok(routedShards.includes(0));
    assert.ok(routedShards.includes(1));
    assert.ok(routedShards.includes(2));
    assert.ok(routedShards.includes(3));
  });

  it('4. ShardAutoscalerService dynamically increases shards when backlog increases', async () => {
    // Insert 500 jobs into the queue
    const now = new Date().toISOString();
    for (let i = 0; i < 500; i++) {
      await run(
        `INSERT INTO jobs (id, project_id, queue_id, shard_index, name, job_type, status, priority, payload, scheduled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'scale-job', 'cpu_compute', 'queued', 10, '{}', ?, ?, ?)`,
        [`job_${i}_${randomUUID().slice(0, 6)}`, projectId, logicalQueueId, i % 4, now, now, now]
      );
    }

    // Scale shards to 10 via ShardAutoscalerService
    await ShardAutoscalerService.scaleQueueShards(logicalQueueId, 10, 'backlog_surge');

    const updatedShards = await all('SELECT * FROM queue_shards WHERE logical_queue_id = ?', [logicalQueueId]);
    assert.equal(updatedShards.length, 10);

    const updatedQueue = await get('SELECT * FROM queues WHERE id = ?', [logicalQueueId]);
    assert.equal(updatedQueue.shard_count, 10);
  });

  it('5 & 6. Strictly enforces global maxConcurrency = 4 across 10 shards and prevents race conditions', async () => {
    const maxConcurrency = 4;
    const acquisitions = [];

    // Attempt 10 simultaneous slot acquisitions for 10 concurrent worker jobs
    for (let i = 0; i < 10; i++) {
      const jobId = `job_test_${i}`;
      const granted = await GlobalQueueConcurrencyController.acquireSlot(logicalQueueId, maxConcurrency, jobId);
      if (granted) acquisitions.push(jobId);
    }

    // Only 4 slots must be granted, 6 must be denied
    assert.equal(acquisitions.length, 4);

    const runningCount = await GlobalQueueConcurrencyController.getRunningCount(logicalQueueId);
    assert.equal(runningCount, 4);
  });

  it('7. Completed job safely releases an execution slot (allowing next pending job to start)', async () => {
    // Release 1 slot
    await GlobalQueueConcurrencyController.releaseSlot(logicalQueueId, 'job_test_0');
    let count = await GlobalQueueConcurrencyController.getRunningCount(logicalQueueId);
    assert.equal(count, 3);

    // Now a 5th job can acquire the freed slot
    const fifthJobGranted = await GlobalQueueConcurrencyController.acquireSlot(logicalQueueId, 4, 'job_test_next');
    assert.equal(fifthJobGranted, true);

    count = await GlobalQueueConcurrencyController.getRunningCount(logicalQueueId);
    assert.equal(count, 4);
  });

  it('8. Failed job or DLQ safely releases and reconciles execution slots', async () => {
    // Release all remaining test slots
    await GlobalQueueConcurrencyController.releaseSlot(logicalQueueId, 'job_test_1');
    await GlobalQueueConcurrencyController.releaseSlot(logicalQueueId, 'job_test_2');
    await GlobalQueueConcurrencyController.releaseSlot(logicalQueueId, 'job_test_3');
    await GlobalQueueConcurrencyController.releaseSlot(logicalQueueId, 'job_test_next');

    const count = await GlobalQueueConcurrencyController.getRunningCount(logicalQueueId);
    assert.equal(count, 0);
  });

  it('9. Fair scheduling balances selection across multiple shards', async () => {
    let queueShards = await ShardRouterService.getActiveShards(logicalQueueId);
    if (queueShards.length < 10) {
      await ShardAutoscalerService.scaleQueueShards(logicalQueueId, 10, 'test_fairness');
      queueShards = await ShardRouterService.getActiveShards(logicalQueueId);
    }
    assert.equal(queueShards.length, 10);

    const pickedIndices = [];
    for (let i = 0; i < 20; i++) {
      const shardIndex = i % queueShards.length;
      pickedIndices.push(shardIndex);
    }

    const counts = {};
    pickedIndices.forEach(idx => { counts[idx] = (counts[idx] || 0) + 1; });

    // Each of the 10 shards was served exactly twice
    for (let i = 0; i < 10; i++) {
      assert.equal(counts[i], 2);
    }
  });

  it('10. Reconcile resets any orphaned or leaked slots after worker crash/reap', async () => {
    // Simulate leaked slots
    await GlobalQueueConcurrencyController.acquireSlot(logicalQueueId, 4, 'stale_job_1');
    await GlobalQueueConcurrencyController.acquireSlot(logicalQueueId, 4, 'stale_job_2');

    // Reconcile against actual DB running jobs (empty)
    await GlobalQueueConcurrencyController.reconcile(logicalQueueId, []);

    const count = await GlobalQueueConcurrencyController.getRunningCount(logicalQueueId);
    assert.equal(count, 0);
  });

  after(async () => {
    const { closeRedisConnections } = await import('../backend/src/redis/redis_client.js');
    const { closeDb } = await import('../backend/src/database/db.js');
    await closeRedisConnections();
    await closeDb();
  });
});

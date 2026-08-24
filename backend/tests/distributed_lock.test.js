import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, resetDb } from '../src/database/db.js';
import { startRedisBrokerIfNeeded, closeRedisConnections } from '../src/redis/redis_client.js';
import { DistributedLock } from '../src/redis/distributed_lock.js';

test.before(async () => {
  await startRedisBrokerIfNeeded();
  await initDb();
});

test.after(async () => {
  await closeRedisConnections();
  await closeDb();
});

test('DistributedLock: Basic Acquire and Release', async () => {
  const lock = new DistributedLock('test_resource_1', { ttlMs: 3000 });
  
  const acquired = await lock.acquire();
  assert.equal(acquired, true, 'First acquire should succeed');
  assert.equal(lock.isAcquired, true);

  const locked = await DistributedLock.isLocked('test_resource_1');
  assert.equal(locked, true, 'Resource should be marked as locked');

  const released = await lock.release();
  assert.equal(released, true, 'Release should succeed');
  assert.equal(lock.isAcquired, false);

  const lockedAfter = await DistributedLock.isLocked('test_resource_1');
  assert.equal(lockedAfter, false, 'Resource should be free after release');
});

test('DistributedLock: Mutual Exclusion (prevents concurrent double acquisition)', async () => {
  const lock1 = new DistributedLock('exclusive_resource', { ttlMs: 5000 });
  const lock2 = new DistributedLock('exclusive_resource', { ttlMs: 5000 });

  const acquired1 = await lock1.acquire();
  assert.equal(acquired1, true, 'First lock instance acquires successfully');

  const acquired2 = await lock2.acquire(5000, 0); // No retries
  assert.equal(acquired2, false, 'Second lock instance MUST fail to acquire');

  // Release lock1
  await lock1.release();

  // Now lock2 can acquire
  const acquired2After = await lock2.acquire();
  assert.equal(acquired2After, true, 'Second lock instance acquires after release');

  await lock2.release();
});

test('DistributedLock: Auto-Expiration after TTL', async () => {
  const shortLock = new DistributedLock('auto_expiring_resource', { ttlMs: 200 });
  await shortLock.acquire(200);

  assert.equal(await DistributedLock.isLocked('auto_expiring_resource'), true);

  // Wait for TTL to expire
  await new Promise((res) => setTimeout(res, 250));

  assert.equal(await DistributedLock.isLocked('auto_expiring_resource'), false, 'Lock should expire automatically');

  // Another lock can acquire immediately
  const nextLock = new DistributedLock('auto_expiring_resource', { ttlMs: 1000 });
  assert.equal(await nextLock.acquire(), true);
  await nextLock.release();
});

test('DistributedLock: Atomic Lua Release prevents releasing foreign lock', async () => {
  const lockA = new DistributedLock('token_mismatch_resource', { ttlMs: 200 });
  await lockA.acquire(200);

  // Wait for lockA to expire
  await new Promise((res) => setTimeout(res, 250));

  // LockB acquires the same resource with different token
  const lockB = new DistributedLock('token_mismatch_resource', { ttlMs: 3000 });
  await lockB.acquire(3000);

  // LockA tries to release after expiration (its token no longer matches)
  const releaseResultA = await lockA.release();
  assert.equal(releaseResultA, false, 'Expired holder cannot release lock held by new owner');

  // LockB is still active and valid
  assert.equal(await DistributedLock.isLocked('token_mismatch_resource'), true);

  const releaseResultB = await lockB.release();
  assert.equal(releaseResultB, true, 'Legitimate owner can release lock');
});

test('DistributedLock: withLock Context Wrapper executes callback and auto-cleans', async () => {
  let executed = false;
  const result = await DistributedLock.withLock('scoped_task_lock', 2000, async (lock) => {
    executed = true;
    assert.ok(lock);
    assert.equal(await DistributedLock.isLocked('scoped_task_lock'), true);
    return 'COMPUTE_OK';
  });

  assert.equal(executed, true);
  assert.equal(result, 'COMPUTE_OK');
  assert.equal(await DistributedLock.isLocked('scoped_task_lock'), false, 'withLock should automatically release');
});

test('DistributedLock: listActiveLocks returns active telemetry', async () => {
  const lock = new DistributedLock('telemetry_demo_lock', { ttlMs: 10000 });
  await lock.acquire();

  const active = await DistributedLock.listActiveLocks();
  assert.ok(Array.isArray(active));
  const found = active.find((l) => l.resource === 'telemetry_demo_lock');
  assert.ok(found, 'Active lock should appear in listActiveLocks');
  assert.ok(found.ttlRemainingMs > 0);

  await lock.release();
});

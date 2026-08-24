/**
 * Unit tests for queue shard routing.
 * Verifies that hash(projectId + queueName) % N is deterministic, stable,
 * and distributes reasonably across shards.
 *
 * Run: node --test tests/shard_routing.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Shard routing (mirrors queue.controller.js logic) ────────────────────────
function computeShardId(projectId, queueName, numShards = 4) {
  const key = projectId + queueName;
  const hash = Math.abs(
    key.split('').reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) | 0, 0)
  );
  return hash % numShards;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Shard Routing — Determinism', () => {
  it('always returns the same shard for the same inputs', () => {
    const projectId = 'proj-abc-123';
    const queueName = 'email-notifications';
    const shard1 = computeShardId(projectId, queueName);
    const shard2 = computeShardId(projectId, queueName);
    const shard3 = computeShardId(projectId, queueName);
    assert.equal(shard1, shard2);
    assert.equal(shard2, shard3);
  });

  it('returns different shards for different queues in the same project', () => {
    const projectId = 'proj-xyz';
    const shards = ['queue-a','queue-b','queue-c','queue-d','queue-e'].map(
      name => computeShardId(projectId, name)
    );
    // Not all should be identical (would be very unlucky)
    const unique = new Set(shards);
    assert.ok(unique.size >= 2, `Expected at least 2 distinct shards, got ${unique.size}`);
  });

  it('returns different shards for same queue name in different projects', () => {
    const queueName = 'default';
    const shards = ['proj-1','proj-2','proj-3','proj-4','proj-5'].map(
      id => computeShardId(id, queueName)
    );
    const unique = new Set(shards);
    assert.ok(unique.size >= 2, `Expected at least 2 distinct shards, got ${unique.size}`);
  });
});

describe('Shard Routing — Range', () => {
  it('always returns a shard in [0, N-1]', () => {
    const N = 4;
    const testCases = [
      ['project-1', 'queue-alpha'],
      ['project-2', 'queue-beta'],
      ['project-999', 'my-long-queue-name-with-many-characters'],
      ['', 'empty-project-id'],
      ['proj', ''],
    ];
    for (const [pid, qn] of testCases) {
      const shard = computeShardId(pid, qn, N);
      assert.ok(shard >= 0 && shard < N,
        `Expected shard in [0,${N-1}], got ${shard} for (${pid}, ${qn})`);
    }
  });

  it('works with different shard counts', () => {
    for (const N of [2, 4, 8, 16]) {
      const shard = computeShardId('test-project', 'test-queue', N);
      assert.ok(shard >= 0 && shard < N, `shard ${shard} out of range for N=${N}`);
    }
  });
});

describe('Shard Routing — Distribution', () => {
  it('distributes 100 queues across 4 shards with no shard getting > 60%', () => {
    const N = 4;
    const counts = new Array(N).fill(0);
    for (let i = 0; i < 100; i++) {
      const shard = computeShardId(`proj-${i}`, `queue-${i}`, N);
      counts[shard]++;
    }
    for (let s = 0; s < N; s++) {
      assert.ok(counts[s] < 60, `Shard ${s} got ${counts[s]}/100 — too concentrated`);
    }
  });
});

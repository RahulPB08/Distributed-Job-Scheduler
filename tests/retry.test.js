/**
 * Unit tests for retry backoff math.
 * Tests fixed, linear_backoff, and exponential_backoff strategies.
 *
 * Run: node --test tests/retry.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Backoff computation (mirrors worker/src/retry_handler.js logic) ──────────
function computeDelay(strategy, baseDelay, maxDelay, multiplier, attempt) {
  if (strategy === 'none') return 0;
  if (strategy === 'fixed') return Math.min(baseDelay, maxDelay);
  if (strategy === 'linear_backoff') return Math.min(baseDelay * attempt, maxDelay);
  if (strategy === 'exponential_backoff') {
    const delay = baseDelay * Math.pow(multiplier, attempt - 1);
    return Math.min(delay, maxDelay);
  }
  return baseDelay;
}

function shouldRetry(retryCount, maxRetries) {
  return retryCount < maxRetries;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Retry Strategy — Fixed', () => {
  it('returns the base delay regardless of attempt', () => {
    assert.equal(computeDelay('fixed', 10, 300, 2, 1), 10);
    assert.equal(computeDelay('fixed', 10, 300, 2, 2), 10);
    assert.equal(computeDelay('fixed', 10, 300, 2, 5), 10);
  });

  it('respects maxDelay cap', () => {
    assert.equal(computeDelay('fixed', 500, 300, 2, 1), 300);
  });
});

describe('Retry Strategy — Linear Backoff', () => {
  it('increases linearly per attempt', () => {
    assert.equal(computeDelay('linear_backoff', 5, 300, 2, 1), 5);
    assert.equal(computeDelay('linear_backoff', 5, 300, 2, 2), 10);
    assert.equal(computeDelay('linear_backoff', 5, 300, 2, 3), 15);
    assert.equal(computeDelay('linear_backoff', 5, 300, 2, 10), 50);
  });

  it('respects maxDelay cap', () => {
    assert.equal(computeDelay('linear_backoff', 100, 150, 2, 5), 150);
  });
});

describe('Retry Strategy — Exponential Backoff', () => {
  it('doubles delay each attempt with multiplier=2', () => {
    assert.equal(computeDelay('exponential_backoff', 5, 3600, 2, 1), 5);
    assert.equal(computeDelay('exponential_backoff', 5, 3600, 2, 2), 10);
    assert.equal(computeDelay('exponential_backoff', 5, 3600, 2, 3), 20);
    assert.equal(computeDelay('exponential_backoff', 5, 3600, 2, 4), 40);
  });

  it('respects maxDelay cap', () => {
    const delay = computeDelay('exponential_backoff', 5, 100, 2, 10);
    assert.ok(delay <= 100, `Expected delay <= 100, got ${delay}`);
  });

  it('works with multiplier=3', () => {
    assert.equal(computeDelay('exponential_backoff', 2, 9999, 3, 1), 2);
    assert.equal(computeDelay('exponential_backoff', 2, 9999, 3, 2), 6);
    assert.equal(computeDelay('exponential_backoff', 2, 9999, 3, 3), 18);
  });
});

describe('Retry Strategy — None', () => {
  it('returns 0 delay', () => {
    assert.equal(computeDelay('none', 5, 300, 2, 1), 0);
  });
});

describe('shouldRetry', () => {
  it('returns true when attempts remain', () => {
    assert.equal(shouldRetry(0, 3), true);
    assert.equal(shouldRetry(1, 3), true);
    assert.equal(shouldRetry(2, 3), true);
  });

  it('returns false when max retries reached', () => {
    assert.equal(shouldRetry(3, 3), false);
    assert.equal(shouldRetry(5, 3), false);
  });

  it('returns false when maxRetries is 0', () => {
    assert.equal(shouldRetry(0, 0), false);
  });
});

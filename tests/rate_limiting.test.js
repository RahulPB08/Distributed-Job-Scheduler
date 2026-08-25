import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { createRateLimiter } from '../backend/src/middlewares/rate_limit.middleware.js';

test('Rate Limiting Middleware: Enforces request limits and attaches standard rate limit headers', async () => {
  const app = express();
  const testLimiter = createRateLimiter({
    windowMs: 1000,
    max: 3,
    message: 'Test rate limit exceeded'
  });

  app.get('/test-rate', testLimiter, (req, res) => {
    res.json({ success: true, message: 'allowed' });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Request 1: Allowed
    const res1 = await fetch(`${baseUrl}/test-rate`);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-ratelimit-limit'), '3');
    assert.equal(res1.headers.get('x-ratelimit-remaining'), '2');
    assert.ok(res1.headers.get('x-ratelimit-reset'));

    // Request 2: Allowed
    const res2 = await fetch(`${baseUrl}/test-rate`);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-ratelimit-remaining'), '1');

    // Request 3: Allowed (last one)
    const res3 = await fetch(`${baseUrl}/test-rate`);
    assert.equal(res3.status, 200);
    assert.equal(res3.headers.get('x-ratelimit-remaining'), '0');

    // Request 4: Exceeded -> 429 Too Many Requests
    const res4 = await fetch(`${baseUrl}/test-rate`);
    assert.equal(res4.status, 429);
    assert.ok(res4.headers.get('retry-after'));
    const body4 = await res4.json();
    assert.equal(body4.success, false);
    assert.equal(body4.error.code, 'TOO_MANY_REQUESTS');
    assert.equal(body4.error.message, 'Test rate limit exceeded');
    assert.ok(body4.error.retryAfterSeconds >= 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

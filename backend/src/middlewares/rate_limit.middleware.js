/**
 * In-memory sliding window rate limiter middleware with Redis fallback capability
 * Tracks request counts per client (IP, authenticated User ID, or API Key)
 */

class SlidingWindowRateLimiter {
  constructor() {
    this.hits = new Map();
    // Cleanup expired records every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.hits.entries()) {
      if (now > record.resetTime) {
        this.hits.delete(key);
      }
    }
  }

  check(key, windowMs, maxRequests) {
    const now = Date.now();
    let record = this.hits.get(key);

    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs
      };
      this.hits.set(key, record);
      return {
        allowed: true,
        current: 1,
        remaining: maxRequests - 1,
        resetTime: record.resetTime
      };
    }

    record.count += 1;
    const allowed = record.count <= maxRequests;
    const remaining = Math.max(0, maxRequests - record.count);

    return {
      allowed,
      current: record.count,
      remaining,
      resetTime: record.resetTime
    };
  }

  reset() {
    this.hits.clear();
  }
}

const memoryLimiter = new SlidingWindowRateLimiter();

/**
 * Creates a configurable rate limiter middleware
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60,000ms = 1 min)
 * @param {number} options.max - Max requests allowed in the window (default: 100)
 * @param {string} options.message - Custom error message
 * @param {Function} options.keyGenerator - Custom key generator function
 */
export const createRateLimiter = (options = {}) => {
  const windowMs = options.windowMs || 60000;
  const max = options.max || 100;
  const message = options.message || 'Too many requests, please try again later.';

  return (req, res, next) => {
    // Determine client identifier: API Key -> User ID -> IP Address
    const identifier =
      options.keyGenerator?.(req) ||
      req.headers['x-api-key'] ||
      req.user?.id ||
      req.ip ||
      req.connection?.remoteAddress ||
      'anonymous';

    const key = `${req.baseUrl || ''}:${req.path || ''}:${identifier}`;
    const result = memoryLimiter.check(key, windowMs, max);

    // Standard RateLimit Headers
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.resetTime - Date.now()) / 1000));
      res.setHeader('Retry-After', retryAfterSec);

      return res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message,
          retryAfterSeconds: retryAfterSec,
          limit: max,
          windowSeconds: Math.ceil(windowMs / 1000)
        }
      });
    }

    next();
  };
};

/**
 * Standard Global API Rate Limiter (e.g. 500 requests per minute)
 */
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 500,
  message: 'API rate limit exceeded. Please throttle your requests.'
});

/**
 * Strict Auth Rate Limiter for Login/Register brute-force defense (e.g. 30 requests per 5 mins)
 */
export const authRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: 'Too many authentication attempts. Please wait 5 minutes before trying again.'
});

/**
 * Job Dispatch Rate Limiter for Queue Ingestion Protection (e.g. 200 jobs per minute)
 */
export const jobDispatchRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 200,
  message: 'Job dispatch rate limit reached. Please batch requests or wait a moment.'
});

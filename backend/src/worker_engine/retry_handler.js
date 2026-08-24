export class RetryHandler {
  /**
   * Calculates the delay in seconds for the next retry attempt
   */
  static calculateDelay(strategy, attempt, baseDelay = 5, maxDelay = 300, multiplier = 2.0) {
    if (strategy === 'none') {
      return 0;
    }

    let delaySeconds = baseDelay;

    if (strategy === 'fixed') {
      delaySeconds = baseDelay;
    } else if (strategy === 'linear_backoff') {
      delaySeconds = baseDelay * attempt;
    } else if (strategy === 'exponential_backoff') {
      // Full jitter exponential backoff: baseDelay * (multiplier ^ (attempt - 1)) + jitter
      const rawDelay = baseDelay * Math.pow(multiplier, attempt - 1);
      const jitter = Math.random() * (baseDelay * 0.5);
      delaySeconds = Math.round(rawDelay + jitter);
    }

    return Math.min(Math.max(1, delaySeconds), maxDelay);
  }

  /**
   * Evaluates retry status and computes next run date
   */
  static evaluateRetry(job) {
    const nextAttempt = (job.retry_count || 0) + 1;
    const maxRetries = job.max_retries !== undefined ? job.max_retries : 3;

    if (nextAttempt >= maxRetries) {
      return {
        shouldRetry: false,
        attempt: nextAttempt,
        maxRetries,
        reason: `Exhausted all ${maxRetries} retry attempts`
      };
    }

    const strategy = job.retry_strategy || 'exponential_backoff';
    const baseDelay = job.retry_base_delay || 5;
    const maxDelay = job.retry_max_delay || 300;

    const delaySeconds = this.calculateDelay(strategy, nextAttempt, baseDelay, maxDelay);
    const nextScheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

    return {
      shouldRetry: true,
      attempt: nextAttempt,
      maxRetries,
      strategy,
      delaySeconds,
      nextScheduledAt
    };
  }
}

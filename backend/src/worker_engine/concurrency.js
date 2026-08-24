export class ConcurrencyController {
  constructor(limit = 5) {
    this.limit = limit;
    this.activeCount = 0;
    this.activeJobs = new Map(); // jobId -> metadata
  }

  canAcceptJob() {
    return this.activeCount < this.limit;
  }

  getAvailableSlots() {
    return Math.max(0, this.limit - this.activeCount);
  }

  acquireSlot(jobId, jobData = {}) {
    if (!this.canAcceptJob()) {
      throw new Error(`Worker concurrency limit (${this.limit}) exceeded`);
    }
    this.activeCount++;
    this.activeJobs.set(jobId, {
      ...jobData,
      acquiredAt: new Date().toISOString()
    });
    return this.activeCount;
  }

  releaseSlot(jobId) {
    if (this.activeJobs.has(jobId)) {
      this.activeJobs.delete(jobId);
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
    return this.activeCount;
  }

  getActiveCount() {
    return this.activeCount;
  }

  getLimit() {
    return this.limit;
  }
}

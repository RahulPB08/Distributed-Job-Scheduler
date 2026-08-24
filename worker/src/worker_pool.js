import { WorkerInstance } from './worker.js';
import { CheckpointLogger } from './checkpoint_logger.js';

export class WorkerPoolManager {
  constructor() {
    this.workers = new Map();
    this.db = null;
    this.defaultOptions = {};
  }

  init(defaultOptions = {}, db = null) {
    this.defaultOptions = defaultOptions;
    this.db = db;
  }

  /**
   * Deploys a new WorkerInstance or reuses a warm hibernated standby worker from the pool
   * @param {Object} options { workerId, concurrency, queues, pollInterval, projectId }
   */
  async deployWorker(options = {}) {
    // 1. Check if an existing worker is in standby hibernation and can be reused
    for (const [id, worker] of this.workers.entries()) {
      if (!worker.isRunning && !worker.isShuttingDown) {
        await worker.resume();
        CheckpointLogger.info(
          `[WORKER_DEPLOYMENT_API] ♻️ Reused warm standby worker node [${id}] (Active Fleet: ${this.getActiveFleetCount()}/${this.workers.size})`
        );
        return {
          workerId: id,
          reused: true,
          status: 'healthy',
          activeFleetSize: this.getActiveFleetCount()
        };
      }
    }

    // 2. Otherwise create a new worker instance in the pool
    const index = this.workers.size + 1;
    const workerId =
      options.workerId ||
      `worker-pool-${String(index).padStart(2, '0')}-${Math.floor(Math.random() * 900 + 100)}`;
    const concurrency = parseInt(options.concurrency || this.defaultOptions.concurrency || '5', 10);
    const pollInterval = parseInt(options.pollInterval || this.defaultOptions.pollInterval || '150', 10);

    const worker = new WorkerInstance({
      workerId,
      concurrency,
      pollInterval,
      queues: options.queues || this.defaultOptions.queues || '',
      projectId: options.projectId || this.defaultOptions.projectId || null,
      db: this.db
    });

    await worker.start();
    this.workers.set(workerId, worker);

    CheckpointLogger.info(
      `[WORKER_DEPLOYMENT_API] 🚀 Deployed worker node [${workerId}] (Concurrency: ${concurrency} slots, Active Fleet: ${this.getActiveFleetCount()})`
    );

    return {
      workerId,
      reused: false,
      concurrencyLimit: concurrency,
      pollIntervalMs: pollInterval,
      status: 'healthy',
      startedAt: new Date().toISOString(),
      activeFleetSize: this.getActiveFleetCount()
    };
  }

  /**
   * Gracefully hibernates a worker into standby mode for instant reuse,
   * or permanently shuts down if permanent = true.
   * @param {string} workerId
   * @param {boolean} permanent
   */
  async drainWorker(workerId, permanent = false) {
    // Always preserve at least 1 active baseline worker
    if (this.getActiveFleetCount() <= 1 && !permanent) {
      return {
        success: true,
        message: 'Minimum baseline worker retained in fleet',
        activeFleetSize: this.getActiveFleetCount()
      };
    }

    let targetWorker = null;
    let targetId = workerId;

    if (!targetId) {
      // Pick the last running dynamic worker to hibernate
      for (const [id, w] of Array.from(this.workers.entries()).reverse()) {
        if (w.isRunning) {
          targetId = id;
          targetWorker = w;
          break;
        }
      }
    } else {
      targetWorker = this.workers.get(targetId);
    }

    if (!targetWorker) {
      return { success: true, message: `Worker node [${targetId || 'unknown'}] not active` };
    }

    try {
      if (permanent) {
        await targetWorker.shutdown();
        this.workers.delete(targetId);
        if (this.db) {
          this.db.run("DELETE FROM workers WHERE id = ?", [targetId], () => {});
          this.db.run("DELETE FROM worker_heartbeats WHERE worker_id = ?", [targetId], () => {});
        }
        CheckpointLogger.warn(`[WORKER_DEPLOYMENT_API] 🔻 Permanently terminated worker [${targetId}]`);
      } else {
        await targetWorker.hibernate();
        CheckpointLogger.warn(`[WORKER_DEPLOYMENT_API] ⏸ Worker [${targetId}] hibernated to standby (warm & ready to reuse)`);
      }

      return {
        success: true,
        drainedWorkerId: targetId,
        hibernated: !permanent,
        activeFleetSize: this.getActiveFleetCount()
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  getActiveFleetCount() {
    let count = 0;
    for (const w of this.workers.values()) {
      if (w.isRunning) count++;
    }
    return count;
  }

  /**
   * Scales the worker pool to a target count
   * @param {number} targetCount
   */
  async scaleTo(targetCount) {
    const current = this.workers.size;
    const target = Math.max(1, parseInt(targetCount, 10));

    if (target > current) {
      const needed = target - current;
      const spawned = [];
      for (let i = 0; i < needed; i++) {
        const res = await this.deployWorker();
        spawned.push(res.workerId);
      }
      return { action: 'SCALE_UP', count: needed, spawned, fleetSize: this.workers.size };
    } else if (target < current) {
      const toRemove = current - target;
      const drained = [];
      for (let i = 0; i < toRemove; i++) {
        const res = await this.drainWorker();
        if (res.drainedWorkerId) drained.push(res.drainedWorkerId);
      }
      return { action: 'SCALE_DOWN', count: toRemove, drained, fleetSize: this.workers.size };
    }

    return { action: 'NOOP', fleetSize: current };
  }

  /**
   * Returns telemetry for all workers in this pool
   */
  getFleetStatus() {
    const list = [];
    for (const [id, w] of this.workers.entries()) {
      list.push({
        id,
        status: w.isRunning ? 'healthy' : 'stopping',
        concurrencyLimit: w.concurrencyLimit,
        activeJobs: w.concurrencyController?.getActiveCount() || 0,
        availableSlots: w.concurrencyController?.getAvailableSlots() || 0
      });
    }
    return {
      fleetSize: this.workers.size,
      workers: list
    };
  }

  /**
   * Gracefully shuts down all workers in pool
   */
  async shutdownAll() {
    const shutdowns = [];
    for (const [id, w] of this.workers.entries()) {
      shutdowns.push(w.shutdown().catch(() => { }));
    }
    await Promise.all(shutdowns);
    this.workers.clear();
  }
}

export const workerPool = new WorkerPoolManager();

import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { CheckpointLogger } from './checkpoint_logger.js';

export class HeartbeatReporter {
  constructor(workerId, db, concurrencyController, intervalMs = 5000) {
    this.workerId = workerId;
    this.db = db;
    this.concurrencyController = concurrencyController;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.isRunning = false;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();
  }

  start() {
    this.isRunning = true;
    this.sendHeartbeat();
    this.timer = setInterval(() => this.sendHeartbeat(), this.intervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sendHeartbeat() {
    if (!this.isRunning) return;

    try {
      const now = new Date().toISOString();
      const mem = process.memoryUsage();
      const rssMb = parseFloat((mem.rss / (1024 * 1024)).toFixed(2));
      const heapMb = parseFloat((mem.heapUsed / (1024 * 1024)).toFixed(2));

      // Calculate approximate CPU %
      const currentCpu = process.cpuUsage(this.lastCpuUsage);
      const currentTime = Date.now();
      const timeDeltaMs = currentTime - this.lastCpuTime;
      const totalCpuMs = (currentCpu.user + currentCpu.system) / 1000;
      const cpuPercent = timeDeltaMs > 0 ? parseFloat(Math.min(100, (totalCpuMs / timeDeltaMs) * 100).toFixed(1)) : 0.0;

      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuTime = currentTime;

      const activeCount = this.concurrencyController.getActiveCount();
      const limit = this.concurrencyController.getLimit();

      // Insert heartbeat metric entry
      const heartbeatId = uuidv4();
      await new Promise((resolve) => {
        this.db.run(
          `INSERT INTO worker_heartbeats (id, worker_id, active_jobs_count, cpu_percent, memory_rss_mb, memory_heap_mb, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [heartbeatId, this.workerId, activeCount, cpuPercent, rssMb, heapMb, now],
          () => resolve()
        );
      });

      // Update worker node status
      await new Promise((resolve) => {
        this.db.run(
          `UPDATE workers SET
             active_jobs_count = ?,
             last_heartbeat_at = ?,
             status = 'healthy'
           WHERE id = ?`,
          [activeCount, now, this.workerId],
          () => resolve()
        );
      });

      CheckpointLogger.heartbeat(this.workerId, activeCount, limit, cpuPercent, rssMb);
    } catch (err) {
      CheckpointLogger.warn(`Heartbeat emission warning for ${this.workerId}: ${err.message}`);
    }
  }
}

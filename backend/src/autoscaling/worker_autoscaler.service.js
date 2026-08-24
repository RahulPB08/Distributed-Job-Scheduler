/**
 * Distributed Job Scheduler — Workload-Aware Worker Auto-Scaler Service
 *
 * Design Principles:
 * ─────────────────────────────────────────
 * 1. PER-PROJECT workers: Each project gets a minimum of 2 dedicated workers.
 *    - Workers are spawned with --project-id so they only consume that project's queues.
 *    - Scale-Up: Fast trigger when a project's job backlog surges.
 *    - Scale-Down: Graceful drain when project queues are empty for cooldown period.
 * 2. GLOBAL CAP: System-wide max of 15 total workers across all projects.
 * 3. SCHEDULER: Single authoritative scheduler instance (no scaling).
 * 4. Clear terminal checkpoints and real-time WebSocket events.
 */

import { run, get, all } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';

export class WorkerAutoScalerService {
  static config = {
    enabled: true,
    minWorkers: 2,
    maxWorkers: 15,
    minWorkersPerProject: 2,         // Minimum 2 workers per project
    maxWorkersTotal: 15,             // Global cap across all projects
    jobsPerWorkerThreshold: 8,       // Jobs per worker before scaling up
    scaleUpCooldownSec: 3,           // Seconds between scale-up events per project
    scaleDownCooldownSec: 12,        // Seconds of idle before scaling down
    scaleUpHysteresis: 1,            // Number of consecutive ticks before scale-up
    cpuScaleUpPercent: 80,           // CPU usage threshold for scale-up
    checkIntervalMs: 2000            // Evaluate fleet every 2 seconds
  };

  static state = {
    isRunning: false,
    timer: null,
    // Per-project tracking: projectId → { workers: Set<workerId>, lastScaleUp, lastScaleDown }
    projectWorkers: new Map(),
    // Global spawned process tracking
    spawnedWorkerProcesses: new Map(),  // workerId → { projectId, spawnedAt, deployedViaApi }
    lastScaleAction: 'FLEET_OPTIMIZED',
    lastScaleTime: new Date().toISOString(),
    telemetryHistory: [],
    scaleEvents: []
  };

  static getConfig() {
    return { ...this.config };
  }

  static updateConfig(newConfig = {}) {
    this.config = {
      ...this.config,
      ...newConfig,
      minWorkersPerProject: Math.max(1, parseInt(newConfig.minWorkersPerProject ?? newConfig.minWorkers ?? this.config.minWorkersPerProject, 10)),
      maxWorkersTotal: Math.max(2, parseInt(newConfig.maxWorkersTotal ?? newConfig.maxWorkers ?? this.config.maxWorkersTotal, 10)),
      jobsPerWorkerThreshold: Math.max(1, parseInt(newConfig.jobsPerWorkerThreshold ?? this.config.jobsPerWorkerThreshold, 10)),
      minWorkers: Math.max(1, parseInt(newConfig.minWorkers ?? newConfig.minWorkersPerProject ?? this.config.minWorkers, 10)),
      maxWorkers: Math.max(2, parseInt(newConfig.maxWorkers ?? newConfig.maxWorkersTotal ?? this.config.maxWorkers, 10))
    };
    return this.getConfig();
  }

  static start() {
    if (this.state.isRunning) return;
    this.state.isRunning = true;
    this.state.timer = setInterval(() => this.evaluateFleetCapacity(), this.config.checkIntervalMs);
    console.log(`[WORKER_AUTOSCALER] ⚡ Per-project worker autoscaler started (Min: ${this.config.minWorkersPerProject}/project, GlobalMax: ${this.config.maxWorkersTotal})`);
  }

  static stop() {
    this.state.isRunning = false;
    if (this.state.timer) {
      clearInterval(this.state.timer);
      this.state.timer = null;
    }
  }

  /**
   * Main Auto-Scaling Evaluation Cycle
   * Runs per-project logic for every active project.
   */
  static async evaluateFleetCapacity() {
    if (!this.config.enabled) return;

    try {
      const now = Date.now();
      const nowIso = new Date().toISOString();
      const heartbeatCutoff = new Date(now - 15000).toISOString();

      // ── 1. Gather global fleet state ──────────────────────────────────────
      const allActiveWorkers = await all(
        `SELECT id, concurrency_limit, active_jobs_count, status
         FROM workers
         WHERE status IN ('healthy', 'degraded') AND last_heartbeat_at >= ?`,
        [heartbeatCutoff]
      );
      const totalActiveWorkers = allActiveWorkers.length;
      const totalCapacity = allActiveWorkers.reduce((s, w) => s + (w.concurrency_limit || 5), 0);
      const activeSlots = allActiveWorkers.reduce((s, w) => s + (w.active_jobs_count || 0), 0);
      const utilPct = totalCapacity > 0 ? Math.round((activeSlots / totalCapacity) * 100) : 0;

      // ── 2. Per-project evaluation ─────────────────────────────────────────
      const projects = await all('SELECT id, name FROM projects');
      let totalDesired = 0;
      let totalSpawnedThisCycle = 0;
      let totalDrainedThisCycle = 0;

      for (const project of projects) {
        const projectId = project.id;

        // Initialize per-project state if needed
        if (!this.state.projectWorkers.has(projectId)) {
          this.state.projectWorkers.set(projectId, {
            lastScaleUpAt: 0,
            lastScaleDownAt: 0
          });
        }
        const projState = this.state.projectWorkers.get(projectId);

        // Count workers assigned to this project (tracked via DB project_id assignment or spawned map)
        const projectWorkerIds = new Set();
        for (const [wId, info] of this.state.spawnedWorkerProcesses.entries()) {
          if (info.projectId === projectId) projectWorkerIds.add(wId);
        }
        // Also count DB workers that have jobs running for this project
        const projectActiveWorkers = await all(
          `SELECT DISTINCT w.id
           FROM workers w
           JOIN jobs j ON j.worker_id = w.id
           WHERE j.project_id = ? AND j.status IN ('running', 'claimed')
           AND w.last_heartbeat_at >= ?`,
          [projectId, heartbeatCutoff]
        );
        projectActiveWorkers.forEach(w => projectWorkerIds.add(w.id));

        const currentProjectWorkerCount = Math.max(
          projectWorkerIds.size,
          // Count from spawnedWorkerProcesses for this project
          Array.from(this.state.spawnedWorkerProcesses.values()).filter(v => v.projectId === projectId).length
        );

        // Count queued jobs for this project
        const queuedRes = await get(
          `SELECT COUNT(*) as total FROM jobs j
           WHERE j.project_id = ? AND j.status = 'queued'`,
          [projectId]
        );
        const runningRes = await get(
          `SELECT COUNT(*) as total FROM jobs j
           WHERE j.project_id = ? AND j.status IN ('running', 'claimed')`,
          [projectId]
        );
        const queuedJobs = queuedRes?.total || 0;
        const runningJobs = runningRes?.total || 0;

        // Desired workers for this project
        let desiredForProject = this.config.minWorkersPerProject;
        if (queuedJobs > 0) {
          desiredForProject = Math.max(
            this.config.minWorkersPerProject,
            Math.ceil(queuedJobs / this.config.jobsPerWorkerThreshold)
          );
        }
        totalDesired += desiredForProject;

        // ── 3. Scale-Up per project ───────────────────────────────────────
        const scaledUpSince = (now - projState.lastScaleUpAt) / 1000;
        const needsScaleUp = currentProjectWorkerCount < desiredForProject && queuedJobs > 0;

        if (needsScaleUp && scaledUpSince >= this.config.scaleUpCooldownSec && totalActiveWorkers < this.config.maxWorkersTotal) {
          const toSpawn = Math.min(
            desiredForProject - currentProjectWorkerCount,
            this.config.maxWorkersTotal - totalActiveWorkers,
            3 // max 3 per cycle per project
          );

          for (let i = 0; i < toSpawn; i++) {
            if (totalActiveWorkers + totalSpawnedThisCycle >= this.config.maxWorkersTotal) break;
            await this.spawnProjectWorker(projectId);
            totalSpawnedThisCycle++;
          }

          if (toSpawn > 0) {
            projState.lastScaleUpAt = now;
            const msg = `[WORKER_AUTOSCALER] 🚀 SCALE_UP [${project.name}]: +${toSpawn} workers (Backlog: ${queuedJobs})`;
            console.log(`\x1b[32m${msg}\x1b[0m`);

            const event = { action: 'SCALE_UP', projectId, projectName: project.name, addedWorkers: toSpawn, queuedJobs, runningJobs, timestamp: nowIso };
            this._recordScaleEvent(event);
            try { await QueueManager.publishEvent('AUTOSCALE_EVENT', event); } catch (_) {}
          }

        // ── 4. Scale-Down per project ─────────────────────────────────────
        } else if (currentProjectWorkerCount > this.config.minWorkersPerProject && queuedJobs === 0 && runningJobs === 0) {
          const scaledDownSince = (now - projState.lastScaleDownAt) / 1000;

          if (scaledDownSince >= this.config.scaleDownCooldownSec) {
            // Find a dynamic worker for this project to drain
            const dynamicWorkerIds = Array.from(this.state.spawnedWorkerProcesses.entries())
              .filter(([, info]) => info.projectId === projectId)
              .map(([id]) => id);

            if (dynamicWorkerIds.length > 0) {
              const toTerminate = Math.min(dynamicWorkerIds.length, currentProjectWorkerCount - this.config.minWorkersPerProject);

              for (let i = 0; i < toTerminate; i++) {
                const workerId = dynamicWorkerIds[i];
                const workerRecord = allActiveWorkers.find(w => w.id === workerId);
                if (!workerRecord || workerRecord.active_jobs_count === 0) {
                  await this._terminateDynamicWorker(workerId);
                  this.state.spawnedWorkerProcesses.delete(workerId);
                  totalDrainedThisCycle++;
                }
              }

              if (totalDrainedThisCycle > 0) {
                projState.lastScaleDownAt = now;
                const msg = `[WORKER_AUTOSCALER] 🔻 SCALE_DOWN [${project.name}]: -${toTerminate} surplus workers (Fleet idle)`;
                console.log(`\x1b[35m${msg}\x1b[0m`);
                const event = { action: 'SCALE_DOWN', projectId, projectName: project.name, removedWorkers: toTerminate, timestamp: nowIso };
                this._recordScaleEvent(event);
                try { await QueueManager.publishEvent('AUTOSCALE_EVENT', event); } catch (_) {}
              }
            }
          }
        }

        // ── 5. Ensure baseline: spawn missing project workers ─────────────
        // If this project has fewer than minWorkersPerProject spawned, spin them up
        const spawnedForProject = Array.from(this.state.spawnedWorkerProcesses.values())
          .filter(v => v.projectId === projectId).length;

        if (spawnedForProject < this.config.minWorkersPerProject && totalActiveWorkers + totalSpawnedThisCycle < this.config.maxWorkersTotal) {
          const needed = this.config.minWorkersPerProject - spawnedForProject;
          for (let i = 0; i < needed; i++) {
            if (totalActiveWorkers + totalSpawnedThisCycle >= this.config.maxWorkersTotal) break;
            await this.spawnProjectWorker(projectId);
            totalSpawnedThisCycle++;
          }
        }
      }

      // ── 6. Telemetry Snapshot ───────────────────────────────────────────
      const queuedRes = await get("SELECT COUNT(*) as total FROM jobs WHERE status = 'queued'");
      const runningRes = await get("SELECT COUNT(*) as total FROM jobs WHERE status IN ('running', 'claimed')");
      const snapshot = {
        time: new Date().toLocaleTimeString(),
        timestamp: nowIso,
        activeWorkers: totalActiveWorkers + totalSpawnedThisCycle,
        dynamicWorkers: this.state.spawnedWorkerProcesses.size,
        activeSchedulers: 1,
        queuedJobs: queuedRes?.total || 0,
        runningJobs: runningRes?.total || 0,
        totalCapacity,
        activeSlots,
        utilPct,
        desiredWorkers: totalDesired
      };
      this.state.telemetryHistory.push(snapshot);
      if (this.state.telemetryHistory.length > 30) this.state.telemetryHistory.shift();

      if (totalSpawnedThisCycle > 0 || totalDrainedThisCycle > 0) {
        this.state.lastScaleAction = totalSpawnedThisCycle > 0
          ? `SCALE_UP: +${totalSpawnedThisCycle} workers`
          : `SCALE_DOWN: -${totalDrainedThisCycle} workers`;
        this.state.lastScaleTime = nowIso;
      }

    } catch (err) {
      console.error('[WORKER_AUTOSCALER] Evaluation error:', err.message);
    }
  }

  static _recordScaleEvent(event) {
    this.state.scaleEvents.push(event);
    while (this.state.scaleEvents.length > 20) {
      this.state.scaleEvents.shift();
    }
  }

  /**
   * Spawns a dynamic worker node pinned to a specific project via --project-id.
   */
  static async spawnProjectWorker(projectId, concurrency = 5) {
    const workerId = `worker-proj-${projectId.slice(0, 6)}-${Date.now().toString().slice(-4)}-${Math.floor(Math.random() * 900 + 100)}`;
    const workerApiUrl = process.env.WORKER_API_URL || 'http://127.0.0.1:5001';

    try {
      let deployed = false;

      // Try remote worker deployment API (worker service running on port 5001)
      try {
        const response = await fetch(`${workerApiUrl}/workers/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workerId, concurrency, pollInterval: 150, projectId })
        });
        if (response.ok) {
          deployed = true;
          this.state.spawnedWorkerProcesses.set(workerId, { workerId, projectId, deployedViaApi: true, spawnedAt: Date.now() });
        }
      } catch (_) {}

      // Fallback: in-memory worker pool
      if (!deployed) {
        try {
          const { workerPool } = await import('../../../worker/src/worker_pool.js');
          await workerPool.deployWorker({ workerId, concurrency, pollInterval: 150, projectId });
          this.state.spawnedWorkerProcesses.set(workerId, { workerId, projectId, inMemory: true, spawnedAt: Date.now() });
          deployed = true;
        } catch (_) {}
      }

      if (deployed) {
        try {
          QueueManager.publishEvent('WORKER_SPAWNED', {
            workerId,
            projectId,
            concurrency,
            message: `⚡ Project worker [${workerId}] deployed for project [${projectId}]`
          });
        } catch (_) {}
      }

      return workerId;
    } catch (e) {
      console.error(`[WORKER_AUTOSCALER] Failed to spawn project worker: ${e.message}`);
      return null;
    }
  }

  /**
   * Legacy method for non-project-aware spawning (kept for compat).
   */
  static async spawnDynamicWorker(concurrency = 5) {
    return this.spawnProjectWorker(null, concurrency);
  }

  /**
   * Gracefully drains and permanently shuts down a surplus worker.
   */
  static async _terminateDynamicWorker(workerId) {
    const workerApiUrl = process.env.WORKER_API_URL || 'http://127.0.0.1:5001';
    try {
      await run("UPDATE workers SET status = 'stopped' WHERE id = ?", [workerId]);
      await run('DELETE FROM workers WHERE id = ?', [workerId]);
      await run('DELETE FROM worker_heartbeats WHERE worker_id = ?', [workerId]);

      try {
        await fetch(`${workerApiUrl}/workers/shutdown`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workerId })
        });
      } catch (_) {
        try {
          const { workerPool } = await import('../../../worker/src/worker_pool.js');
          await workerPool.drainWorker(workerId, true);
        } catch (_) {}
      }

      try {
        QueueManager.publishEvent('WORKER_DRAINED', {
          workerId,
          message: `Worker node [${workerId}] gracefully shut down`
        });
      } catch (_) {}
    } catch (e) {
      console.error(`[WORKER_AUTOSCALER] Failed to terminate worker ${workerId}:`, e.message);
    }
  }

  /**
   * Returns complete fleet metrics for dashboard and API.
   */
  static async getFleetMetrics() {
    const heartbeatCutoff = new Date(Date.now() - 15000).toISOString();
    const activeWorkers = await all(
      `SELECT id, concurrency_limit, active_jobs_count, status, hostname, ip_address, started_at, last_heartbeat_at
       FROM workers WHERE status IN ('healthy', 'degraded') AND last_heartbeat_at >= ?`,
      [heartbeatCutoff]
    );

    const totalCapacity = activeWorkers.reduce((s, w) => s + (w.concurrency_limit || 5), 0);
    const activeSlots = activeWorkers.reduce((s, w) => s + (w.active_jobs_count || 0), 0);

    const queuedRes = await get("SELECT COUNT(*) as count FROM jobs WHERE status = 'queued'");
    const runningRes = await get("SELECT COUNT(*) as count FROM jobs WHERE status IN ('running','claimed')");

    // Per-project breakdown
    const projectBreakdown = [];
    for (const [projectId, state] of this.state.projectWorkers.entries()) {
      const projWorkers = Array.from(this.state.spawnedWorkerProcesses.values())
        .filter(v => v.projectId === projectId);
      projectBreakdown.push({ projectId, workerCount: projWorkers.length });
    }

    return {
      config: {
        ...this.getConfig(),
        // Legacy compat fields
        minWorkers: this.config.minWorkersPerProject,
        maxWorkers: this.config.maxWorkersTotal
      },
      activeWorkersCount: activeWorkers.length,
      dynamicWorkersCount: this.state.spawnedWorkerProcesses.size,
      activeSchedulersCount: 1,
      schedulerMode: 'SINGLE_SCHEDULER',
      queuedJobs: queuedRes?.count || 0,
      runningJobs: runningRes?.count || 0,
      totalCapacitySlots: totalCapacity,
      activeUsedSlots: activeSlots,
      capacityUtilizationPercent: totalCapacity > 0 ? Math.round((activeSlots / totalCapacity) * 100) : 0,
      lastScaleAction: this.state.lastScaleAction,
      lastScaleTime: this.state.lastScaleTime,
      scaleUpCooldownRemainingSec: 0,
      scaleDownCooldownRemainingSec: 0,
      telemetryHistory: this.state.telemetryHistory,
      scaleEvents: this.state.scaleEvents,
      perProjectBreakdown: projectBreakdown,
      workers: activeWorkers
    };
  }
}

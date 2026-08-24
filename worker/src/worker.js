import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { ConcurrencyController } from './concurrency.js';
import { GlobalQueueConcurrencyController } from './queue_concurrency.js';
import { HeartbeatReporter } from './heartbeat.js';
import { RetryHandler } from './retry_handler.js';
import { DlqHandler } from './dlq_handler.js';
import { CheckpointLogger } from './checkpoint_logger.js';
import { HttpExecutionService } from './services/http_execution_service.js';
import { DatabaseExecutionService } from './services/database_execution_service.js';
import { CpuComputeService } from './services/cpu_compute_service.js';
import { NotificationExecutionService } from './services/notification_execution_service.js';
import { ScriptExecutionService } from './services/script_execution_service.js';

export class WorkerInstance {
  constructor(options = {}) {
    this.workerId = options.workerId || `worker-${uuidv4().slice(0, 8)}`;
    this.concurrencyLimit = parseInt(options.concurrency || '5', 10);
    this.pollIntervalMs = parseInt(options.pollInterval || '1000', 10);
    this.assignedQueues = options.queues ? options.queues.split(',').map((q) => q.trim()).filter(Boolean) : [];
    this.projectId = options.projectId || null;
    this.db = options.db;

    this.concurrencyController = new ConcurrencyController(this.concurrencyLimit);
    this.heartbeatReporter = new HeartbeatReporter(
      this.workerId,
      this.db,
      this.concurrencyController,
      5000
    );

    this.isRunning = false;
    this.isShuttingDown = false;
    this.pollTimer = null;
    this.inFlightJobs = new Set();
  }

  async start() {
    CheckpointLogger.init(this.db);
    CheckpointLogger.header(`Starting Distributed Worker Engine [${this.workerId}]`);

    // [CHECKPOINT 1/6: WORKER_STARTUP]
    CheckpointLogger.checkpoint(1, 6, 'WORKER_STARTUP', {
      workerId: this.workerId,
      hostname: os.hostname(),
      processPid: process.pid,
      concurrencyLimit: this.concurrencyLimit,
      pollIntervalMs: this.pollIntervalMs,
      assignedQueues: this.assignedQueues.length > 0 ? this.assignedQueues.join(', ') : 'ALL (Dynamic Auto-Discovery)',
      projectFilter: this.projectId || 'ALL_PROJECTS'
    });

    // [CHECKPOINT 2/6: WORKER_REGISTRATION]
    await this.registerWorker();
    this.heartbeatReporter.start();
    CheckpointLogger.checkpoint(2, 6, 'WORKER_REGISTRATION', {
      status: 'HEALTHY',
      heartbeatInterval: '5000ms',
      registrationTime: new Date().toISOString()
    });

    this.isRunning = true;
    this.scheduleNextPoll();
  }

  /**
   * Puts worker into warm standby hibernation.
   * Stops polling but keeps instance alive in memory for instant reuse.
   */
  async hibernate() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.db) {
      const now = new Date().toISOString();
      await new Promise((resolve) => {
        this.db.run(
          "UPDATE workers SET status = 'standby', active_jobs_count = 0, updated_at = ? WHERE id = ?",
          [now, this.workerId],
          () => resolve()
        );
      });
    }
    CheckpointLogger.warn(`[WARM_POOL] Worker node [${this.workerId}] entered STANDBY hibernation (warm & reusable)`);
  }

  /**
   * Resumes worker from standby hibernation to active polling immediately.
   */
  async resume() {
    if (this.isRunning) return;
    this.isShuttingDown = false;
    this.isRunning = true;
    if (this.db) {
      const now = new Date().toISOString();
      await new Promise((resolve) => {
        this.db.run(
          "UPDATE workers SET status = 'healthy', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
          [now, now, this.workerId],
          () => resolve()
        );
      });
    }
    this.scheduleNextPoll();
    CheckpointLogger.success(`[WARM_POOL] ⚡ Worker node [${this.workerId}] WOKE UP from standby -> ACTIVE`);
  }

  async registerWorker() {
    const hostname = os.hostname();
    const networkInterfaces = os.networkInterfaces();
    let ipAddress = '127.0.0.1';

    for (const name of Object.keys(networkInterfaces)) {
      for (const net of networkInterfaces[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          ipAddress = net.address;
          break;
        }
      }
    }

    const now = new Date().toISOString();

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO workers (
          id, hostname, ip_address, concurrency_limit, active_jobs_count,
          status, total_jobs_processed, failed_jobs_count, started_at, last_heartbeat_at
        ) VALUES (?, ?, ?, ?, 0, 'healthy', 0, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          hostname = excluded.hostname,
          ip_address = excluded.ip_address,
          concurrency_limit = excluded.concurrency_limit,
          status = 'healthy',
          last_heartbeat_at = excluded.last_heartbeat_at`,
        [this.workerId, hostname, ipAddress, this.concurrencyLimit, now, now],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });
  }

  scheduleNextPoll() {
    if (!this.isRunning || this.isShuttingDown) return;
    this.pollTimer = setTimeout(async () => {
      await this.pollAndExecute();
      this.scheduleNextPoll();
    }, this.pollIntervalMs);
  }

  async pollAndExecute() {
    if (!this.concurrencyController.canAcceptJob() || this.isShuttingDown) {
      return;
    }

    try {
      // [CHECKPOINT 3/6: QUEUE_DISCOVERY]
      const queues = await this.discoverQueues();
      if (!queues || queues.length === 0) {
        return;
      }

      // Log discovered queues periodically (every 10s or when queues change)
      if (!this._lastQueueLog || Date.now() - this._lastQueueLog > 15000) {
        CheckpointLogger.checkpoint(3, 6, 'QUEUE_DISCOVERY', {
          totalQueuesFound: queues.length,
          activeQueues: queues.filter((q) => !q.is_paused).map((q) => `${q.name} (prio: ${q.priority})`).join(', ')
        });
        CheckpointLogger.queueDiscoveryTable(queues);
        this._lastQueueLog = Date.now();
      }

      // ─────────────────────────────────────────────────────────────────────────────
      // SERVICE QUEUE SPECIALIZATION + DYNAMIC WORK-STEALING:
      // 1. If worker has an assigned/primary service queue, poll that queue first.
      // 2. If primary queue is empty / has no jobs, dynamically work-steal from
      //    any other busy queues in priority order so no worker sits idle.
      // ─────────────────────────────────────────────────────────────────────────────
      const activeQueues = queues.filter((q) => !q.is_paused);
      activeQueues.sort((a, b) => {
        const isAPrimary = this.assignedQueues.length > 0 && (this.assignedQueues.includes(a.name) || this.assignedQueues.includes(a.id));
        const isBPrimary = this.assignedQueues.length > 0 && (this.assignedQueues.includes(b.name) || this.assignedQueues.includes(b.id));

        if (isAPrimary && !isBPrimary) return -1;
        if (!isAPrimary && isBPrimary) return 1;

        return (b.priority || 10) - (a.priority || 10);
      });

      for (const queue of activeQueues) {
        if (!this.concurrencyController.canAcceptJob() || this.isShuttingDown) {
          break;
        }

        const isPrimary = this.assignedQueues.length === 0 || this.assignedQueues.includes(queue.name) || this.assignedQueues.includes(queue.id);

        // [CHECKPOINT 4/6: ATOMIC_CLAIM_POLL]
        // Probe and atomically claim the highest-priority job from this queue shard
        const claimedJob = await this.atomicClaimJob(queue.id);
        if (claimedJob) {
          if (!isPrimary) {
            CheckpointLogger.info(`[WORK_STEALING] Worker [${this.workerId}] stole job [${claimedJob.id}] from busy queue [${queue.name}]`);
          }

          CheckpointLogger.checkpoint(4, 6, 'ATOMIC_CLAIM_SUCCESS', {
            jobId: claimedJob.id,
            jobName: claimedJob.name,
            queueName: queue.name,
            priority: claimedJob.priority,
            jobType: claimedJob.job_type,
            isWorkStolen: !isPrimary,
            workerSlot: `${this.concurrencyController.getActiveCount() + 1}/${this.concurrencyLimit}`
          });

          // Execute asynchronously in background slot
          this.executeJob(claimedJob, queue);
        }
      }
    } catch (err) {
      CheckpointLogger.error(`Worker polling cycle error: ${err.message}`, err);
    }
  }

  /**
   * QUEUE SHARD DISCOVERY & WORKER ASSIGNMENT:
   * Discovers all queues accessible to this worker node within its project scope.
   */
  async discoverQueues() {
    return new Promise((resolve, reject) => {
      let sql = `
        SELECT q.*, p.name as project_name
        FROM queues q
        JOIN projects p ON q.project_id = p.id
        WHERE 1=1
      `;
      const params = [];

      if (this.projectId) {
        sql += ' AND q.project_id = ?';
        params.push(this.projectId);
      }

      this.db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }

  /**
   * ATOMIC QUEUE SHARD CLAIM:
   * Claims a single job from a specific queue partition/shard (`WHERE j.queue_id = ?`).
   * 
   * Shard Isolation & Concurrency Rules:
   * 1. Target Shard: Evaluates only jobs assigned to `queueId`.
   * 2. Shard Capacity Limit: Checks `queue_running_count < max_concurrency` for this shard.
   * 3. Priority Ordering: Selects `ORDER BY j.priority DESC, j.created_at ASC LIMIT 1`.
   * 4. Race Condition Protection: Performs atomic SQLite state transition (`queued` -> `claimed`).
   */
  async atomicClaimJob(queueId) {
    const now = new Date().toISOString();

    return new Promise((resolve, reject) => {
      // Shard-Aware Fair Candidate Query:
      // Orders by priority DESC, created_at ASC across active shards
      this.db.get(
        `SELECT j.id, j.project_id, j.queue_id, j.shard_id, j.shard_index, j.batch_id, j.retry_policy_id, j.worker_id,
                j.name, j.job_type, j.status, j.priority, j.payload, j.result, j.error_details,
                j.timeout_seconds, j.scheduled_at, j.max_retries, j.retry_count, j.retry_strategy,
                j.retry_base_delay, j.retry_max_delay, j.created_at, j.updated_at,
                q.name as queue_name, q.max_concurrency, q.is_paused,
                (SELECT COUNT(*) FROM jobs WHERE queue_id = j.queue_id AND status = 'running') as queue_running_count
         FROM jobs j
         JOIN queues q ON j.queue_id = q.id
         WHERE j.queue_id = ?
           AND j.status = 'queued'
           AND q.is_paused = 0
         ORDER BY j.priority DESC, j.created_at ASC
         LIMIT 1`,
        [queueId],
        async (selectErr, candidateJob) => {
          if (selectErr || !candidateJob) {
            return resolve(null);
          }

          // 1. Global Queue Concurrency ACID check
          if (candidateJob.queue_running_count >= candidateJob.max_concurrency) {
            return resolve(null);
          }

          // 2. Distributed Atomic Redis Slot Acquisition
          const slotAcquired = await GlobalQueueConcurrencyController.acquireSlot(
            candidateJob.queue_id,
            candidateJob.max_concurrency,
            candidateJob.id,
            this.db
          );

          if (!slotAcquired) {
            return resolve(null);
          }

          // 3. Atomically claim the job
          this.db.run(
            `UPDATE jobs
             SET status = 'claimed', worker_id = ?, updated_at = ?
             WHERE id = ? AND status = 'queued'`,
            [this.workerId, now, candidateJob.id],
            function (updateErr) {
              if (updateErr || this.changes === 0) {
                // Claim lost to another concurrent worker -> release slot
                GlobalQueueConcurrencyController.releaseSlot(candidateJob.queue_id, candidateJob.id);
                return resolve(null);
              }

              resolve({
                ...candidateJob,
                payload: typeof candidateJob.payload === 'string' ? JSON.parse(candidateJob.payload) : candidateJob.payload
              });
            }
          );
        }
      );
    });
  }

  /**
   * [CHECKPOINT 5/6: EXECUTION_LIFECYCLE]
   */
  async executeJob(job, queue) {
    const executionId = `exec_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const startTime = Date.now();
    const now = new Date().toISOString();

    this.concurrencyController.acquireSlot(job.id, { executionId, queueId: queue.id });
    this.inFlightJobs.add(job.id);

    // Helper to write step-by-step logs into DB
    const logStep = async (level, message, metadata = null) => {
      const logId = uuidv4();
      const timestamp = new Date().toISOString();
      await new Promise((resolve) => {
        this.db.run(
          `INSERT INTO job_logs (id, execution_id, job_id, log_level, message, timestamp, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [logId, executionId, job.id, level, message, timestamp, metadata ? JSON.stringify(metadata) : null],
          () => resolve()
        );
      });
      if (level === 'error') {
        CheckpointLogger.error(`[Job ${job.name || job.id}] ${message}`);
      } else if (level === 'warn') {
        CheckpointLogger.warn(`[Job ${job.name || job.id}] ${message}`);
      } else {
        CheckpointLogger.info(`[Job ${job.name || job.id}] ${message}`);
      }
    };

    CheckpointLogger.checkpoint(5, 6, 'EXECUTION_STARTED', {
      jobId: job.id,
      executionId,
      jobType: job.job_type,
      attemptNumber: (job.retry_count || 0) + 1,
      timeoutSeconds: job.timeout_seconds || 60
    });

    try {
      // Update job to 'running' and create job_executions record
      await new Promise((resolve, reject) => {
        this.db.run(
          'UPDATE jobs SET status = "running", updated_at = ? WHERE id = ?',
          [now, job.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      await new Promise((resolve, reject) => {
        this.db.run(
          `INSERT INTO job_executions (
            id, job_id, worker_id, attempt_number, status, started_at, host_info, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            executionId,
            job.id,
            this.workerId,
            (job.retry_count || 0) + 1,
            'running',
            now,
            `${os.hostname()} (${process.pid})`,
            now
          ],
          (err) => {
            if (err) {
              console.error('ERROR INSERTING JOB_EXECUTION:', err.message, { executionId, jobId: job.id });
              return reject(err);
            }
            resolve();
          }
        );
      });

      await logStep('info', `Execution initialized on worker ${this.workerId} | Queue: "${queue.name || job.queue_name || job.queue_id}" -> Shard #${job.shard_index ?? 0} (Attempt ${(job.retry_count || 0) + 1})`);
      await logStep('info', `Payload: ${JSON.stringify(job.payload || {})}`);

      // Execute task based on job_type
      let executionResult = null;

      if (job.job_type === 'http_request') {
        executionResult = await HttpExecutionService.execute(job.payload, job.timeout_seconds, logStep);
      } else if (job.job_type === 'cpu_compute') {
        executionResult = await CpuComputeService.execute(job.payload, job.timeout_seconds, logStep);
      } else if (job.job_type === 'notification_event') {
        executionResult = await NotificationExecutionService.execute(job.payload, job.timeout_seconds, logStep);
      } else if (job.job_type === 'db_query') {
        executionResult = await DatabaseExecutionService.execute(job.payload, job.timeout_seconds, logStep);
      } else {
        executionResult = await ScriptExecutionService.execute(job.payload, job.timeout_seconds, logStep);
      }

      // [CHECKPOINT 6/6: COMPLETION_SUCCESS]
      const durationMs = Date.now() - startTime;
      const completedAt = new Date().toISOString();

      await new Promise((resolve) => {
        this.db.run(
          `UPDATE jobs SET
             status = 'completed',
             result = ?,
             error_details = NULL,
             updated_at = ?
           WHERE id = ?`,
          [JSON.stringify(executionResult), completedAt, job.id],
          () => resolve()
        );
      });

      await new Promise((resolve) => {
        this.db.run(
          `UPDATE job_executions SET
             status = 'completed',
             completed_at = ?,
             duration_ms = ?
           WHERE id = ?`,
          [completedAt, durationMs, executionId],
          () => resolve()
        );
      });

      // Update worker stats
      await new Promise((resolve) => {
        this.db.run(
          'UPDATE workers SET total_jobs_processed = total_jobs_processed + 1 WHERE id = ?',
          [this.workerId],
          () => resolve()
        );
      });

      await logStep('info', `Job completed successfully in ${durationMs}ms`);

      CheckpointLogger.checkpoint(6, 6, 'TASK_COMPLETED_SUCCESS', {
        jobId: job.id,
        durationMs: `${durationMs}ms`,
        status: 'COMPLETED',
        resultPreview: JSON.stringify(executionResult).slice(0, 100)
      });

      // Trigger DAG child dependencies check
      await this.checkAndTriggerDAGDependencies(job.id, 'completed');
    } catch (err) {
      // [CHECKPOINT 6/6: COMPLETION_FAILURE & RETRY / DLQ EVALUATION]
      const durationMs = Date.now() - startTime;
      const failedAt = new Date().toISOString();

      await logStep('error', `Execution failed: ${err.message}`);

      await new Promise((resolve) => {
        this.db.run(
          `UPDATE job_executions SET
             status = 'failed',
             completed_at = ?,
             duration_ms = ?,
             error_message = ?,
             error_stack = ?
           WHERE id = ?`,
          [failedAt, durationMs, err.message, err.stack || '', executionId],
          () => resolve()
        );
      });

      await new Promise((resolve) => {
        this.db.run(
          'UPDATE workers SET failed_jobs_count = failed_jobs_count + 1 WHERE id = ?',
          [this.workerId],
          () => resolve()
        );
      });

      // Evaluate Retry vs Dead Letter Queue
      const retryEvaluation = RetryHandler.evaluateRetry(job);

      if (retryEvaluation.shouldRetry) {
        // Schedule retry with backoff delay
        await new Promise((resolve) => {
          this.db.run(
            `UPDATE jobs SET
               status = 'scheduled',
               scheduled_at = ?,
               retry_count = ?,
               error_details = ?,
               updated_at = ?
             WHERE id = ?`,
            [
              retryEvaluation.nextScheduledAt,
              retryEvaluation.attempt,
              err.message,
              failedAt,
              job.id
            ],
            () => resolve()
          );
        });

        CheckpointLogger.checkpoint(6, 6, 'RETRY_SCHEDULED', {
          jobId: job.id,
          attempt: `${retryEvaluation.attempt}/${retryEvaluation.maxRetries}`,
          strategy: retryEvaluation.strategy,
          backoffDelay: `${retryEvaluation.delaySeconds}s`,
          nextRunAt: retryEvaluation.nextScheduledAt
        });
      } else {
        // Move to Dead Letter Queue (DLQ)
        const { dlqId, aiSummary } = await DlqHandler.moveToDlq(this.db, job, err, retryEvaluation.attempt);

        await new Promise((resolve) => {
          this.db.run(
            `UPDATE jobs SET
               status = 'dlq',
               error_details = ?,
               updated_at = ?
             WHERE id = ?`,
            [err.message, failedAt, job.id],
            () => resolve()
          );
        });

        CheckpointLogger.checkpoint(6, 6, 'MOVED_TO_DEAD_LETTER_QUEUE', {
          jobId: job.id,
          dlqId,
          reason: retryEvaluation.reason,
          aiSeverity: aiSummary?.severity || 'MEDIUM',
          aiDiagnosticSummary: aiSummary?.diagnosticSummary || 'Diagnostic not generated',
          suggestedFix: aiSummary?.suggestedFix || 'Review job payload and logs'
        });

        // Trigger DAG dependencies with failure condition
        await this.checkAndTriggerDAGDependencies(job.id, 'failed');
      }
    } finally {
      this.concurrencyController.releaseSlot(job.id);
      this.inFlightJobs.delete(job.id);
      await GlobalQueueConcurrencyController.releaseSlot(queue.id, job.id);
    }
  }

  async checkAndTriggerDAGDependencies(jobId, status) {
    try {
      const dependencies = await new Promise((resolve) => {
        this.db.all('SELECT * FROM workflow_dependencies WHERE parent_job_id = ?', [jobId], (err, rows) => {
          resolve(rows || []);
        });
      });

      if (!dependencies || dependencies.length === 0) return;

      const now = new Date().toISOString();
      for (const dep of dependencies) {
        const childId = dep.child_job_id;

        const allParents = await new Promise((resolve) => {
          this.db.all(
            `SELECT wd.condition, parent.status
             FROM workflow_dependencies wd
             JOIN jobs parent ON wd.parent_job_id = parent.id
             WHERE wd.child_job_id = ?`,
            [childId],
            (err, rows) => resolve(rows || [])
          );
        });

        let allSatisfied = true;
        for (const p of allParents) {
          if (p.condition === 'on_success' && p.status !== 'completed') {
            allSatisfied = false;
            break;
          } else if (p.condition === 'on_failure' && p.status !== 'failed') {
            allSatisfied = false;
            break;
          }
        }

        if (allSatisfied) {
          await new Promise((resolve) => {
            this.db.run(
              "UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'blocked')",
              [now, childId],
              () => resolve()
            );
          });
          CheckpointLogger.success(`Unlocked downstream DAG child job [${childId}] -> QUEUED`);
        }
      }
    } catch (e) {
      CheckpointLogger.warn(`DAG dependency check warning: ${e.message}`);
    }
  }

  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.isRunning = false;

    CheckpointLogger.warn(`[SHUTDOWN_SIGNAL_RECEIVED] Worker [${this.workerId}] draining active jobs...`);

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for in-flight jobs to complete (up to 15s)
    let waitCount = 0;
    while (this.inFlightJobs.size > 0 && waitCount < 15) {
      CheckpointLogger.info(`Waiting for ${this.inFlightJobs.size} in-flight job(s) to finish...`);
      await new Promise((r) => setTimeout(r, 1000));
      waitCount++;
    }

    this.heartbeatReporter.stop();

    await new Promise((resolve) => {
      this.db.run(
        "UPDATE workers SET status = 'stopped', active_jobs_count = 0 WHERE id = ?",
        [this.workerId],
        () => resolve()
      );
    });

    CheckpointLogger.success(`Worker [${this.workerId}] gracefully stopped.`);
  }
}

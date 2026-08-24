import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';
import { get, all } from '../database/db.js';
import { createDuplicateRedisClient } from '../redis/redis_client.js';
import { QueueKeys } from '../redis/queue_manager.js';

let globalWsServer = null;

export const getWsServer = () => globalWsServer;

export class RealtimeEventServer {
  constructor(server = null) {
    const wsOptions = {
      path: '/ws',
      ...(server ? { server } : { noServer: true }),
      verifyClient: async (info, callback) => {
        try {
          const url = new URL(info.req.url, 'http://localhost');
          const token = url.searchParams.get('token') || info.req.headers['sec-websocket-protocol'];
          const apiKey = url.searchParams.get('apiKey') || info.req.headers['x-api-key'];

          let authenticatedUser = null;
          if (apiKey) {
            authenticatedUser = await get('SELECT id, role FROM users WHERE api_key = ?', [apiKey]);
          }

          if (!authenticatedUser && token) {
            try {
              const decoded = jwt.verify(token, ENV.JWT_SECRET);
              authenticatedUser = await get('SELECT id, role FROM users WHERE id = ?', [decoded.id]);
            } catch (e) {}
          }

          info.req.user = authenticatedUser || { id: 'anonymous', role: 'viewer' };
          return callback(true);
        } catch (err) {
          info.req.user = { id: 'anonymous', role: 'viewer' };
          callback(true);
        }
      }
    };

    this.wss = new WebSocketServer(wsOptions);
    this.clients = new Set();
    this.subscriber = null;
    this.dbPoller = null;

    // DB polling state — tracks last broadcast to avoid re-broadcasting same events
    this._lastJobPollTime = new Date(Date.now() - 5000).toISOString();
    this._lastWorkerPollTime = new Date(Date.now() - 5000).toISOString();
    this._lastJobIds = new Set();

    globalWsServer = this;
  }

  start() {
    this.wss.on('connection', (ws, req) => {
      ws.user = req.user;
      this.clients.add(ws);

      try {
        ws.send(JSON.stringify({
          type: 'CONNECTED',
          message: 'Connected to Distributed Job Scheduler Realtime Stream',
          userId: req.user?.id,
          timestamp: new Date().toISOString()
        }));
      } catch (e) {}

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    // ── Redis Pub/Sub (optional, used when Redis is available) ──────────────
    try {
      this.subscriber = createDuplicateRedisClient();
      if (this.subscriber) {
        this.subscriber.subscribe(QueueKeys.eventsChannel(), () => {});
        this.subscriber.on('message', (channel, message) => {
          this.broadcast(message);
        });
      }
    } catch (e) {
      // Redis unavailable — DB polling will provide fallback
    }

    // ── DB Polling Fallback Broadcaster ─────────────────────────────────────
    // Polls every 1.5s for DB state changes and broadcasts them to all clients.
    // This ensures the frontend receives live updates even when Redis is unavailable.
    this._startDbPoller();
  }

  /**
   * DB-based polling broadcaster.
   * Every 1.5s, queries DB for:
   * - Jobs that changed status in the last 4s → JOB_STATE_CHANGE
   * - Workers with updated heartbeats → WORKER_HEARTBEAT
   * - Autoscale fleet metrics → AUTOSCALE_SNAPSHOT
   * Broadcasts each as a WebSocket event to all connected clients.
   */
  _startDbPoller() {
    const POLL_INTERVAL_MS = 1500;

    const poll = async () => {
      if (this.clients.size === 0) return; // Skip if nobody connected

      try {
        const now = new Date().toISOString();
        const windowStart = new Date(Date.now() - 4000).toISOString();

        // ── 1. Changed Jobs ───────────────────────────────────────────────
        let changedJobs = [];
        try {
          changedJobs = await all(
            `SELECT j.id, j.name, j.status, j.priority, j.job_type,
                    j.queue_id, j.project_id, j.worker_id, j.shard_index,
                    j.retry_count, j.updated_at, j.created_at,
                    q.name as queue_name, p.name as project_name
             FROM jobs j
             LEFT JOIN queues q ON j.queue_id = q.id
             LEFT JOIN projects p ON j.project_id = p.id
             WHERE j.updated_at >= ?
             ORDER BY j.updated_at DESC
             LIMIT 30`,
            [windowStart]
          );
        } catch (_) {}

        for (const job of changedJobs) {
          const eventKey = `${job.id}:${job.status}:${job.updated_at}`;
          if (!this._lastJobIds.has(eventKey)) {
            this._lastJobIds.add(eventKey);
            this.broadcastEvent('JOB_STATE_CHANGE', {
              jobId: job.id,
              jobName: job.name,
              status: job.status,
              jobType: job.job_type,
              priority: job.priority,
              queueId: job.queue_id,
              queueName: job.queue_name,
              projectId: job.project_id,
              projectName: job.project_name,
              workerId: job.worker_id,
              shardIndex: job.shard_index,
              retryCount: job.retry_count,
              timestamp: job.updated_at
            });
          }
        }

        // Keep the seen-event set bounded
        if (this._lastJobIds.size > 500) {
          const arr = Array.from(this._lastJobIds);
          this._lastJobIds = new Set(arr.slice(-200));
        }

        // ── 2. Active Workers ─────────────────────────────────────────────
        let workers = [];
        try {
          const hbCutoff = new Date(Date.now() - 20000).toISOString();
          workers = await all(
            `SELECT id, hostname, status, active_jobs_count, concurrency_limit,
                    total_jobs_processed, failed_jobs_count, last_heartbeat_at
             FROM workers
             WHERE last_heartbeat_at >= ?`,
            [hbCutoff]
          );
        } catch (_) {}

        if (workers.length > 0) {
          this.broadcastEvent('WORKER_FLEET_SNAPSHOT', {
            workers: workers.map(w => ({
              workerId: w.id,
              hostname: w.hostname,
              status: w.status,
              activeJobs: w.active_jobs_count,
              concurrencyLimit: w.concurrency_limit,
              totalProcessed: w.total_jobs_processed,
              failedCount: w.failed_jobs_count,
              lastHeartbeat: w.last_heartbeat_at
            })),
            timestamp: now
          });
        }

        // ── 3. Overview Metrics Snapshot ──────────────────────────────────
        try {
          const jobCounts = await all(
            `SELECT status, COUNT(*) as count FROM jobs GROUP BY status`
          );
          const statusMap = {};
          let totalJobs = 0;
          for (const row of jobCounts) {
            statusMap[row.status] = row.count;
            totalJobs += row.count;
          }
          this.broadcastEvent('METRICS_SNAPSHOT', {
            totalJobs,
            statusDistribution: statusMap,
            activeWorkers: workers.length,
            timestamp: now
          });
        } catch (_) {}

      } catch (err) {
        // Polling errors are non-fatal
      }
    };

    // Start polling with a small initial delay
    setTimeout(() => {
      poll();
      this.dbPoller = setInterval(poll, POLL_INTERVAL_MS);
    }, 2000);
  }

  broadcast(message) {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(raw);
        } catch (e) {
          this.clients.delete(client);
        }
      }
    }
  }

  broadcastEvent(event, data) {
    const payload = JSON.stringify({
      type: event,
      data,
      timestamp: new Date().toISOString()
    });
    this.broadcast(payload);
  }

  broadcastCheckpoint(checkpointData) {
    this.broadcastEvent('WORKER_CHECKPOINT', checkpointData);
  }

  stop() {
    if (this.dbPoller) {
      clearInterval(this.dbPoller);
      this.dbPoller = null;
    }
    if (this.subscriber) {
      try {
        this.subscriber.quit();
      } catch (e) {}
    }
    try {
      this.wss.close();
    } catch (e) {}
  }
}

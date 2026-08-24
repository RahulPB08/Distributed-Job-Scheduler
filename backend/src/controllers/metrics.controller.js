import { get, all } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';
import { WorkerAutoScalerService } from '../autoscaling/worker_autoscaler.service.js';
import { QueueAutoScalerService } from '../autoscaling/queue_autoscaler.service.js';

export class MetricsController {
  static async getOverview(req, res, next) {
    try {
      const { orgId } = req.query;

      let orgFilter = '';
      const params = [];

      if (req.user.role !== 'admin') {
        orgFilter = 'WHERE p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      } else if (orgId) {
        orgFilter = 'WHERE p.org_id = ?';
        params.push(orgId);
      }

      const jobCounts = await all(
        `SELECT j.status, COUNT(*) as count
         FROM jobs j
         JOIN projects p ON j.project_id = p.id
         ${orgFilter}
         GROUP BY j.status`,
        params
      );

      const statusMap = {
        scheduled: 0,
        queued: 0,
        claimed: 0,
        running: 0,
        completed: 0,
        failed: 0,
        dlq: 0,
        cancelled: 0
      };

      let totalJobs = 0;
      for (const row of jobCounts) {
        statusMap[row.status] = row.count;
        totalJobs += row.count;
      }

      const heartbeatCutoff = new Date(Date.now() - 15000).toISOString();
      const activeWorkers = await all(
        "SELECT id, concurrency_limit, active_jobs_count, status FROM workers WHERE status IN ('healthy', 'degraded') AND last_heartbeat_at >= ?",
        [heartbeatCutoff]
      );
      const totalCapacity = activeWorkers.reduce((s, w) => s + (w.concurrency_limit || 5), 0);
      const activeSlots = activeWorkers.reduce((s, w) => s + (w.active_jobs_count || 0), 0);

      const totalExecutionsResult = await get(
        `SELECT COUNT(*) as count, AVG(duration_ms) as avg_duration,
                MIN(duration_ms) as min_duration, MAX(duration_ms) as max_duration
         FROM job_executions je
         JOIN jobs j ON je.job_id = j.id
         JOIN projects p ON j.project_id = p.id
         ${orgFilter}`,
        params
      );

      const dlqCountResult = await get(
        `SELECT COUNT(*) as count
         FROM dead_letter_queue dlq
         JOIN projects p ON dlq.project_id = p.id
         ${orgFilter ? orgFilter + ' AND' : 'WHERE'} dlq.resolution_status = 'unresolved'`,
        params
      );

      const totalQueuesResult = await get(
        `SELECT COUNT(DISTINCT q.id) as total_queues, COUNT(qs.id) as total_shards
         FROM queues q
         JOIN projects p ON q.project_id = p.id
         LEFT JOIN queue_shards qs ON q.id = qs.logical_queue_id AND qs.status = 'active'
         ${orgFilter}`,
        params
      );

      const successCount = statusMap.completed || 0;
      const failCount = (statusMap.failed || 0) + (statusMap.dlq || 0);
      const finishedCount = successCount + failCount;
      const successRate = finishedCount > 0 ? ((successCount / finishedCount) * 100).toFixed(1) : 100;
      const failureRate = finishedCount > 0 ? ((failCount / finishedCount) * 100).toFixed(1) : 0;

      res.json({
        success: true,
        data: {
          totalJobs,
          statusDistribution: statusMap,
          activeWorkers: activeWorkers.length,
          activeSchedulers: 1,
          schedulerMode: 'SINGLE_AUTHORITATIVE',
          totalCapacitySlots: totalCapacity,
          activeUsedSlots: activeSlots,
          fleetUtilizationPercent: totalCapacity > 0 ? Math.round((activeSlots / totalCapacity) * 100) : 0,
          totalQueues: totalQueuesResult?.total_queues || 0,
          totalShards: totalQueuesResult?.total_shards || 0,
          totalExecutions: totalExecutionsResult ? totalExecutionsResult.count : 0,
          avgDurationMs: totalExecutionsResult?.avg_duration ? Math.round(totalExecutionsResult.avg_duration) : 0,
          minDurationMs: totalExecutionsResult?.min_duration || 0,
          maxDurationMs: totalExecutionsResult?.max_duration || 0,
          unresolvedDlq: dlqCountResult ? dlqCountResult.count : 0,
          successRate: parseFloat(successRate),
          failureRate: parseFloat(failureRate)
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getThroughput(req, res, next) {
    try {
      const { orgId } = req.query;
      let orgFilter = '';
      const params = [];

      if (req.user.role !== 'admin') {
        orgFilter = 'WHERE p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      } else if (orgId) {
        orgFilter = 'WHERE p.org_id = ?';
        params.push(orgId);
      }

      const rows = await all(
        `SELECT strftime('%Y-%m-%d %H:%M:00', je.completed_at) as time_bucket,
                COUNT(*) as count,
                SUM(CASE WHEN je.status = 'completed' THEN 1 ELSE 0 END) as completed_count,
                SUM(CASE WHEN je.status = 'failed' THEN 1 ELSE 0 END) as failed_count,
                AVG(je.duration_ms) as avg_duration
         FROM job_executions je
         JOIN jobs j ON je.job_id = j.id
         JOIN projects p ON j.project_id = p.id
         ${orgFilter ? orgFilter + ' AND' : 'WHERE'} je.completed_at IS NOT NULL
         GROUP BY time_bucket
         ORDER BY time_bucket DESC
         LIMIT 30`,
        params
      );

      res.json({ success: true, data: rows.reverse() });
    } catch (err) {
      next(err);
    }
  }

  static async getLatency(req, res, next) {
    try {
      const { orgId } = req.query;

      let orgFilter = '';
      const params = [];

      if (req.user.role !== 'admin') {
        orgFilter = 'WHERE p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      } else if (orgId) {
        orgFilter = 'WHERE p.org_id = ?';
        params.push(orgId);
      }

      const latencyRows = await all(
        `SELECT j.job_type,
                COUNT(*) as count,
                AVG(je.duration_ms) as avg_duration,
                MIN(je.duration_ms) as min_duration,
                MAX(je.duration_ms) as max_duration
         FROM job_executions je
         JOIN jobs j ON je.job_id = j.id
         JOIN projects p ON j.project_id = p.id
         ${orgFilter ? orgFilter + ' AND' : 'WHERE'} je.status = 'completed' AND je.duration_ms IS NOT NULL
         GROUP BY j.job_type`,
        params
      );

      // Compute estimated P50, P90, P99 percentiles for each job type
      const formatted = await Promise.all(
        latencyRows.map(async (row) => {
          const durations = await all(
            `SELECT je.duration_ms 
             FROM job_executions je
             JOIN jobs j ON je.job_id = j.id
             JOIN projects p ON j.project_id = p.id
             ${orgFilter ? orgFilter + ' AND' : 'WHERE'} j.job_type = ? AND je.status = 'completed' AND je.duration_ms IS NOT NULL
             ORDER BY je.duration_ms ASC`,
            [...params, row.job_type]
          );

          const list = durations.map(d => d.duration_ms);
          const p50 = list.length ? list[Math.floor(list.length * 0.50)] : 0;
          const p90 = list.length ? list[Math.floor(list.length * 0.90)] : 0;
          const p99 = list.length ? list[Math.floor(list.length * 0.99)] : 0;

          return {
            jobType: row.job_type,
            count: row.count,
            avgDurationMs: Math.round(row.avg_duration || 0),
            minDurationMs: row.min_duration || 0,
            maxDurationMs: row.max_duration || 0,
            p50DurationMs: p50 || 0,
            p90DurationMs: p90 || 0,
            p99DurationMs: p99 || 0
          };
        })
      );

      res.json({ success: true, data: formatted });
    } catch (err) {
      next(err);
    }
  }

  static async getQueueDepths(req, res, next) {
    try {
      const { orgId } = req.query;

      let orgFilter = '';
      const params = [];

      if (req.user.role !== 'admin') {
        orgFilter = 'WHERE p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      } else if (orgId) {
        orgFilter = 'WHERE p.org_id = ?';
        params.push(orgId);
      }

      const { ensureServiceQueues } = await import('./queue.controller.js');
      const allProjects = await all('SELECT id FROM projects');
      for (const p of allProjects) {
        await ensureServiceQueues(p.id);
      }

      const queues = await all(
        `SELECT q.id, q.name, q.priority, q.max_concurrency, q.min_shards, q.max_shards, q.shard_count, p.name as project_name
         FROM queues q
         JOIN projects p ON q.project_id = p.id
         ${orgFilter}`,
        params
      );

      const enriched = await Promise.all(
        queues.map(async (q) => {
          let dbDepth = 0;
          let runningCount = 0;
          try {
            const dbCount = await get('SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status = "queued"', [q.id]);
            dbDepth = dbCount?.count || 0;
            const runCount = await get('SELECT COUNT(*) as count FROM jobs WHERE queue_id = ? AND status IN ("running", "claimed")', [q.id]);
            runningCount = runCount?.count || 0;
          } catch (e) {}

          let redisDepth = 0;
          try {
            redisDepth = await QueueManager.getQueueDepth(q.id);
          } catch (e) {}

          const depth = Math.max(dbDepth, redisDepth);

          // Get shard level details with unambiguous j.status mapping
          const shards = await all(
            `SELECT qs.id as shard_id, qs.shard_index, qs.status as shard_status,
                    SUM(CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END) as pending_count,
                    SUM(CASE WHEN j.status IN ('running', 'claimed') THEN 1 ELSE 0 END) as running_count
             FROM queue_shards qs
             LEFT JOIN jobs j ON qs.logical_queue_id = j.queue_id AND qs.shard_index = j.shard_index
             WHERE qs.logical_queue_id = ?
             GROUP BY qs.id, qs.shard_index, qs.status
             ORDER BY qs.shard_index ASC`,
            [q.id]
          );

          return {
            id: q.id,
            name: q.name,
            projectName: q.project_name,
            priority: q.priority,
            maxConcurrency: q.max_concurrency,
            minShards: q.min_shards || 2,
            maxShards: q.max_shards || 16,
            shardCount: shards.length || q.shard_count || 2,
            depth,
            runningCount,
            shards: shards || []
          };
        })
      );

      res.json({ success: true, data: enriched });
    } catch (err) {
      next(err);
    }
  }

  static async getEvents(req, res, next) {
    try {
      const limit = parseInt(req.query.limit || '100', 10);
      const events = await all(
        `SELECT * FROM system_events ORDER BY created_at DESC LIMIT ?`,
        [limit]
      );
      const parsed = events.map(e => ({
        id: e.id,
        type: e.event_type,
        workerId: e.worker_id,
        jobId: e.job_id,
        message: e.message,
        data: e.payload ? JSON.parse(e.payload) : {},
        timestamp: e.created_at
      })).reverse();
      res.json({ success: true, data: parsed });
    } catch (err) {
      next(err);
    }
  }

  static async getLocks(req, res, next) {
    try {
      const { DistributedLock } = await import('../redis/distributed_lock.js');
      const activeLocks = await DistributedLock.listActiveLocks();
      res.json({ success: true, data: activeLocks });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/metrics/autoscaler
   * Complete unified autoscaling telemetry (worker autoscaler + queue shard autoscaler).
   */
  static async getAutoscalerMetrics(req, res, next) {
    try {
      const { QueueShardSnatcherService, AdaptiveLoadBalancerService } = await import('../autoscaling/index.js');
      const workerFleetMetrics = await WorkerAutoScalerService.getFleetMetrics();
      const queueShardTelemetry = await QueueAutoScalerService.getTelemetry();
      const snatcherTelemetry = QueueShardSnatcherService.getTelemetry();
      const loadBalancerTelemetry = AdaptiveLoadBalancerService.getTelemetry();

      res.json({
        success: true,
        data: {
          ...workerFleetMetrics,
          queueAutoscaler: queueShardTelemetry,
          shardSnatcher: snatcherTelemetry,
          loadBalancer: loadBalancerTelemetry
        }
      });
    } catch (err) {
      next(err);
    }
  }
}

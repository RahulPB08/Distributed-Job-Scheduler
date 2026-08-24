import { run, get, all } from '../database/db.js';
import { ShardRouterService } from './shard_router.service.js';
import { JOB_TYPE_TO_SERVICE_QUEUE, ensureServiceQueues } from '../controllers/queue.controller.js';

/**
 * AdaptiveLoadBalancerService — Situation-Aware Scheduling & Multi-Queue Distribution Algorithm
 *
 * Algorithm Design:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Dynamic Load-Sensing:
 *    Inspects live queue depths, active running jobs, and shard distribution
 *    across all service queues in the project.
 *
 * 2. Situation-Aware Decision Matrix:
 *    - IF primary service queue has LOW/NORMAL load (depth <= CONGESTION_THRESHOLD):
 *      -> Route directly to the least-loaded shard of the primary service queue.
 *    - IF primary service queue is CONGESTED (depth > CONGESTION_THRESHOLD) or large burst influx:
 *      -> Intelligently distribute jobs to alternative queues with available shard capacity
 *         using Weighted Least-Connections & Shard Balance scoring:
 *         Score(Q) = (Q.priority * 5) - (Q.pending_jobs * 2) - (Q.running_jobs)
 *
 * 3. Proportional Batch Multi-Queue Shard Splitting:
 *    When large batches (e.g. 100 to 10,000 jobs) arrive, splits and interleaves
 *    jobs across all active queues and shards in the project in real time.
 */
export class AdaptiveLoadBalancerService {
  static CONGESTION_THRESHOLD = 12; // When queue depth > 12, start adaptive distribution to alternative queues

  static telemetry = {
    totalJobsBalanced: 0,
    primaryQueueRouted: 0,
    overflowQueueDistributed: 0,
    burstBatchesDistributed: 0,
    recentDistributions: []
  };

  /**
   * Selects optimal queue and shard for a single job based on live situation.
   */
  static async selectOptimalQueueAndShard(projectId, jobType, options = {}) {
    await ensureServiceQueues(projectId);

    const primaryQueueName = JOB_TYPE_TO_SERVICE_QUEUE[jobType] || 'http-service-queue';

    // Fetch all unpaused queues for this project with live depths
    const queues = await all(
      `SELECT q.id, q.name, q.priority, q.max_concurrency, q.shard_count,
              (SELECT COUNT(*) FROM jobs WHERE queue_id = q.id AND status = 'queued') as pending_depth,
              (SELECT COUNT(*) FROM jobs WHERE queue_id = q.id AND status IN ('running', 'claimed')) as running_count
       FROM queues q
       WHERE q.project_id = ? AND q.is_paused = 0
       ORDER BY q.priority DESC`,
      [projectId]
    );

    if (!queues || queues.length === 0) {
      return { queueId: null, queueName: 'default', shardId: null, shardIndex: 0 };
    }

    const primaryQueue = queues.find((q) => q.name === primaryQueueName) || queues[0];
    const isPrimaryCongested = primaryQueue.pending_depth > this.CONGESTION_THRESHOLD;

    let selectedQueue = primaryQueue;
    let isDistributed = false;

    if (isPrimaryCongested && queues.length > 1) {
      // Find the least congested queue with lowest pending depth and highest capacity
      const candidates = [...queues].sort((a, b) => {
        // Score = (priority * 5) - (pending * 2) - running
        const scoreA = (a.priority * 5) - (a.pending_depth * 2) - a.running_count;
        const scoreB = (b.priority * 5) - (b.pending_depth * 2) - b.running_count;
        return scoreB - scoreA;
      });

      if (candidates[0].id !== primaryQueue.id && candidates[0].pending_depth < primaryQueue.pending_depth) {
        selectedQueue = candidates[0];
        isDistributed = true;
      }
    }

    // Select optimal shard within the chosen queue
    const targetShard = await ShardRouterService.routeJob(selectedQueue.id, {
      strategy: 'least_loaded',
      affinityKey: options.affinityKey
    });

    // Record Telemetry
    this.telemetry.totalJobsBalanced++;
    if (isDistributed) {
      this.telemetry.overflowQueueDistributed++;
      this._recordDistributionEvent({
        type: 'SITUATION_ADAPTIVE_DISTRIBUTION',
        projectId,
        jobType,
        primaryQueue: primaryQueueName,
        selectedQueue: selectedQueue.name,
        shardIndex: targetShard?.shard_index ?? 0,
        reason: `Primary queue congested (${primaryQueue.pending_depth} waiting jobs)`,
        timestamp: new Date().toISOString()
      });
    } else {
      this.telemetry.primaryQueueRouted++;
    }

    return {
      queueId: selectedQueue.id,
      queueName: selectedQueue.name,
      shardId: targetShard?.id || null,
      shardIndex: targetShard?.shard_index ?? 0,
      isDistributed
    };
  }

  /**
   * Distributes a batch of jobs across all project queues and shards based on the situation.
   */
  static async distributeBatch(projectId, jobsList) {
    await ensureServiceQueues(projectId);

    const queues = await all(
      `SELECT q.id, q.name, q.priority, q.max_concurrency, q.shard_count
       FROM queues q
       WHERE q.project_id = ? AND q.is_paused = 0
       ORDER BY q.priority DESC`,
      [projectId]
    );

    if (!queues || queues.length === 0) {
      return jobsList.map((job) => ({ ...job, queueId: null, shardId: null, shardIndex: 0 }));
    }

    // Pre-fetch all active shards for each queue
    const queueShardsMap = new Map();
    for (const q of queues) {
      const shards = await all(
        'SELECT id, shard_index FROM queue_shards WHERE logical_queue_id = ? AND status = "active" ORDER BY shard_index ASC',
        [q.id]
      );
      queueShardsMap.set(q.id, shards.length > 0 ? shards : [{ id: null, shard_index: 0 }]);
    }

    // Flatten all available (queue, shard) processing lanes
    const allLanes = [];
    for (const q of queues) {
      const shards = queueShardsMap.get(q.id) || [{ id: null, shard_index: 0 }];
      for (const sh of shards) {
        allLanes.push({ queue: q, shard: sh });
      }
    }

    // Distribute jobs across all lanes in round-robin / situation-weighted order across all queues & shards
    console.log(`[ADAPTIVE_LOAD_BALANCER] ⚡ Distributing batch of ${jobsList.length} jobs across ${allLanes.length} lanes in ${queues.length} queues: ${queues.map(q => q.name).join(', ')}`);
    let laneIdx = 0;
    const distributedJobs = jobsList.map((job, idx) => {
      const expectedQueueName = JOB_TYPE_TO_SERVICE_QUEUE[job.jobType] || 'http-service-queue';
      const matchingLanes = allLanes.filter((l) => l.queue.name === expectedQueueName);

      // Situation-aware: if batch > 5, distribute across ALL queues & shards
      const chosenLane = (jobsList.length > 5 || matchingLanes.length === 0)
        ? allLanes[laneIdx++ % allLanes.length]
        : matchingLanes[idx % matchingLanes.length];

      return {
        ...job,
        queueId: chosenLane.queue.id,
        queueName: chosenLane.queue.name,
        shardId: chosenLane.shard.id,
        shardIndex: chosenLane.shard.shard_index,
        isDistributed: chosenLane.queue.name !== expectedQueueName
      };
    });

    this.telemetry.burstBatchesDistributed++;
    this.telemetry.totalJobsBalanced += jobsList.length;

    return distributedJobs;
  }

  static _recordDistributionEvent(ev) {
    this.telemetry.recentDistributions.unshift(ev);
    if (this.telemetry.recentDistributions.length > 50) {
      this.telemetry.recentDistributions.pop();
    }
  }

  static getTelemetry() {
    return {
      ...this.telemetry,
      algorithm: 'SITUATION_AWARE_DYNAMIC_MULTI_QUEUE_DISTRIBUTION',
      congestionThreshold: this.CONGESTION_THRESHOLD,
      status: 'ACTIVE'
    };
  }
}

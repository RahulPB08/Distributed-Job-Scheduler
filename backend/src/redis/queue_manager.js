/**
 * Distributed Job Scheduler — Queue Shard Router & Redis Key Partition Manager
 *
 * Sharding Architecture:
 * - Each queue acts as an independent partition / shard (e.g. `shard-1`, `high-priority`, `default`).
 * - Jobs dispatched to a queue are routed into dedicated isolated Redis keys and SQLite indexes.
 * - This provides tenant and queue isolation, preventing noisy-neighbor bottlenecks.
 */

import { getRedisClient } from './redis_client.js';

/**
 * Redis Key Namespacing & Shard Routing Scheme
 */
export const QueueKeys = {
  // Shard FIFO buffer for fast dispatch
  queueList: (queueId, shardIndex) => shardIndex !== undefined ? `queue:${queueId}:shard:${shardIndex}:ready` : `queue:${queueId}:ready`,
  // Shard Priority Sorted Set (ZSET)
  priorityZSet: (queueId, shardIndex) => shardIndex !== undefined ? `queue:${queueId}:shard:${shardIndex}:priority` : `queue:${queueId}:priority`,
  // Global delayed / scheduled jobs buffer
  delayedZSet: () => `djs:delayed_jobs`,
  // Per-worker active job tracking set
  processingSet: (workerId) => `worker:${workerId}:active`,
  // Worker liveness heartbeat key
  workerHeartbeat: (workerId) => `worker:${workerId}:heartbeat`,
  // Worker node cluster registry
  workerRegistry: () => `djs:workers`,
  // Shard state metadata (paused, concurrency limit, etc.)
  queueMeta: (queueId) => `queue:${queueId}:meta`,
  // Real-time pub/sub event channel
  eventsChannel: () => `djs:events`
};

export class QueueManager {
  /**
   * Routes and enqueues a job into its designated queue shard in Redis
   */
  static async enqueueJob(queueId, jobData, priority = 10, shardIndex = 0) {
    try {
      const redis = getRedisClient();
      const payload = typeof jobData === 'string' ? jobData : JSON.stringify(jobData);
      // Route to dedicated shard key: queue:<queueId>:ready and queue:<queueId>:shard:<shardIndex>:ready
      const shardKey = QueueKeys.queueList(queueId, shardIndex);
      const queueKey = QueueKeys.queueList(queueId);
      await redis.lpush(shardKey, payload);
      await redis.lpush(queueKey, payload);
      const eventPayload = JSON.stringify({
        type: 'JOB_QUEUED',
        queueId,
        shardIndex,
        jobId: jobData.id,
        timestamp: new Date().toISOString()
      });
      await redis.publish(QueueKeys.eventsChannel(), eventPayload);
    } catch (e) {
      // Redis optional fallback
    }
  }

  static async getQueueDepth(queueId) {
    try {
      const redis = getRedisClient();
      const key = QueueKeys.queueList(queueId);
      return (await redis.llen(key)) || 0;
    } catch (e) {
      return 0;
    }
  }

  static async purgeQueue(queueId) {
    try {
      const redis = getRedisClient();
      const key = QueueKeys.queueList(queueId);
      await redis.del(key);
    } catch (e) {}
  }

  static async publishEvent(eventType, data) {
    const timestamp = new Date().toISOString();
    const eventObj = {
      type: eventType,
      data,
      timestamp
    };

    // 1. Publish to Redis channel (if Redis connected)
    try {
      const redis = getRedisClient();
      await redis.publish(QueueKeys.eventsChannel(), JSON.stringify(eventObj));
    } catch (e) {}

    // 2. Broadcast directly to all live WebSocket clients
    try {
      const { getWsServer } = await import('../websocket/ws_server.js');
      const wsServer = getWsServer();
      if (wsServer) {
        wsServer.broadcast(JSON.stringify(eventObj));
      }
    } catch (e) {}

    // 3. Persist into SQLite system_events table
    try {
      const { run } = await import('../database/db.js');
      const { v4: uuidv4 } = await import('uuid');
      await run(
        `INSERT INTO system_events (id, event_type, worker_id, job_id, queue_id, project_id, message, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          eventType,
          data?.workerId || data?.worker_id || null,
          data?.jobId || data?.job_id || null,
          data?.queueId || data?.queue_id || null,
          data?.projectId || data?.project_id || null,
          data?.message || `System event ${eventType}`,
          JSON.stringify(data || {}),
          timestamp
        ]
      );
    } catch (e) {}
  }
}

//here it used to claim a job from the queue and add it to the processing set for the worker. It also provides a method to release the claim on a job, removing it from the processing set.

//The Problem: You execute rpop (Step 1) and then sadd (Step 2) as two completely separate commands. If your worker server loses power or crashes in the millisecond after rpop but before sadd, the job is deleted from the main queue but never recorded in the active processing list. That job is now permanently lost.

export class Claimer {
  static async claimJob(redis, queueId, workerId) {
    const queueKey = `queue:${queueId}:ready`;
    const processingKey = `worker:${workerId}:active`;

    try {
      const rawJob = await redis.rpop(queueKey);
      if (!rawJob) return null;
      
      await redis.sadd(processingKey, rawJob);
      const parsedJob = typeof rawJob === 'string' ? JSON.parse(rawJob) : rawJob;
      return parsedJob;
    } catch (err) {
      return null;
    }
  }

  static async releaseClaim(redis, workerId, rawJob) {
    const processingKey = `worker:${workerId}:active`;
    try {
      await redis.srem(processingKey, typeof rawJob === 'string' ? rawJob : JSON.stringify(rawJob));
    } catch (e) { }
  }
}


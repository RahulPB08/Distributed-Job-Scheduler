# Redis Multi-Queue Architecture & Mechanics

Redis serves as the high-throughput, in-memory queue broker and coordination engine for the Distributed Job Scheduler platform.

---

## Redis Keyspace Architecture

| Key Pattern | Redis Data Structure | Description |
| :--- | :--- | :--- |
| `queue:{queue_id}:ready` | `LIST` | Primary FIFO queue holding ready-to-claim job JSON payloads. |
| `queue:{queue_id}:priority` | `ZSET` | Priority-scored sorted set for numerical priority dispatching (1-100). |
| `worker:{worker_id}:active` | `SET` | Set of in-flight job payloads currently claimed by this specific worker. |
| `worker:{worker_id}:heartbeat` | `HASH` | Latest worker telemetry (active jobs, CPU load, RSS memory, timestamp). |
| `lock:djs:{resource_name}` | `STRING` | Distributed lock key acquired with `SET NX PX` for atomic coordination. |
| `djs:events` | `PUB/SUB CHANNEL` | Global real-time event broadcast channel streaming to WebSocket clients. |

---

## Multiple Queues & Multi-Project Isolation

1. **Queue Isolation**: Every project can define multiple independent queues (e.g. `default`, `high-priority`, `cpu-heavy`, `webhooks`).
2. **Dedicated Keys**: Each queue maps to its own Redis key `queue:{queue_id}:ready`. Workers assigned to specific queues poll only their target keys.
3. **Queue Level Concurrency**: Each queue defines a `max_concurrency` setting. Workers inspect queue capacity and pause state before pulling tasks.

---

## Atomic Claiming & Duplicate Prevention

To prevent race conditions where two concurrent workers attempt to claim the same job:

1. **Atomic Consumption**: The worker issues an atomic `RPOP` against the Redis list `queue:{queue_id}:ready`.
2. **Claim Tracking**: Upon popping, the payload is atomically added to `worker:{worker_id}:active` using `SADD`.
3. **Database State Transition**: The worker transitions `jobs.status` from `'queued'` to `'running'` and inserts a `job_executions` record with `started_at`.
4. **Idempotency Safeguard**: Jobs submitted with an `idempotency_key` are unique-constrained in the database; duplicates return the existing record without creating duplicate Redis queue entries.

---

## Priority Scheduling Mechanism

1. Queues and jobs define priority ratings from 1 (lowest) to 100 (highest).
2. The Python Scheduler orders ready jobs by `priority DESC, created_at ASC` before enqueuing to Redis lists.
3. Workers poll high-priority queues first before checking standard or low-priority queues.

---

## Synchronization Between Redis and Database

- **Enqueuing**: The Python Scheduler updates `jobs.status = 'queued'` in the database immediately upon pushing to Redis `queue:{queue_id}:ready`.
- **Claiming**: Workers claim from Redis and update `jobs.status = 'running'` in the database.
- **Completion**: Workers remove the claim from `worker:{worker_id}:active` in Redis, update `jobs.status = 'completed'` in the database, and publish a `JOB_COMPLETED` event over Redis Pub/Sub.
- **Failures & Retries**: Failed jobs are calculated with exponential/linear backoff, re-scheduled in the database for `now + delaySeconds`, and re-enqueued by the scheduler when the delay expires.


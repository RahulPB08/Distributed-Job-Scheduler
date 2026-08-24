# Node.js Worker Fleet & Execution Services

The worker fleet is a horizontally scalable execution cluster capable of processing asynchronous background jobs from Redis queues with strict concurrency control, failure isolation, and multi-service routing.

---

## Horizontal Scaling & Multiple Worker Instances

Multiple worker instances can run concurrently on the same machine or across distinct container hosts without configuration conflicts:

```bash
# Terminal 1 - Worker 1
node src/index.js --worker-id=worker-alpha --concurrency=10 --queues=default,high-priority

# Terminal 2 - Worker 2
node src/index.js --worker-id=worker-beta --concurrency=5 --queues=cpu-heavy,webhooks

# Terminal 3 - Worker 3
node src/index.js --worker-id=worker-gamma --concurrency=8
```

Each worker instance registers itself in the `workers` table with its unique hostname, IP address, and concurrency limit, establishing an independent heartbeat loop.

---

## The Four Specialized Execution Services

Every worker instance contains four dedicated execution capabilities:

### 1. HTTP / Webhook Execution Service (`HttpExecutionService`)
- **Category**: Asynchronous I/O
- **Responsibilities**: Outbound REST API requests, third-party webhook delivery, health check probes.
- **Capabilities**: Configurable HTTP methods (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`), custom headers, query parameters, request body templating, custom timeouts, and HTTP status verification.

### 2. Database / Query Execution Service (`DatabaseExecutionService`)
- **Category**: Asynchronous I/O
- **Responsibilities**: Asynchronous SQL queries, table data processing, batch transactions, database migrations, and ETL aggregation.
- **Capabilities**: Non-blocking asynchronous query execution with batch record handling.

### 3. CPU Compute Service (`CpuComputeService` & `ThreadPool`)
- **Category**: CPU-Intensive Workload
- **Responsibilities**: Heavy mathematical computations, cryptographic hashing iterations, matrix multiplication, large JSON/text parsing, and image/file transformations.
- **Worker Threads Offloading**: Offloads heavy tasks to Node.js `worker_threads` (`compute_worker.js`) via a managed thread pool. This ensures the main worker event loop is never blocked, allowing the worker to continuously poll queues, report heartbeats, and manage concurrency.

### 4. Notification / Event Execution Service (`NotificationExecutionService`)
- **Category**: Asynchronous I/O
- **Responsibilities**: Email alerts, SMS notifications, Slack/Discord webhook alerts, event broadcasting, and triggering downstream DAG workflow dependencies.

---

## Concurrency Control & `activeJobsCount`

Each worker maintains a `ConcurrencyController`:
1. Tracks `activeJobsCount` in memory.
2. Before claiming a job from Redis, evaluates `concurrencyController.canAcceptJob()`.
3. If `activeJobsCount >= maxConcurrency`, the worker pauses queue consumption until in-flight jobs complete.
4. When a job begins execution, `acquireSlot(jobId)` increments the count.
5. When a job completes, fails, or is cancelled, `releaseSlot(jobId)` decrements the count.

---

## Failure Isolation

- All job executions are isolated inside try-catch blocks.
- A runtime error, timeout, or uncaught exception in one job never crashes other concurrent jobs or causes the worker process to terminate.
- In-flight batches execute with `Promise.allSettled()` semantics.

---

## Graceful Shutdown Lifecycle

Upon receiving `SIGINT` or `SIGTERM`:
1. Worker transitions status to `'draining'` in database and Redis.
2. Worker halts new queue polling immediately.
3. Allows in-flight active jobs to complete (up to timeout).
4. Cleans up worker thread pools.
5. Updates worker status to `'stopped'` with `active_jobs_count = 0`.
6. Exits cleanly with code 0.


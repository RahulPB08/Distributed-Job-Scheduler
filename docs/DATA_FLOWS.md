# Complete System Data Flows & Workflows

This document outlines the step-by-step lifecycle flows across the Distributed Job Scheduler platform.

---

## 1. Authentication & Authorization Flow

```
User (Browser / API Client)
  │  (1) POST /api/auth/login { email, password }
  ▼
Node.js Backend
  │  (2) SELECT * FROM users WHERE email = ?
  ▼
Relational Database
  │  (3) User record returned
  ▼
Node.js Backend
  │  (4) Verify bcrypt.compare(password, user.password_hash)
  │  (5) Generate JWT: jwt.sign({ id, email, role, orgId }, JWT_SECRET, { expiresIn: '7d' })
  ▼
User (Browser / API Client)
  │  (6) Stores token in localStorage / headers
  ▼
Subsequent Requests
  │  (7) Request with 'Authorization: Bearer <token>' or 'x-api-key: <key>'
  ▼
Auth & RBAC Middleware
  │  (8) Decodes JWT / validates API key & verifies role against endpoint permissions
```

---

## 2. Immediate Job Flow

```
User / API Client
  │  (1) POST /api/jobs { projectId, queueId, name, jobType, payload, priority: 25 }
  ▼
Node.js Backend
  │  (2) Validate schema & verify queue/project exists
  │  (3) INSERT INTO jobs (status='scheduled', scheduled_at=NOW())
  │  (4) Publish 'JOB_CREATED' event
  ▼
Python Scheduler (1-second tick)
  │  (5) SELECT ready jobs WHERE status='scheduled' AND scheduled_at <= NOW()
  │  (6) Verify workflow dependencies (if any)
  │  (7) Acquire Redis distributed lock: SET lock:job_dispatch:{job_id} NX PX 3000
  │  (8) UPDATE jobs SET status='queued'
  │  (9) Redis LPUSH queue:{queue_id}:ready { job_json }
  ▼
Available Worker Instance
  │  (10) ConcurrencyController.canAcceptJob() returns true
  │  (11) Redis RPOP queue:{queue_id}:ready -> Atomically claim job
  │  (12) UPDATE jobs SET status='running' & INSERT INTO job_executions
  │  (13) Route to Service (HTTP, Database, Worker Threads, Notification)
  │  (14) On Success: UPDATE jobs SET status='completed', result=JSON
  │  (15) Release claim & broadcast 'JOB_COMPLETED' via Redis Pub/Sub
  ▼
WebSocket Server -> React Dashboard
  │  (16) Live UI table & metric counters update instantly
```

---

## 3. Delayed Job Flow

```
User / API Client
  │  (1) POST /api/jobs { delaySeconds: 120, ... }
  ▼
Node.js Backend
  │  (2) INSERT INTO jobs (status='scheduled', scheduled_at=NOW() + 120 seconds)
  ▼
Database
  │  (3) Job resides safely in relational DB with status='scheduled'
  ▼
Python Scheduler
  │  (4) Periodically checks scheduled_at <= NOW()
  │  (5) Ignores job during the 120-second delay window
  │  (6) At NOW() + 120s, detects execution time arrived
  │  (7) Dispatches job to Redis queue:{queue_id}:ready as status='queued'
  ▼
Worker Fleet
  │  (8) Claims and executes job concurrently
```

---

## 4. Recurring Cron Job Flow

```
User / API Client
  │  (1) POST /api/schedules { cronExpression: '*/10 * * * *', ... }
  ▼
Node.js Backend
  │  (2) Validates cron syntax & inserts into scheduled_jobs (is_active=1)
  ▼
Python Scheduler
  │  (3) Evaluates cron using croniter(expression, base_time)
  │  (4) Computes next_run_at in UTC
  │  (5) When clock reaches next_run_at:
  │      a. Acquires Redis lock: lock:schedule:{id}
  │      b. Creates new jobs execution record in DB (status='scheduled')
  │      c. Evaluates new next_run_at timestamp
  │      d. Updates scheduled_jobs (total_runs = total_runs + 1, last_run_at, next_run_at)
  │  (6) ImmediateDispatcher pushes ready job to Redis queue
  ▼
Worker Fleet
  │  (7) Executes recurring job & records execution history
```

---

## 5. Batch Job Pipeline Flow

```
User / API Client
  │  (1) POST /api/batches { name: 'Payroll Run', jobs: [job1, job2, job3, job4] }
  ▼
Node.js Backend
  │  (2) Validates all sub-jobs in batch
  │  (3) INSERT INTO batches (total_jobs=4, pending_jobs=4, status='pending')
  │  (4) INSERT INTO jobs (batch_id, status='scheduled') for all 4 items
  ▼
Python Scheduler
  │  (5) Dispatches ready sub-jobs to Redis queues
  ▼
Worker Fleet
  │  (6) Multiple worker instances claim sub-jobs and execute concurrently
  │  (7) As items complete/fail, BatchDispatcher synchronizes batch counters:
  │      pending_jobs, running_jobs, completed_jobs, failed_jobs
  │  (8) When all jobs finish, updates batches.status to 'completed' or 'partially_failed'
```

---

## 6. Retry & Dead Letter Queue (DLQ) Flow

```
Worker Execution Fails (e.g. Network Timeout / 500 Error)
  │  (1) Worker catches exception inside execution try-catch block
  │  (2) Records failure attempt in job_executions (status='failed', error_stack)
  │  (3) Writes error log in job_logs (log_level='error')
  │  (4) Increments job.retry_count = retry_count + 1
  ▼
Retry Decision Engine
  │  (5) Checks RetryHandler.isRetryEligible(job, retryPolicy)
  ├── IF retry_count < max_retries:
  │     (6a) Calculates delay via strategy (Fixed / Linear / Exponential backoff + Jitter)
  │     (6b) UPDATE jobs SET status='scheduled', scheduled_at=NOW() + delaySeconds
  │     (6c) Python Scheduler re-dispatches when delay expires
  └── IF retries exhausted (retry_count >= max_retries):
        (7a) Routes to DlqHandler.moveToDlq()
        (7b) INSERT INTO dead_letter_queue with failure_reason, stack_trace, payload
        (7c) Sets jobs.status = 'dlq'
        (7d) Generates automated AI diagnostic root-cause summary
        (7e) Broadcasts 'JOB_MOVED_TO_DLQ' event to Dashboard
```


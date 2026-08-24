# Distributed Job Scheduler — REST API Specification

This document provides complete documentation for the REST API exposed by the **Distributed Job Scheduler (DJS)** platform.

---

## 1. Authentication & Security

All API endpoints (except `/api/auth/login` and `/api/auth/register`) require either a **Bearer JWT Token** or a **Programmatic API Key**.

### Headers
```http
Authorization: Bearer <JWT_TOKEN>
# OR
Authorization: Bearer djs_live_<API_KEY>
# OR
x-api-key: djs_live_<API_KEY>
Content-Type: application/json
```

---

## 2. API Endpoints Reference

### 2.1 Authentication & Profile (`/api/auth`)

#### `POST /api/auth/login`
Authenticates a user and returns a signed JWT and user profile.
```json
// Request Body
{
  "email": "admin@djs.io",
  "password": "AdminPassword123!"
}

// Response (200 OK)
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "u_admin_01",
      "email": "admin@djs.io",
      "role": "admin",
      "apiKey": "djs_live_admin_secret_key"
    }
  }
}
```

#### `GET /api/auth/me`
Returns the current authenticated user identity and membership scopes.

---

### 2.2 Job Management (`/api/jobs`)

#### `GET /api/jobs`
Lists jobs with filtering, pagination, and sorting.
* **Query Parameters**:
  * `projectId` (string, optional): Filter by project ID.
  * `queueId` (string, optional): Filter by queue ID.
  * `status` (string, optional): Filter by status (`queued`, `scheduled`, `running`, `completed`, `failed`, `dlq`).
  * `page` (number, default 1): Page number.
  * `limit` (number, default 20): Items per page.
  * `search` (string, optional): Filter by job name or ID.
  * `sortBy` (string, default `newest` | `priority`).

#### `POST /api/jobs`
Creates and enqueues an asynchronous job.
```json
// Request Body (Immediate Task)
{
  "projectId": "proj_123",
  "name": "Process Webhook Ingestion",
  "jobType": "http_request",
  "payload": {
    "url": "https://httpbin.org/post",
    "method": "POST",
    "body": { "event": "order_created", "amount": 99.50 }
  },
  "priority": 50,
  "timeoutSeconds": 60,
  "maxRetries": 3,
  "retryStrategy": "exponential_backoff"
}

// Request Body (Delayed Task)
{
  "projectId": "proj_123",
  "name": "Send Delayed Invoice Email",
  "jobType": "notification_event",
  "payload": { "recipient": "client@company.com", "template": "invoice_reminder" },
  "delaySeconds": 300
}
```

#### `GET /api/jobs/:id`
Returns complete details, payload, result, and execution attempts for a job.

#### `GET /api/jobs/:id/logs`
Returns streamed fine-grained checkpoint logs for a job.

#### `POST /api/jobs/:id/retry`
Manually retries a failed or dead-lettered job.

#### `DELETE /api/jobs/:id`
Cancels a pending or queued job.

---

### 2.3 Batch Ingestion (`/api/batches`)

#### `POST /api/batches`
Atomically dispatches a batch of up to 50,000 jobs.
```json
{
  "projectId": "proj_123",
  "name": "High-Throughput Image Processing Batch",
  "templateJob": {
    "name": "Compress Image Asset",
    "jobType": "cpu_compute",
    "payload": { "operations": 1000 },
    "priority": 30,
    "maxRetries": 3
  },
  "count": 500
}
```

---

### 2.4 Workflow DAGs (`/api/workflows`)

#### `POST /api/workflows/dag`
Creates a multi-stage Directed Acyclic Graph pipeline.
```json
{
  "projectId": "proj_123",
  "name": "3-Stage Production ETL Pipeline",
  "nodes": [
    {
      "id": "stage_1_extract",
      "name": "Stage 1: Extract Webhook Records",
      "jobType": "http_request",
      "payload": { "url": "https://httpbin.org/get" },
      "priority": 50
    },
    {
      "id": "stage_2_transform",
      "name": "Stage 2: Calculate Aggregations",
      "jobType": "cpu_compute",
      "payload": { "operations": 5000 },
      "priority": 40
    },
    {
      "id": "stage_3_notify",
      "name": "Stage 3: Dispatch Alerts",
      "jobType": "notification_event",
      "payload": { "recipient": "ops@djs.io" },
      "priority": 30
    }
  ],
  "edges": [
    { "from": "stage_1_extract", "to": "stage_2_transform", "condition": "on_success" },
    { "from": "stage_2_transform", "to": "stage_3_notify", "condition": "on_success" }
  ]
}
```

#### `POST /api/workflows/dependencies`
Links a dependency constraint between two existing jobs.

#### `DELETE /api/workflows/dependencies/:id`
Removes a workflow dependency constraint.

---

### 2.5 Queue Management (`/api/queues`)

* `GET /api/queues?projectId=...`: Lists all dedicated service queues with live depths and shard partitions.
* `POST /api/queues/:id/pause`: Pauses queue worker pickups.
* `POST /api/queues/:id/resume`: Resumes queue worker pickups.
* `POST /api/queues/:id/purge`: Purges pending backlog from the queue.

---

### 2.6 Worker Fleet (`/api/workers`)

* `GET /api/workers`: Lists active worker instances, status (`healthy`, `degraded`, `dead`), and concurrency loads.
* `POST /api/workers/:id/drain`: Signals a worker to gracefully drain active jobs without accepting new claims.
* `POST /api/workers/:id/stop`: Immediately stops and decommissions a worker.
* `GET /api/workers/autoscale`: Returns worker autoscaling telemetry.

---

### 2.7 Metrics & Analytics (`/api/metrics`)

* `GET /api/metrics/overview`: Total throughput, status breakdown, fleet utilization, and success rate.
* `GET /api/metrics/queue-depths`: Per-queue depth and per-shard partition loads.
* `GET /api/metrics/latency`: P50, P90, P99 execution latency distributions by job type.
* `GET /api/metrics/autoscaler`: Unified autoscaling, shard partitioning, and job-snatching telemetry.

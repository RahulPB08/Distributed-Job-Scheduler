# Component Interaction & Communication Protocols

This document details the exact communication protocols, data inputs, data outputs, and interaction mechanisms connecting all services within the Distributed Job Scheduler platform.

---

## Interaction Matrix

| Source Component | Target Component | Protocol / Mechanism | Data Exchanged | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **React Frontend** | **Node.js Backend** | HTTP/HTTPS (REST) | JSON (JWT, API Key, Job DTOs) | Authentication, job creation, queue controls, metrics |
| **Node.js Backend** | **React Frontend** | WebSockets (`/ws`) | JSON Event Stream | Live job status transitions, worker heartbeats, logs |
| **Node.js Backend** | **Relational DB** | SQLite WAL / SQL Driver | SQL Queries & Transactions | User, Org, Project, Queue, Job, Schedule persistence |
| **Node.js Backend** | **Redis Broker** | TCP (RESP Protocol) | Pub/Sub Messages, Queue Keys | Event publishing, live depth inspection, queue purge |
| **Python Scheduler** | **Relational DB** | SQLite WAL / SQL Driver | Parameterized SQL | Query ready jobs, read cron schedules, update timestamps |
| **Python Scheduler** | **Redis Broker** | TCP (RESP Protocol) | `LPUSH`, `SET NX PX`, `PUBLISH` | Enqueue ready jobs, acquire distributed locks, broadcast |
| **Node.js Workers** | **Redis Broker** | TCP (RESP Protocol) | `RPOP`, `SADD`, `SREM`, `PUBLISH` | Atomic job claim, claim release, event broadcast |
| **Node.js Workers** | **Relational DB** | SQLite WAL / SQL Driver | SQL Updates & Inserts | Create executions, insert logs, update status, write DLQ |
| **Node.js Workers** | **Execution Services** | In-Process Async / Worker Threads | Memory Pointers, Thread Messages | Route job to HTTP, DB, Thread Pool, or Notification |

---

## Detailed Communication Breakdown

```
React.js Frontend
       ↕ (REST APIs & WebSocket Stream)
Node.js Backend REST API
       ↕ (ACID Transactions & Queries)
Relational Database (13 Core Tables)
       ↕ (Read Schedules & Update Next Run)
Python Scheduler Service
       ↓ (Push Ready Jobs & Acquire Locks)
Redis Multiple Queues Broker
       ↓ (Atomic Pop & Claim)
Node.js Worker Fleet
       ↓ (Dispatch to Specialized Service)
Four Worker Execution Services
       ↓ (Write Logs, Execution Timing & Final Status)
Relational Database (Executions, Logs, DLQ)
       ↓ (Events Broadcast via Redis Pub/Sub)
WebSocket Server -> React.js Frontend
```

---

## Component Responsibilities

### 1. React.js Frontend
- **Input**: User clicks, JSON payloads, form inputs, WebSocket frames.
- **Output**: REST requests with Bearer tokens or `x-api-key`.
- **Database Access**: None directly (enforces 3-tier decoupling).

### 2. Node.js Backend REST API
- **Input**: REST HTTP requests from Frontend, external clients, webhooks.
- **Output**: JSON REST responses, WebSocket event broadcasts via Redis Pub/Sub.
- **Database Access**: Read/Write for Users, Organizations, Projects, Queues, Jobs, Batches, Schedules, DLQ, Metrics.

### 3. Python Scheduler Service
- **Input**: Database clock ticks, `scheduled_jobs` rows, `jobs` in `scheduled` state, `batches` rows, `workers` heartbeat timestamps.
- **Output**: Job payload pushed to `queue:{queue_id}:ready` in Redis, updated `next_run_at` in DB, orphan job re-queues.
- **Database Access**: Reads `scheduled_jobs`, updates `jobs.status = 'queued'`, updates `batches` progress, updates stale `workers.status`.

### 4. Node.js Worker Instances
- **Input**: Ready job payloads from Redis lists, concurrency slot availability.
- **Output**: Execution attempts in `job_executions`, step logs in `job_logs`, final results in `jobs.result`, or DLQ entries in `dead_letter_queue`.
- **Database Access**: Inserts `job_executions`, `job_logs`, `worker_heartbeats`, `dead_letter_queue`; updates `jobs.status`.


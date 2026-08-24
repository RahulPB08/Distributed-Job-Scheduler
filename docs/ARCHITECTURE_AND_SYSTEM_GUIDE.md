# Distributed Job Scheduler - Architecture & System Guide

## 1. System Overview

The Distributed Job Scheduler is a distributed, fault-tolerant job execution and task orchestration platform. It is designed with microservices separation, multi-tenant organization isolation, manual CLI worker scaling, configurable retry strategies, and real-time execution telemetry over WebSockets.

---

## 2. Microservices Architecture

```
                                  +---------------------------------------+
                                  |            React Frontend             |
                                  |     (Vite + Tailwind CSS / Port 3000) |
                                  +-------------------+-------------------+
                                                      |
                                                      v
                                  +---------------------------------------+
                                  |          API Gateway / Backend        |
                                  |         (Express.js / Port 4000)      |
                                  +--------+--------------------+---------+
                                           |                    |
                 +-------------------------+                    +-------------------------+
                 |                                                                        |
                 v                                                                        v
+---------------------------------+                                      +---------------------------------+
|      Authentication Service     |                                      |    Worker Management Service    |
|      (Express.js / Port 4001)   |                                      |     (Express.js / Port 4002)    |
| - JWT Issuance & Verification   |                                      | - Worker Node Registration      |
| - Password Hashing (Bcrypt)     |                                      | - Heartbeat Telemetry           |
| - User Directory by Email       |                                      | - Concurrency & Fleet Drain     |
| - Scoped Role Enforcement       |                                      | - Execution History Scoping     |
+----------------+----------------+                                      +----------------+----------------+
                 |                                                                        |
                 +-------------------------+                    +-------------------------+
                                           |                    |
                                           v                    v
                                  +---------------------------------------+
                                  |           SQLite Database             |
                                  |       (WAL Mode + Foreign Keys)       |
                                  +-------------------+-------------------+
                                                      ^
                                                      |
                                  +-------------------+-------------------+
                                  |             Redis Broker              |
                                  |       (Port 6379 / Ready Queues)      |
                                  +---------+-------------------+---------+
                                            ^                   ^
                                            |                   |
                                            v                   v
                               +---------------------+ +---------------------+
                               |  CLI Worker Node 1  | |  CLI Worker Node 2  |
                               | (Node.js & Threads) | | (Node.js & Threads) |
                               +---------------------+ +---------------------+
```

---

## 3. Multi-Tenant Role & Organization Model

### 3.1 User Roles
1. **System Administrator (`admin`)**:
   - Exactly one global Administrator account exists in the platform (`admin@djs.io`).
   - Global visibility across all organizations, projects, queues, batches, jobs, DLQ records, and worker telemetry.
   - Remote fleet control capabilities (drain and stop worker nodes).
2. **Developer (`developer`)**:
   - All standard users have the `developer` role.
   - Full capability to create organizations and projects.
   - Can view and manage resources only within organizations where they are members.

### 3.2 Organization Hierarchy & Access Rules
- **Organization Creation**: Any developer can create an organization. The creator automatically becomes the **Organization Leader**.
- **Member Invites**: Only the Organization Leader (or System Admin) can add new members by submitting their registered email address (`POST /api/organizations/:id/members`).
- **Organization-Scoped Projects**: All projects created within an organization are visible to all members of that organization.
- **Cross-Organization Isolation**: Users belonging to Organization A cannot view or manipulate projects, queues, batches, jobs, or DLQ records belonging to Organization B.

---

## 4. CLI Worker Pool Management

Workers run as independent Node.js processes started via the CLI:
```bash
# Start Worker Node 1 (General Queues, Concurrency 5)
cd worker
node src/index.js --worker-id=worker-alpha --concurrency=5

# Start Worker Node 2 (High Concurrency 10)
cd worker
node src/index.js --worker-id=worker-beta --concurrency=10
```

- Each worker node automatically registers its instance in the database and Redis registry upon startup.
- Nodes emit periodic heartbeats (every 3 seconds) containing active concurrency load, CPU %, RSS memory MB, and Heap memory MB.
- All executed jobs are recorded in `job_executions` with start/completion timestamps, duration in milliseconds, worker node ID, and failure diagnostics.
- The UI provides an **Execution History** table for each worker, securely scoped to the user's authorized organizations.

---

## 5. Real-Time WebSocket Architecture

- The backend runs a `RealtimeEventServer` on `/ws` subscribing to Redis Pub/Sub (`djs:events`).
- Frontend Vite dev server proxies `/ws` directly to `ws://localhost:4000` with keepalive ping-pong.
- Whenever a job is queued, claimed, running, completed, failed, retried, or cancelled, events broadcast across WebSockets and the UI updates immediately in real-time.

---

## 6. Job Scheduling & Custom Retry Engine

### 6.1 Supported Retry Strategies
Users can configure granular retry policies on individual jobs or queue templates:
- **`none` (No Retries)**: 0 retries. If the execution fails, the job immediately moves to the Dead-Letter Queue (DLQ).
- **`fixed`**: Constant interval delay between successive attempts (`baseDelay` seconds).
- **`linear_backoff`**: Delay scales linearly: `delay = baseDelay * attempt`.
- **`exponential_backoff`**: Delay scales exponentially with jitter: `delay = min(baseDelay * 2^(attempt-1), maxDelay)`.

### 6.2 Job Execution Capabilities
- **`http_request`**: Async HTTP webhook execution with custom payload and method.
- **`db_query`**: Database operation execution.
- **`cpu_compute`**: Offloaded to worker thread pools (Worker Threads) to prevent blocking the Node.js event loop during intensive hashing, encryption, or numerical computing.
- **`notification_event`**: Async notification dispatching.

---

## 7. Starting the Services

### 7.1 Standalone Authentication Service (Port 4001)
```bash
cd auth-service
npm install
npm start
```

### 7.2 Standalone Worker Management Service (Port 4002)
```bash
cd worker-service
npm install
npm start
```

### 7.3 Main API Gateway & Backend (Port 4000)
```bash
cd backend
npm install
npm start
```

### 7.4 CLI Worker Daemon
```bash
cd worker
npm install
node src/index.js --worker-id=worker-01 --concurrency=5
```

### 7.5 React Frontend (Port 3000)
```bash
cd frontend
npm install
npm run dev
```

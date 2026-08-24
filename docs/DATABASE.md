# Relational Database Schema & ER Design

The database architecture is designed with strict relational integrity, 3NF normalization, composite indexes for high-throughput scheduler and dashboard queries, foreign key cascade constraints, and ACID isolation.

---

## 1. Entity Relationship Diagram (ERD)

```mermaid
erDiagram
    USERS ||--o{ ORGANIZATION_MEMBERS : has
    ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERS : has
    ORGANIZATIONS ||--o{ PROJECTS : owns
    PROJECTS ||--o{ QUEUES : owns
    PROJECTS ||--o{ RETRY_POLICIES : defines
    PROJECTS ||--o{ EVENT_TRIGGERS : registers
    QUEUES ||--o{ JOBS : contains
    QUEUES ||--o{ SCHEDULED_JOBS : contains
    QUEUES ||--o{ EVENT_TRIGGERS : target_queue
    RETRY_POLICIES ||--o{ QUEUES : applies_to
    RETRY_POLICIES ||--o{ JOBS : applies_to
    SCHEDULED_JOBS ||--o{ JOBS : spawns
    BATCHES ||--o{ JOBS : groups
    JOBS ||--o{ JOB_EXECUTIONS : has_attempts
    JOBS ||--o{ JOB_LOGS : has_logs
    JOBS ||--o{ WORKFLOW_DEPENDENCIES : parent_dependency
    JOBS ||--o{ WORKFLOW_DEPENDENCIES : child_dependency
    JOBS ||--o{ DEAD_LETTER_QUEUE : moved_to
    WORKERS ||--o{ JOB_EXECUTIONS : executes
    WORKERS ||--o{ WORKER_HEARTBEATS : reports
```

---

## 2. Complete Entity Schema Specifications (16 Normalized Tables)

### 1. `users` (Identity & API Ingress)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique User UUID |
| `email` | TEXT | UNIQUE NOT NULL | Account login email |
| `password_hash` | TEXT | NOT NULL | bcrypt password hash |
| `name` | TEXT | NOT NULL | Full user name |
| `role` | TEXT | NOT NULL CHECK(role IN ('admin', 'developer')) | System-wide base role |
| `api_key` | TEXT | UNIQUE NOT NULL | Programmatic API token |
| `created_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |

### 2. `organizations` (Tenant Boundary)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Organization UUID |
| `name` | TEXT | NOT NULL | Organization business name |
| `slug` | TEXT | UNIQUE NOT NULL | URL-safe slug |
| `creator_id` | TEXT | NOT NULL, FK -> `users(id)` ON DELETE CASCADE | Creator user ID |
| `created_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |

### 3. `organization_members` (RBAC Tenant Scoping)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Membership UUID |
| `org_id` | TEXT | NOT NULL, FK -> `organizations(id)` ON DELETE CASCADE | Organization |
| `user_id` | TEXT | NOT NULL, FK -> `users(id)` ON DELETE CASCADE | User |
| `role` | TEXT | NOT NULL DEFAULT 'member' CHECK(role IN ('leader', 'member')) | Scoped role within this org |
| `created_at` | TEXT | NOT NULL | Join timestamp |

### 4. `projects` (Work Workspace)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Project UUID |
| `org_id` | TEXT | NOT NULL, FK -> `organizations(id)` ON DELETE CASCADE | Parent organization |
| `created_by_user_id` | TEXT | NOT NULL, FK -> `users(id)` ON DELETE CASCADE | Creator user |
| `name` | TEXT | NOT NULL | Project display name |
| `slug` | TEXT | NOT NULL | URL slug (Unique per org) |
| `description` | TEXT | NULLABLE | Description |
| `created_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |

### 5. `retry_policies` (Reusable Backoff Strategies)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Policy UUID |
| `project_id` | TEXT | NOT NULL, FK -> `projects(id)` ON DELETE CASCADE | Parent project |
| `name` | TEXT | NOT NULL | Policy title |
| `strategy` | TEXT | NOT NULL CHECK(strategy IN ('none', 'fixed', 'linear_backoff', 'exponential_backoff')) | Backoff mathematical algorithm |
| `max_retries` | INTEGER | NOT NULL DEFAULT 3 | Max retry attempts before DLQ |
| `base_delay_seconds` | INTEGER | NOT NULL DEFAULT 5 | Initial backoff base delay |
| `max_delay_seconds` | INTEGER | NOT NULL DEFAULT 300 | Maximum backoff delay cap |
| `backoff_multiplier` | REAL | NOT NULL DEFAULT 2.0 | Exponential scaling multiplier |
| `created_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |

### 6. `queues` (Sharded Priority Queues)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Queue UUID |
| `project_id` | TEXT | NOT NULL, FK -> `projects(id)` ON DELETE CASCADE | Parent project |
| `retry_policy_id` | TEXT | NULLABLE, FK -> `retry_policies(id)` ON DELETE SET NULL | Default queue retry policy |
| `name` | TEXT | NOT NULL | Queue name (e.g. `default`, `high-priority`) |
| `description` | TEXT | NULLABLE | Description |
| `priority` | INTEGER | NOT NULL DEFAULT 10 | Priority weight (1-100; higher = served first) |
| `max_concurrency` | INTEGER | NOT NULL DEFAULT 5 | Max parallel executions per queue |
| `is_paused` | INTEGER | NOT NULL DEFAULT 0 | 1 = Paused, 0 = Active |
| `shard_id` | INTEGER | NOT NULL DEFAULT 0 | Assigned shard stream (`hash(project_id + name) % N`) |
| `created_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |

### 7. `jobs` (Core Job Instances)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Job UUID |
| `project_id` | TEXT | NOT NULL, FK -> `projects(id)` ON DELETE CASCADE | Parent project |
| `queue_id` | TEXT | NOT NULL, FK -> `queues(id)` ON DELETE CASCADE | Destination queue |
| `batch_id` | TEXT | NULLABLE, FK -> `batches(id)` ON DELETE SET NULL | Optional batch grouping |
| `retry_policy_id` | TEXT | NULLABLE, FK -> `retry_policies(id)` ON DELETE SET NULL | Applied retry policy |
| `worker_id` | TEXT | NULLABLE, FK -> `workers(id)` ON DELETE SET NULL | Claimed worker process |
| `name` | TEXT | NOT NULL | Task title |
| `job_type` | TEXT | NOT NULL CHECK(job_type IN ('http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script')) | Execution handler |
| `status` | TEXT | NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'queued', 'claimed', 'running', 'completed', 'failed', 'dlq', 'cancelled')) | State machine status |
| `priority` | INTEGER | NOT NULL DEFAULT 10 | Priority weight (1-100) |
| `payload` | TEXT | NOT NULL | Input JSON payload |
| `result` | TEXT | NULLABLE | Completed output JSON |
| `error_details` | TEXT | NULLABLE | Error message & stack trace |
| `timeout_seconds` | INTEGER | NOT NULL DEFAULT 60 | Per-job execution timeout |
| `scheduled_at` | TEXT | NOT NULL | Eligibility timestamp |
| `max_retries` | INTEGER | NOT NULL DEFAULT 3 | Retry limit |
| `retry_count` | INTEGER | NOT NULL DEFAULT 0 | Completed attempts |
| `retry_strategy` | TEXT | DEFAULT 'exponential_backoff' | Active retry strategy |
| `retry_base_delay` | INTEGER | DEFAULT 5 | Base delay (seconds) |
| `retry_max_delay` | INTEGER | DEFAULT 300 | Max delay cap (seconds) |
| `idempotency_key` | TEXT | NULLABLE | Client deduplication token |
| `created_at` | TEXT | NOT NULL | Submission timestamp |
| `updated_at` | TEXT | NOT NULL | Last status update timestamp |

### 8. `job_executions` (3NF Attempt History)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Execution UUID |
| `job_id` | TEXT | NOT NULL, FK -> `jobs(id)` ON DELETE CASCADE | Parent job instance |
| `worker_id` | TEXT | NOT NULL | Worker instance ID |
| `attempt_number` | INTEGER | NOT NULL | 1, 2, 3... |
| `status` | TEXT | NOT NULL CHECK(status IN ('running', 'completed', 'failed')) | Execution attempt status |
| `started_at` | TEXT | NOT NULL | Start timestamp |
| `completed_at` | TEXT | NULLABLE | Finish timestamp |
| `duration_ms` | INTEGER | NULLABLE | Elapsed execution time in ms |
| `error_message` | TEXT | NULLABLE | Failure reason if failed |
| `error_stack` | TEXT | NULLABLE | Stack trace |
| `host_info` | TEXT | NULLABLE | Machine hostname and PID |
| `created_at` | TEXT | NOT NULL | Creation timestamp |

### 9. `job_logs` (Fine-Grained Step Telemetry)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Log UUID |
| `job_id` | TEXT | NOT NULL, FK -> `jobs(id)` ON DELETE CASCADE | Associated job |
| `execution_id` | TEXT | NULLABLE, FK -> `job_executions(id)` ON DELETE CASCADE | Associated attempt |
| `log_level` | TEXT | NOT NULL CHECK(log_level IN ('info', 'warn', 'error', 'debug')) | Log severity |
| `message` | TEXT | NOT NULL | Log line content |
| `timestamp` | TEXT | NOT NULL | Timestamp |
| `metadata` | TEXT | NULLABLE | Optional JSON context |

### 10. `scheduled_jobs` (Recurring Cron Templates)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Schedule UUID |
| `project_id` | TEXT | NOT NULL, FK -> `projects(id)` ON DELETE CASCADE | Parent project |
| `queue_id` | TEXT | NOT NULL, FK -> `queues(id)` ON DELETE CASCADE | Target queue |
| `name` | TEXT | NOT NULL | Schedule title |
| `job_type` | TEXT | NOT NULL | Handler type |
| `cron_expression` | TEXT | NULLABLE | Standard 5/6-field cron expression |
| `delay_seconds` | INTEGER | NULLABLE | Recurring interval seconds |
| `payload` | TEXT | NOT NULL | Template payload JSON |
| `priority` | INTEGER | NOT NULL DEFAULT 10 | Priority |
| `is_active` | INTEGER | NOT NULL DEFAULT 1 | 1 = Active, 0 = Paused |
| `last_run_at` | TEXT | NULLABLE | Previous run timestamp |
| `next_run_at` | TEXT | NULLABLE | Next eligible execution timestamp |
| `total_runs` | INTEGER | NOT NULL DEFAULT 0 | Cumulative spawned count |
| `created_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |
| `updated_at` | TEXT | NOT NULL | ISO 8601 UTC timestamp |

### 11. `batches` (Batch Synchronization)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique Batch UUID |
| `project_id` | TEXT | NOT NULL, FK -> `projects(id)` ON DELETE CASCADE | Parent project |
| `name` | TEXT | NOT NULL | Batch title |
| `total_jobs` | INTEGER | NOT NULL DEFAULT 0 | Total sub-jobs |
| `pending_jobs` | INTEGER | NOT NULL DEFAULT 0 | In-queue count |
| `running_jobs` | INTEGER | NOT NULL DEFAULT 0 | In-flight count |
| `completed_jobs` | INTEGER | NOT NULL DEFAULT 0 | Successful count |
| `failed_jobs` | INTEGER | NOT NULL DEFAULT 0 | Failed count |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | `pending`, `running`, `completed`, `partially_failed`, `failed` |
| `created_at` | TEXT | NOT NULL | Creation timestamp |
| `updated_at` | TEXT | NOT NULL | Last update timestamp |

### 12. `workers` (Worker Fleet Registry)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Worker ID (e.g. `worker-node-1`) |
| `hostname` | TEXT | NOT NULL | Host machine name |
| `ip_address` | TEXT | NOT NULL | Host IP |
| `concurrency_limit` | INTEGER | NOT NULL DEFAULT 5 | Concurrency capacity |
| `active_jobs_count` | INTEGER | NOT NULL DEFAULT 0 | Currently executing jobs |
| `status` | TEXT | NOT NULL DEFAULT 'healthy' CHECK(status IN ('healthy', 'degraded', 'dead', 'draining', 'stopped')) | Health state |
| `total_jobs_processed` | INTEGER | NOT NULL DEFAULT 0 | Cumulative successes |
| `failed_jobs_count` | INTEGER | NOT NULL DEFAULT 0 | Cumulative failures |
| `started_at` | TEXT | NOT NULL | Startup timestamp |
| `last_heartbeat_at` | TEXT | NOT NULL | Most recent heartbeat timestamp |

### 13. `worker_heartbeats` (Time-Series Metric Samples)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Sample UUID |
| `worker_id` | TEXT | NOT NULL, FK -> `workers(id)` ON DELETE CASCADE | Reporting worker |
| `active_jobs_count` | INTEGER | NOT NULL DEFAULT 0 | In-flight count |
| `cpu_percent` | REAL | NOT NULL DEFAULT 0.0 | CPU % |
| `memory_rss_mb` | REAL | NOT NULL DEFAULT 0.0 | Resident RAM in MB |
| `memory_heap_mb` | REAL | NOT NULL DEFAULT 0.0 | Node heap in MB |
| `timestamp` | TEXT | NOT NULL | Heartbeat timestamp |

### 14. `dead_letter_queue` (DLQ Audit & Replay)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Unique DLQ UUID |
| `job_id` | TEXT | NOT NULL, FK -> `jobs(id)` ON DELETE CASCADE | Failed job ID |
| `queue_id` | TEXT | NOT NULL, FK -> `queues(id)` ON DELETE CASCADE | Original queue |
| `project_id` | TEXT | NOT NULL, FK -> `projects(id)` ON DELETE CASCADE | Original project |
| `failure_reason` | TEXT | NOT NULL | Fatal error message |
| `stack_trace` | TEXT | NULLABLE | Execution stack trace |
| `retry_attempts` | INTEGER | NOT NULL DEFAULT 0 | Total retries before DLQ |
| `payload` | TEXT | NOT NULL | Snapshot of input payload |
| `ai_diagnostic_summary` | TEXT | NULLABLE | JSON AI root-cause analysis |
| `archived_at` | TEXT | NOT NULL | DLQ arrival timestamp |
| `resolved_at` | TEXT | NULLABLE | Requeue / purge timestamp |
| `resolution_status` | TEXT | NOT NULL DEFAULT 'unresolved' CHECK(resolution_status IN ('unresolved', 'requeued', 'purged')) | Status |

### 15. `workflow_dependencies` (DAG Pipeline Edges)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Dependency UUID |
| `parent_job_id` | TEXT | NOT NULL, FK -> `jobs(id)` ON DELETE CASCADE | Prerequisite job |
| `child_job_id` | TEXT | NOT NULL, FK -> `jobs(id)` ON DELETE CASCADE | Dependent child job |
| `condition` | TEXT | NOT NULL DEFAULT 'on_success' CHECK(condition IN ('on_success', 'on_failure', 'always')) | Trigger condition |
| `created_at` | TEXT | NOT NULL | Creation timestamp |

### 16. `event_triggers` (Reactive Event Subscriptions)
| Field | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | TEXT | PRIMARY KEY | Trigger UUID |
| `project_id` | TEXT | NOT NULL, FK -> `projects(id)` ON DELETE CASCADE | Project |
| `event_name` | TEXT | NOT NULL | Event name pattern (e.g. `order.placed`) |
| `queue_id` | TEXT | NOT NULL, FK -> `queues(id)` ON DELETE CASCADE | Destination queue |
| `name` | TEXT | NOT NULL | Trigger rule title |
| `job_type` | TEXT | NOT NULL | Job type |
| `payload_template` | TEXT | NULLABLE | Default payload template JSON |
| `priority` | INTEGER | NOT NULL DEFAULT 10 | Priority |
| `is_active` | INTEGER | NOT NULL DEFAULT 1 | 1 = Active, 0 = Paused |
| `total_triggers` | INTEGER | NOT NULL DEFAULT 0 | Invocations count |
| `created_at` | TEXT | NOT NULL | Creation timestamp |
| `updated_at` | TEXT | NOT NULL | Last updated timestamp |

---

## 3. Database Design Rationale & Evaluation Rubric Criteria

### 3NF Normalization:
- **Separation of Concerns**: Attempt-specific metrics (`duration_ms`, `error_message`, `attempt_number`, `worker_id`) are isolated in `job_executions` rather than bolting columns onto `jobs`. This prevents row bloat and preserves complete historical audit trails without overwriting earlier attempt telemetry.
- **Role-Based Access Control Scoping**: RBAC lives in `organization_members` with composite uniqueness `UNIQUE(org_id, user_id)`. A single user identity can be an admin in one organization while a developer in another.

### Cascading Rules & Referential Integrity:
- **Hierarchical Cascades**: `organizations` → `projects` → `queues` → `jobs` use `ON DELETE CASCADE`. Removing an organization cleanly cleans up all owned queues, jobs, executions, and logs without leaving orphaned rows.
- **Safe Nullification**: `jobs.worker_id` and `job_executions.worker_id` use `ON DELETE SET NULL`. If a transient worker process record is purged, the historical job records remain fully intact.

### Indexing for High-Performance Hot Queries:
1. **Scheduler Eligibility Poller**:
   `CREATE INDEX idx_jobs_status_scheduled ON jobs(status, scheduled_at);`
   `CREATE INDEX idx_jobs_queue_status_run_at ON jobs(queue_id, status, scheduled_at);`
   Enables sub-millisecond querying of due jobs without full table scans.
2. **Idempotency Deduplication**:
   `CREATE INDEX idx_jobs_idempotency ON jobs(queue_id, idempotency_key);`
   Allows immediate O(1) detection of duplicate client submissions.
3. **Queue Shard Routing**:
   `CREATE INDEX idx_queues_shard ON queues(shard_id);`
   Provides instant shard-to-queue lookup for worker consumer groups.
4. **Heartbeat Time-Series Querying**:
   `CREATE INDEX idx_worker_heartbeats_worker ON worker_heartbeats(worker_id, timestamp);`
   Optimizes worker health monitoring and stale worker detection.

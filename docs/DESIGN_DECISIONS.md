# Distributed Job Scheduler — Design Decisions & Trade-Offs

This document records the critical engineering design decisions, trade-offs, and architectural rationales implemented across the **Distributed Job Scheduler (DJS)** platform.

---

## 1. Single Authoritative Scheduler Leader vs. Multi-Scheduler Leader Election

### Decision:
Implemented a **Single Authoritative Scheduler Leader** model rather than a multi-node Raft/Paxos consensus cluster.

### Rationale:
* **Elimination of Split-Brain Anomalies**: In distributed scheduling, split-brain conditions can cause double-dispatching of delayed jobs and recurring cron routines. A single authoritative scheduler leader guarantees deterministic, linearizable time progression.
* **Deterministic Database Transactions**: Because SQLite WAL mode serializes writes with atomic transactions, a single scheduler promotes delayed records with zero contention, sub-millisecond execution times, and zero consensus latency overhead.
* **Separation of Concerns**: Scheduling promotion (time management) is separated from Worker execution (throughput management). Worker nodes scale out horizontally without needing complex leader election.

---

## 2. SQLite WAL Mode vs. External Database Engine

### Decision:
Adopted **SQLite 3 in Write-Ahead-Logging (WAL) mode** with `PRAGMA busy_timeout = 15000;` and `PRAGMA synchronous = NORMAL;`.

### Rationale:
* **Zero-Setup Portability**: The entire distributed scheduler runs standalone out-of-the-box without requiring external database provisioning.
* **Massive Concurrency**: WAL mode decouples readers and writers. Multiple concurrent worker processes can read, poll, and query execution logs simultaneously while writers serialize atomically without blocking readers.
* **Low Latency**: In-process disk I/O yields $< 1\text{ms}$ query latency compared to network round-trips with external databases.

---

## 3. Dedicated 1-Queue-Per-Service Architecture vs. Arbitrary User Queues

### Decision:
System-governed, dedicated service queues (`http-service-queue`, `db-service-queue`, `compute-service-queue`, `notification-service-queue`, `script-service-queue`) provisioned automatically per project.

### Rationale:
* **Isolation of Noisy Neighbors**: Heavy CPU workloads cannot choke fast HTTP webhook delivery because tasks execute in dedicated service lanes.
* **Zero User Operational Overhead**: Users do not need to manually configure shard partitions or queue parameters; the scheduler manages baselines and autoscaling dynamically.
* **Predictable SLOs**: Metrics and latency percentiles (P50, P90, P99) are segmented cleanly by service type.

---

## 4. Priority + Dynamic Aging vs. Strict Priority

### Decision:
Implemented dynamic time-decay aging:
$$\text{Effective Priority} = P_{\text{base}} \times 10 + \lfloor T_{\text{wait}} / 10 \rfloor$$

### Rationale:
* **Starvation Elimination**: Strict priority queues indefinitely starve low-priority background jobs during high-priority traffic spikes.
* **Fair Resource Allocation**: As jobs wait in the queue, their effective priority progressively increases until they are guaranteed execution.

---

## 5. Situation-Aware Adaptive Multi-Queue Distribution & Work-Stealing

### Decision:
Implemented a two-tier load balancing mechanism:
1. **At Ingestion / Dispatch**: In batches ($N > 5$) or when a service queue is congested ($> 12$ jobs), the load balancer dynamically interleaves jobs across alternative service queues and all active shard partitions.
2. **At Worker Claim**: Idle shards and idle queues actively snatch waiting jobs from busy queues to achieve **zero worker/shard idle time**.

### Rationale:
* Maximizes cluster utilization across all worker concurrency slots.
* Prevents traffic bursts in one service (e.g. 10,000 HTTP webhooks) from creating bottlenecks while other shards remain idle.

---

## 6. Structured 6-Checkpoint Observability Pipeline

### Decision:
Standardized all worker execution telemetry into **6 strictly defined checkpoints** streamed live over WebSockets and persisted to `job_logs`.

### Rationale:
* **Deep Inspectability**: Operators can trace the exact microsecond each stage occurred (`WORKER_STARTUP` $\rightarrow$ `REGISTRATION` $\rightarrow$ `DISCOVERY` $\rightarrow$ `ATOMIC_CLAIM` $\rightarrow$ `EXECUTION` $\rightarrow$ `COMPLETION/DLQ`).
* **Root-Cause Analysis**: When failures occur, detailed error stacks and AI classification tags are captured without interrupting worker loops.

# Central Scheduler Engine & Distributed Locking

The Distributed Job Scheduler engine is responsible for job readiness detection, cron recurrence calculation, delayed execution timing, leader-safe distributed locking, and stale worker recovery.

---

## Scheduler Modules Overview

| Module | Location | Responsibility |
| :--- | :--- | :--- |
| `SchedulerEngine` | `backend/src/services/scheduler_engine.js` | Main event loop running periodic 1.0-second dispatch ticks with graceful shutdown. |
| `DistributedLock` | `backend/src/redis/distributed_lock.js` | Implements Redis-based distributed locking (`SET key token NX PX ttl_ms` + Lua atomic release) with SQLite table fallback. |
| `CronEvaluator` | `backend/src/services/scheduler_engine.js` | Evaluates 5/6-part cron expressions in UTC and calculates next execution times. |
| `ImmediateDispatcher` | `backend/src/services/scheduler_engine.js` | Queries ready `scheduled` jobs whose `scheduled_at <= now()`, verifies workflow DAG dependencies, and promotes them to `queued`. |
| `StaleWorkerReaper` | `backend/src/services/scheduler_engine.js` | Monitors worker heartbeats; marks workers missing heartbeats for >30s as `dead`, automatically re-enqueuing any orphaned in-flight jobs. |

---

## 1. Cron Recurrence Evaluation

The `SchedulerEngine` parses standard cron expressions in UTC:
- `*/5 * * * *`: Every 5 minutes
- `0 * * * *`: Hourly at minute 0
- `0 2 * * *`: Daily at 2:00 AM UTC
- `0 0 * * 0`: Weekly on Sunday at midnight

When a schedule's `next_run_at` arrives, the scheduler creates a new `jobs` record in the database, sets its status to `queued`, updates `total_runs` and `last_run_at`, and computes the new `next_run_at`.

---

## 2. Distributed Locking Across Multi-Instance Deployments

To support high-availability clusters with multiple active scheduler instances without duplicate job promotions or dual-dispatching:

```javascript
import { DistributedLock } from '../redis/distributed_lock.js';

// Execute safe critical section protected by distributed lock
await DistributedLock.withLock(`schedule:${scheduleId}`, 5000, async (lock) => {
  // Safe single-dispatch execution across all cluster nodes
  await dispatchRecurringJob(scheduleId);
});
```

### Atomic Acquisition & Safe Lua Release:

1. **Acquire**: Executes `SET lock:djs:<resource> <token> NX PX <ttlMs>` in Redis (or atomic insertion in SQLite `system_locks` table on standalone fallback).
2. **Mutual Exclusion**: If another scheduler replica holds the lock, acquisition returns `false`, preventing race conditions.
3. **Atomic Lua Release**: Releases the key only if the token matches, preventing an expired holder from accidentally releasing a lock acquired by a newer holder:
   ```lua
   if redis.call("get", KEYS[1]) == ARGV[1] then
       return redis.call("del", KEYS[1])
   else
       return 0
   end
   ```
4. **Auto-Expiration TTL**: Prevents deadlocks if a scheduler node abruptly crashes while holding a lock.
5. **Telemetry & Monitoring**: Exposed via `GET /api/metrics/locks` and visually monitored in the Telemetry dashboard.

---

## 3. Stale Worker & Orphan Job Recovery

If a worker process crashes, loses network connectivity, or undergoes hardware failure:
1. `StaleWorkerReaper` identifies workers whose `last_heartbeat_at` is older than 30 seconds.
2. Transitions worker status to `'dead'`.
3. Finds any jobs left in `'claimed'` or `'running'` status for that worker.
4. Marks the execution attempt as failed and resets the parent `jobs` record status back to `'queued'` with `worker_id = NULL`.
5. Other healthy workers dynamically claim and finish the orphaned tasks.

---

## 4. Event-Driven Execution & Webhook Triggers

The platform provides a reactive event-driven dispatch engine that maps incoming domain events (e.g. `order.completed`, `user.registered`, `payment.received`, `sensor.alert`) to automatic background job executions.

### How Event-Driven Execution Works:

```
[External Webhook / API / Microservice]
                   │
                   ▼
     POST /api/events/publish (or /emit)
                   │
                   ▼
         [EventController Engine]
                   │
  ┌────────────────┴────────────────┐
  ▼                                 ▼
[Query Active Triggers]     [Record System Event]
  │                                 │
  ▼                                 ▼
[Payload Merge & Interpolation] [Broadcast WS EVENT_EMITTED]
  │
  ▼
[Enqueue Jobs to Redis Broker]
  │
  ▼
[Distributed Worker Fleet Claims & Executes]
```

### Event Triggers API Surface:

* `POST /api/events/publish` (or `/emit`): Emits a domain event with custom payload and source; matches all active trigger rules and immediately dispatches target background jobs.
* `GET /api/events/triggers?projectId=<id>`: Lists all configured event triggers for a project.
* `POST /api/events/triggers`: Creates a new event subscription trigger rule mapping an event name to a target queue, job type, priority, and default payload template.
* `PATCH /api/events/triggers/:id/toggle`: Pauses or activates an event trigger rule.
* `DELETE /api/events/triggers/:id`: Removes an event trigger subscription.


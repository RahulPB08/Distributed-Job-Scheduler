CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'developer')),
  api_key TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'developer', 'leader', 'member')),
  created_at TEXT NOT NULL,
  UNIQUE(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS retry_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK(strategy IN ('none', 'fixed', 'linear_backoff', 'exponential_backoff')),
  max_retries INTEGER NOT NULL DEFAULT 3,
  base_delay_seconds INTEGER NOT NULL DEFAULT 5,
  max_delay_seconds INTEGER NOT NULL DEFAULT 300,
  backoff_multiplier REAL NOT NULL DEFAULT 2.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  retry_policy_id TEXT REFERENCES retry_policies(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 10,
  max_concurrency INTEGER NOT NULL DEFAULT 5,
  is_paused INTEGER NOT NULL DEFAULT 0,
  min_shards INTEGER NOT NULL DEFAULT 4,
  max_shards INTEGER NOT NULL DEFAULT 16,
  jobs_per_shard INTEGER NOT NULL DEFAULT 500,
  shard_count INTEGER NOT NULL DEFAULT 4,
  shard_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS queue_shards (
  id TEXT PRIMARY KEY,
  logical_queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  shard_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'draining', 'disabled')),
  pending_job_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(logical_queue_id, shard_index)
);

CREATE INDEX IF NOT EXISTS idx_queue_shards_logical ON queue_shards(logical_queue_id);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  total_jobs INTEGER NOT NULL DEFAULT 0,
  pending_jobs INTEGER NOT NULL DEFAULT 0,
  running_jobs INTEGER NOT NULL DEFAULT 0,
  completed_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'partially_failed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  concurrency_limit INTEGER NOT NULL DEFAULT 5,
  active_jobs_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'healthy' CHECK(status IN ('healthy', 'degraded', 'dead', 'draining', 'stopped')),
  total_jobs_processed INTEGER NOT NULL DEFAULT 0,
  failed_jobs_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  shard_id TEXT REFERENCES queue_shards(id) ON DELETE SET NULL,
  shard_index INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
  retry_policy_id TEXT REFERENCES retry_policies(id) ON DELETE SET NULL,
  worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK(job_type IN ('http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'queued', 'claimed', 'running', 'completed', 'failed', 'dlq', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 10,
  payload TEXT NOT NULL,
  result TEXT,
  error_details TEXT,
  timeout_seconds INTEGER NOT NULL DEFAULT 60,
  scheduled_at TEXT NOT NULL,
  max_retries INTEGER NOT NULL DEFAULT 3,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_strategy TEXT DEFAULT 'exponential_backoff',
  retry_base_delay INTEGER DEFAULT 5,
  retry_max_delay INTEGER DEFAULT 300,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_executions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  error_stack TEXT,
  host_info TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_logs (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES job_executions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  log_level TEXT NOT NULL CHECK(log_level IN ('info', 'warn', 'error', 'debug')),
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK(job_type IN ('http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script')),
  cron_expression TEXT,
  delay_seconds INTEGER,
  payload TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 10,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  total_runs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  active_jobs_count INTEGER NOT NULL DEFAULT 0,
  cpu_percent REAL NOT NULL DEFAULT 0.0,
  memory_rss_mb REAL NOT NULL DEFAULT 0.0,
  memory_heap_mb REAL NOT NULL DEFAULT 0.0,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  failure_reason TEXT NOT NULL,
  stack_trace TEXT,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  ai_diagnostic_summary TEXT,
  archived_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'unresolved' CHECK(resolution_status IN ('unresolved', 'requeued', 'purged'))
);

CREATE TABLE IF NOT EXISTS workflow_dependencies (
  id TEXT PRIMARY KEY,
  parent_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  child_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  condition TEXT NOT NULL DEFAULT 'on_success' CHECK(condition IN ('on_success', 'on_failure', 'always')),
  created_at TEXT NOT NULL,
  UNIQUE(parent_job_id, child_job_id)
);

CREATE TABLE IF NOT EXISTS system_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  worker_id TEXT,
  job_id TEXT,
  queue_id TEXT,
  project_id TEXT,
  message TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_locks (
  resource TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_triggers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  queue_id TEXT NOT NULL,
  name TEXT NOT NULL,
  job_type TEXT NOT NULL,
  payload_template TEXT,
  priority INTEGER DEFAULT 10,
  is_active INTEGER DEFAULT 1,
  total_triggers INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (queue_id) REFERENCES queues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_triggers_event ON event_triggers(project_id, event_name, is_active);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_queues_project ON queues(project_id);
CREATE INDEX IF NOT EXISTS idx_queues_shard ON queues(shard_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled ON jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_status_run_at ON jobs(queue_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(queue_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_jobs_project_status ON jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON jobs(queue_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_shard ON jobs(queue_id, shard_index, status);
CREATE INDEX IF NOT EXISTS idx_jobs_worker ON jobs(worker_id);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_job_executions_job ON job_executions(job_id);
CREATE INDEX IF NOT EXISTS idx_job_executions_worker ON job_executions(worker_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_execution ON job_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_active ON scheduled_jobs(is_active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_worker ON worker_heartbeats(worker_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_dlq_project ON dead_letter_queue(project_id, resolution_status);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at DESC);

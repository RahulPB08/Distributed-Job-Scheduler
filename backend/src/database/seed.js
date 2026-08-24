import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { initDb, run, get, all } from './db.js';

export const seedDatabase = async () => {
  await initDb();

  const existingAdmin = await get('SELECT id FROM users WHERE email = ?', ['admin@djs.io']);
  if (existingAdmin) {
    process.stdout.write('Database already initialized and seeded.\n');
    return;
  }

  const now = new Date().toISOString();
  const adminId = 'u_admin_00000000000000000000001';
  const devId = 'u_dev_00000000000000000000000002';
  const orgId = 'org_default_00000000000000000001';
  const devOrgId = 'org_dev_000000000000000000000002';

  const adminPassHash = await bcrypt.hash('AdminPassword123!', 10);
  const devPassHash = await bcrypt.hash('DevPassword123!', 10);

  const adminApiKey = `djs_${uuidv4().replace(/-/g, '')}`;
  const devApiKey = `djs_${uuidv4().replace(/-/g, '')}`;

  await run(
    'INSERT INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [adminId, 'admin@djs.io', adminPassHash, 'System Administrator', 'admin', adminApiKey, now, now]
  );

  await run(
    'INSERT INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [devId, 'dev@djs.io', devPassHash, 'Alex Developer', 'developer', devApiKey, now, now]
  );

  await run(
    'INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, 'Primary Infrastructure Org', 'primary-org', adminId, now, now]
  );

  await run(
    'INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [devOrgId, 'Developer Team Org', 'dev-team-org', devId, now, now]
  );

  await run(
    'INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), orgId, adminId, 'leader', now]
  );

  await run(
    'INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), devOrgId, devId, 'leader', now]
  );

  const defaultProjectId = 'p_default_0000000000000000001';
  const devProjectId = 'p_dev_00000000000000000000002';

  await run(
    'INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [defaultProjectId, orgId, adminId, 'Core Infrastructure', 'core-infra', 'System-wide core queues and workers', now, now]
  );

  await run(
    'INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [devProjectId, devOrgId, devId, 'Developer Workloads', 'dev-workloads', 'Primary asynchronous workload pipeline', now, now]
  );

  const policy1Id = 'pol_exp_000000000000000001';
  const policy2Id = 'pol_lin_000000000000000002';

  await run(
    'INSERT INTO retry_policies (id, project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds, backoff_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [policy1Id, defaultProjectId, 'Standard Exponential Backoff', 'exponential_backoff', 3, 5, 300, 2.0, now, now]
  );

  await run(
    'INSERT INTO retry_policies (id, project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds, backoff_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [policy2Id, devProjectId, 'Fast Linear Retry', 'linear_backoff', 3, 2, 60, 1.0, now, now]
  );

  // Define 1 service queue per service with 2 initial shards
  const serviceQueues = [
    { name: 'http-service-queue', jobType: 'http_request', description: 'Automated System Queue for HTTP Services', priority: 10, maxConcurrency: 5 },
    { name: 'db-service-queue', jobType: 'db_query', description: 'Automated System Queue for Database Operations', priority: 15, maxConcurrency: 5 },
    { name: 'compute-service-queue', jobType: 'cpu_compute', description: 'Automated System Queue for CPU Compute Services', priority: 20, maxConcurrency: 5 },
    { name: 'notification-service-queue', jobType: 'notification_event', description: 'Automated System Queue for Notifications & Alerts', priority: 25, maxConcurrency: 5 },
    { name: 'script-service-queue', jobType: 'custom_script', description: 'Automated System Queue for Custom Script Workloads', priority: 10, maxConcurrency: 5 },
  ];

  const projectsToSeed = [defaultProjectId, devProjectId];
  let sampleHttpQueueId = null;
  let sampleNotificationQueueId = null;

  for (const pId of projectsToSeed) {
    for (const sq of serviceQueues) {
      const qId = `q_${sq.name.slice(0, 4)}_${pId.slice(-4)}_${Math.random().toString(36).slice(2, 6)}`;
      if (pId === defaultProjectId && sq.name === 'http-service-queue') sampleHttpQueueId = qId;
      if (pId === defaultProjectId && sq.name === 'notification-service-queue') sampleNotificationQueueId = qId;

      await run(
        `INSERT INTO queues (
          id, project_id, retry_policy_id, name, description, priority, max_concurrency, is_paused,
          min_shards, max_shards, jobs_per_shard, shard_count, shard_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 2, 16, 15, 2, 0, ?, ?)`,
        [qId, pId, policy1Id, sq.name, sq.description, sq.priority, sq.maxConcurrency, now, now]
      );

      // Create initial 2 shards
      for (let i = 0; i < 2; i++) {
        const shardId = `qs_${qId.slice(0, 8)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        await run(
          'INSERT INTO queue_shards (id, logical_queue_id, shard_index, status, pending_job_count, created_at, updated_at) VALUES (?, ?, ?, "active", 0, ?, ?)',
          [shardId, qId, i, now, now]
        );
      }
    }
  }

  // Seed sample jobs
  const sampleJob1Id = 'job_sample_00000000000000001';
  await run(
    `INSERT INTO jobs (
      id, project_id, queue_id, shard_index, name, job_type, status, priority, payload,
      timeout_seconds, scheduled_at, max_retries, retry_count,
      retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      sampleJob1Id,
      defaultProjectId,
      sampleNotificationQueueId,
      'Welcome Email Dispatch',
      'notification_event',
      'queued',
      25,
      JSON.stringify({ to: 'customer@example.com', subject: 'Welcome to Distributed Job Scheduler', template: 'welcome_v1' }),
      30,
      now,
      3,
      'exponential_backoff',
      5,
      300,
      now,
      now
    ]
  );

  const sampleJob2Id = 'job_sample_00000000000000002';
  await run(
    `INSERT INTO jobs (
      id, project_id, queue_id, shard_index, name, job_type, status, priority, payload,
      timeout_seconds, scheduled_at, max_retries, retry_count,
      retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      sampleJob2Id,
      defaultProjectId,
      sampleHttpQueueId,
      'Hourly System Health Report',
      'http_request',
      'queued',
      10,
      JSON.stringify({ url: 'https://httpbin.org/get', method: 'GET', timeout: 5000 }),
      30,
      now,
      3,
      'exponential_backoff',
      5,
      300,
      now,
      now
    ]
  );

  process.stdout.write('Database seeded successfully with 1 queue per service (2 baseline shards each), Admin and Dev accounts.\n');
};

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seedDatabase().then(() => process.exit(0)).catch((err) => {
    process.stderr.write(String(err));
    process.exit(1);
  });
}

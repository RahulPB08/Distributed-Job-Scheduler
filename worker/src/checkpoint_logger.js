// Rich, formatted checkpoint logger for Distributed Job Scheduler with persistent SQLite event recording
import { v4 as uuidv4 } from 'uuid';

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  white: '\x1b[37m'
};

export class CheckpointLogger {
  static db = null;

  static init(db) {
    this.db = db;
    // Ensure system_events table exists
    if (this.db) {
      this.db.run(`
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
        )
      `, () => {});
    }
  }

  static async logEvent(eventType, { workerId = null, jobId = null, queueId = null, projectId = null, message = '', payload = {} } = {}) {
    if (!this.db) return;
    try {
      const id = uuidv4();
      const now = new Date().toISOString();
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
      this.db.run(
        `INSERT INTO system_events (id, event_type, worker_id, job_id, queue_id, project_id, message, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, eventType, workerId, jobId, queueId, projectId, message, payloadStr, now],
        () => {}
      );
    } catch (e) {}
  }

  static timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  static header(title) {
    const bar = '━'.repeat(64);
    process.stdout.write(`\n${COLORS.bright}${COLORS.cyan}${bar}${COLORS.reset}\n`);
    process.stdout.write(`${COLORS.bright}${COLORS.cyan} ⚙ ${title.toUpperCase()}${COLORS.reset}\n`);
    process.stdout.write(`${COLORS.bright}${COLORS.cyan}${bar}${COLORS.reset}\n`);
  }

  static checkpoint(step, totalSteps, name, details = {}) {
    const time = this.timestamp();
    const tag = `[CHECKPOINT ${step}/${totalSteps}: ${name}]`;
    process.stdout.write(`\n${COLORS.bright}${COLORS.bgCyan}${COLORS.white} ${tag} ${COLORS.reset} ${COLORS.dim}${time}${COLORS.reset}\n`);
    
    for (const [key, val] of Object.entries(details)) {
      if (val !== undefined && val !== null) {
        const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
        process.stdout.write(`  ${COLORS.cyan}▸ ${key.padEnd(20)}:${COLORS.reset} ${COLORS.bright}${valStr}${COLORS.reset}\n`);
      }
    }

    this.logEvent(`CHECKPOINT_${name}`, {
      workerId: details.workerId || null,
      jobId: details.jobId || null,
      queueId: details.queueId || null,
      message: `${tag} executed on ${details.workerId || 'worker'}`,
      payload: details
    });
  }

  static info(msg, meta = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.blue}ℹ [INFO]${COLORS.reset} ${msg}\n`);
    if (meta) {
      process.stdout.write(`  ${COLORS.dim}↳ ${JSON.stringify(meta)}${COLORS.reset}\n`);
    }
    this.logEvent('WORKER_INFO', {
      message: msg,
      payload: meta || {}
    });
  }

  static success(msg, meta = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.green}✔ [SUCCESS]${COLORS.reset} ${COLORS.bright}${msg}${COLORS.reset}\n`);
    if (meta) {
      process.stdout.write(`  ${COLORS.dim}↳ ${JSON.stringify(meta)}${COLORS.reset}\n`);
    }
    this.logEvent('WORKER_SUCCESS', {
      message: msg,
      payload: meta || {}
    });
  }

  static warn(msg, meta = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.yellow}⚠ [WARN]${COLORS.reset} ${msg}\n`);
    if (meta) {
      process.stdout.write(`  ${COLORS.dim}↳ ${JSON.stringify(meta)}${COLORS.reset}\n`);
    }
    this.logEvent('WORKER_WARN', {
      message: msg,
      payload: meta || {}
    });
  }

  static error(msg, err = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.red}✖ [ERROR]${COLORS.reset} ${COLORS.bright}${msg}${COLORS.reset}\n`);
    if (err) {
      const errStr = err.stack || err.message || JSON.stringify(err);
      process.stdout.write(`  ${COLORS.red}↳ ${errStr}${COLORS.reset}\n`);
    }
    this.logEvent('WORKER_ERROR', {
      message: msg,
      payload: { error: err?.message || String(err) }
    });
  }

  static queueDiscoveryTable(queues) {
    process.stdout.write(`\n${COLORS.bright}${COLORS.magenta}  DISCOVERED QUEUES (${queues.length})${COLORS.reset}\n`);
    process.stdout.write(`  ${'NAME'.padEnd(22)} ${'PRIO'.padEnd(8)} ${'MAX CONC'.padEnd(12)} ${'PAUSED'.padEnd(10)} ${'PROJECT'.padEnd(20)}\n`);
    process.stdout.write(`  ${'─'.repeat(74)}\n`);
    for (const q of queues) {
      const pausedStr = q.is_paused ? `${COLORS.red}YES${COLORS.reset}` : `${COLORS.green}NO${COLORS.reset}`;
      process.stdout.write(`  ${(q.name || q.id).padEnd(22)} ${String(q.priority || 10).padEnd(8)} ${String(q.max_concurrency || 5).padEnd(12)} ${pausedStr.padEnd(19)} ${(q.project_name || q.project_id || '-').padEnd(20)}\n`);
    }
    process.stdout.write(`  ${'─'.repeat(74)}\n\n`);
  }

  static heartbeat(workerId, activeJobs, concurrency, cpu, memMb) {
    const time = this.timestamp();
    console.log(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.magenta}♥ [HEARTBEAT]${COLORS.reset} Worker: ${COLORS.bright}${workerId}${COLORS.reset} | Slots: ${activeJobs}/${concurrency} | CPU: ${cpu}% | RAM: ${memMb}MB`);
    this.logEvent('WORKER_HEARTBEAT', {
      workerId,
      message: `Worker ${workerId} active: ${activeJobs}/${concurrency} | CPU: ${cpu}% | RAM: ${memMb}MB`,
      payload: { workerId, activeJobs, concurrency, cpu, memMb }
    });
  }
}

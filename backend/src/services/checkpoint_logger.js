// Rich, formatted checkpoint logger for Backend & Scheduler

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
  static timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  static header(title) {
    const bar = '━'.repeat(64);
    process.stdout.write(`\n${COLORS.bright}${COLORS.blue}${bar}${COLORS.reset}\n`);
    process.stdout.write(`${COLORS.bright}${COLORS.blue} ⚡ ${title.toUpperCase()}${COLORS.reset}\n`);
    process.stdout.write(`${COLORS.bright}${COLORS.blue}${bar}${COLORS.reset}\n`);
  }

  static checkpoint(step, totalSteps, name, details = {}) {
    const time = this.timestamp();
    const tag = `[CHECKPOINT ${step}/${totalSteps}: ${name}]`;
    process.stdout.write(`\n${COLORS.bright}${COLORS.bgBlue}${COLORS.white} ${tag} ${COLORS.reset} ${COLORS.dim}${time}${COLORS.reset}\n`);
    
    for (const [key, val] of Object.entries(details)) {
      if (val !== undefined && val !== null) {
        const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
        process.stdout.write(`  ${COLORS.blue}▸ ${key.padEnd(20)}:${COLORS.reset} ${COLORS.bright}${valStr}${COLORS.reset}\n`);
      }
    }
  }

  static info(msg, meta = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.blue}ℹ [INFO]${COLORS.reset} ${msg}\n`);
    if (meta) {
      process.stdout.write(`  ${COLORS.dim}↳ ${JSON.stringify(meta)}${COLORS.reset}\n`);
    }
  }

  static success(msg, meta = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.green}✔ [SUCCESS]${COLORS.reset} ${COLORS.bright}${msg}${COLORS.reset}\n`);
    if (meta) {
      process.stdout.write(`  ${COLORS.dim}↳ ${JSON.stringify(meta)}${COLORS.reset}\n`);
    }
  }

  static warn(msg, meta = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.yellow}⚠ [WARN]${COLORS.reset} ${msg}\n`);
    if (meta) {
      process.stdout.write(`  ${COLORS.dim}↳ ${JSON.stringify(meta)}${COLORS.reset}\n`);
    }
  }

  static error(msg, err = null) {
    const time = this.timestamp();
    process.stdout.write(`${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.red}✖ [ERROR]${COLORS.reset} ${COLORS.bright}${msg}${COLORS.reset}\n`);
    if (err) {
      const errStr = err.stack || err.message || JSON.stringify(err);
      process.stdout.write(`  ${COLORS.red}↳ ${errStr}${COLORS.reset}\n`);
    }
  }
}

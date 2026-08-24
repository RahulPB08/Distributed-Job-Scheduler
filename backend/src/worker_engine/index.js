import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import dotenv from 'dotenv';
import { WorkerInstance } from './worker.js';
import { ShutdownManager } from './shutdown.js';
import { CheckpointLogger } from './checkpoint_logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {};

  for (const arg of args) {
    if (arg.startsWith('--worker-id=')) {
      options.workerId = arg.split('=')[1];
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = arg.split('=')[1];
    } else if (arg.startsWith('--queues=')) {
      options.queues = arg.split('=')[1];
    } else if (arg.startsWith('--poll-interval=')) {
      options.pollInterval = arg.split('=')[1];
    } else if (arg.startsWith('--project-id=')) {
      options.projectId = arg.split('=')[1];
    }
  }

  return options;
};

const main = async () => {
  const cliOptions = parseArgs();

  // Find DB path: environment, root, or backend directory
  const defaultDbPath = path.resolve(__dirname, '../../backend/djs_database.sqlite');
  const dbPath = process.env.DB_PATH || defaultDbPath;

  const sqlite = sqlite3.verbose();
  const db = new sqlite.Database(dbPath);

  // Set high-concurrency pragmas
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA busy_timeout = 15000;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run('PRAGMA foreign_keys = ON;');
  });

  const worker = new WorkerInstance({
    ...cliOptions,
    db
  });

  ShutdownManager.setupGracefulShutdown(worker);
  await worker.start();
};

main().catch((err) => {
  CheckpointLogger.error(`Fatal worker process error: ${err.message}`, err);
  process.exit(1);
});

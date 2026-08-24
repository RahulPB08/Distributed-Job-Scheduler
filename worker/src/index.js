import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import dotenv from 'dotenv';
import { workerPool } from './worker_pool.js';
import { WorkerApiServer } from './api_server.js';
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

  CheckpointLogger.init(db);
  CheckpointLogger.header('Initializing Dynamic Worker Deployment Service');

  // Initialize pool manager with shared SQLite DB
  workerPool.init(cliOptions, db);

  // Deploy baseline worker instance(s)
  const initialWorkerId = cliOptions.workerId || `worker-primary-${Math.floor(Math.random() * 900 + 100)}`;
  await workerPool.deployWorker({
    ...cliOptions,
    workerId: initialWorkerId
  });

  // Start Worker Deployment API Server (for dynamic remote autoscaling from Backend)
  const apiServer = new WorkerApiServer(process.env.WORKER_API_PORT || 5001);
  apiServer.start();

  // Setup graceful shutdown
  const handleShutdown = async (signal) => {
    CheckpointLogger.warn(`[SHUTDOWN] Received ${signal}. Shutting down worker fleet...`);
    apiServer.stop();
    await workerPool.shutdownAll();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
};

main().catch((err) => {
  CheckpointLogger.error(`Fatal worker process error: ${err.message}`, err);
  process.exit(1);
});

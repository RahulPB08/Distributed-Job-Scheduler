import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default: the scheduler shares the same SQLite DB as the backend
const defaultDbPath = path.resolve(__dirname, '../../backend/djs_database.sqlite');

export const CONFIG = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  DB_PATH: process.env.DB_PATH || defaultDbPath,
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
  // Scheduler tick rate in milliseconds
  POLL_INTERVAL_MS: parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS || '2000', 10),
  // How many seconds without a heartbeat before a worker is declared dead
  STALE_WORKER_THRESHOLD_SEC: parseInt(process.env.STALE_WORKER_THRESHOLD_SEC || '30', 10),
  // Leader-election lock TTL (ms) — scheduler holds this to stay as sole active scheduler
  LEADER_LOCK_TTL_MS: parseInt(process.env.SCHEDULER_LEADER_LOCK_TTL_MS || '10000', 10),
};

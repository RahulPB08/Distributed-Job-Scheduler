import http from 'http';
import { createApp } from './app.js';
import { ENV } from './config/env.js';
import { initDb, all } from './database/db.js';
import { seedDatabase } from './database/seed.js';
import { startRedisBrokerIfNeeded } from './redis/redis_client.js';
import { QueueManager } from './redis/queue_manager.js';
import { RealtimeEventServer } from './websocket/ws_server.js';
import { CheckpointLogger } from './services/checkpoint_logger.js';

const recoverQueuedJobs = async () => {
  const orphaned = await all(
    "SELECT * FROM jobs WHERE status = 'queued'",
    []
  );
  for (const job of orphaned) {
    try {
      const parsed = {
        ...job,
        payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload
      };
      await QueueManager.enqueueJob(job.queue_id, parsed, job.priority || 10);
    } catch (e) {}
  }
  if (orphaned.length > 0) {
    CheckpointLogger.info(`Recovered ${orphaned.length} queued job(s) from database`);
  }
};

const startServer = async () => {
  try {
    CheckpointLogger.header('Initializing Distributed Job Scheduler Backend');
    
    // Step 1: Redis broker fallback
    await startRedisBrokerIfNeeded();

    // Step 2: Database Initialization & Seeding
    await initDb();
    await seedDatabase();

    // Step 3: Job recovery
    await recoverQueuedJobs();

    // Step 4: Express HTTP & WebSocket Server
    const app = createApp();
    const server = http.createServer(app);
    const wsServer = new RealtimeEventServer(server);
    wsServer.start();

    // Step 5: Start Fleet Auto-Scaler, Queue Shard Autoscaler, and Queue/Shard Snatcher
    const { WorkerAutoScalerService, QueueAutoScalerService, QueueShardSnatcherService } = await import('./autoscaling/index.js');
    WorkerAutoScalerService.start();
    QueueAutoScalerService.start();
    QueueShardSnatcherService.start();

    server.listen(ENV.PORT, '0.0.0.0', () => {
      CheckpointLogger.checkpoint(1, 1, 'BACKEND_ONLINE', {
        httpUrl: `http://localhost:${ENV.PORT}`,
        wsUrl: `ws://localhost:${ENV.PORT}/ws`,
        environment: ENV.NODE_ENV,
        database: ENV.DB_PATH
      });
    });

    const shutdown = () => {
      CheckpointLogger.warn('Shutting down backend services...');
      wsServer.stop();
      server.close(() => {
        CheckpointLogger.info('Backend server gracefully closed');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    CheckpointLogger.error('Failed to start backend', err);
    process.exit(1);
  }
};

startServer();

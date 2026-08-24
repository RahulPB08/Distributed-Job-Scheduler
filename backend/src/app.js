import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.routes.js';
import organizationRoutes from './routes/organization.routes.js';
import projectRoutes from './routes/project.routes.js';
import queueRoutes from './routes/queue.routes.js';
import jobRoutes from './routes/job.routes.js';
import batchRoutes from './routes/batch.routes.js';
import scheduleRoutes from './routes/schedule.routes.js';
import workerRoutes from './routes/worker.routes.js';
import executionRoutes from './routes/execution.routes.js';
import dlqRoutes from './routes/dlq.routes.js';
import workflowRoutes from './routes/workflow.routes.js';
import metricsRoutes from './routes/metrics.routes.js';
import eventRoutes from './routes/event.routes.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';
import { apiRateLimiter } from './middlewares/rate_limit.middleware.js';
import retryPolicyRoutes from './routes/retry_policy.routes.js';

export const createApp = () => {
  const app = express();

  app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      service: 'distributed-job-scheduler-backend',
      timestamp: new Date().toISOString()
    });
  });

  // Global API Sliding Window Rate Limiting
  app.use('/api', apiRateLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api/organizations', organizationRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/queues', queueRoutes);
  app.use('/api/jobs', jobRoutes);
  app.use('/api/batches', batchRoutes);
  app.use('/api/schedules', scheduleRoutes);
  app.use('/api/workers', workerRoutes);
  app.use('/api/executions', executionRoutes);
  app.use('/api/dlq', dlqRoutes);
  app.use('/api/workflows', workflowRoutes);
  app.use('/api/metrics', metricsRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/retry-policies', retryPolicyRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

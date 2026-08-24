import { Router } from 'express';
import { MetricsController } from '../controllers/metrics.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/overview', MetricsController.getOverview);
router.get('/throughput', MetricsController.getThroughput);
router.get('/latency', MetricsController.getLatency);
router.get('/queue-depths', MetricsController.getQueueDepths);
router.get('/events', MetricsController.getEvents);
router.get('/locks', MetricsController.getLocks);
router.get('/autoscaler', MetricsController.getAutoscalerMetrics);

export default router;


import { Router } from 'express';
import { WorkerController } from '../controllers/worker.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAdmin } from '../middlewares/rbac.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', WorkerController.list);
router.get('/autoscale', WorkerController.getAutoscale);
router.put('/autoscale', requireAdmin, WorkerController.updateAutoscale);
router.post('/scale', requireAdmin, WorkerController.scaleFleet);
router.post('/provision', requireAdmin, WorkerController.provision);
router.get('/:id/executions', WorkerController.getExecutions);
router.post('/:id/drain', requireAdmin, WorkerController.drain);
router.post('/:id/stop', requireAdmin, WorkerController.stop);
router.get('/:id', WorkerController.getById);

export default router;

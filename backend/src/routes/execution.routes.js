import { Router } from 'express';
import { ExecutionController } from '../controllers/execution.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', ExecutionController.list);
router.get('/:id', ExecutionController.getById);
router.get('/:id/logs', ExecutionController.getLogs);

export default router;


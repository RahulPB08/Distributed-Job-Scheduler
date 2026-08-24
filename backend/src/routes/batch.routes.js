import { Router } from 'express';
import { BatchController, batchCreateSchema } from '../controllers/batch.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { jobDispatchRateLimiter } from '../middlewares/rate_limit.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', BatchController.list);
router.post('/', authorize(['admin', 'developer']), jobDispatchRateLimiter, validate(batchCreateSchema), BatchController.create);
router.get('/:id', BatchController.getById);
router.post('/:id/cancel', authorize(['admin', 'developer']), BatchController.cancel);

export default router;


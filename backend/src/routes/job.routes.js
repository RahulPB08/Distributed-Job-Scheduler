import { Router } from 'express';
import { JobController, jobCreateSchema } from '../controllers/job.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { jobDispatchRateLimiter } from '../middlewares/rate_limit.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', JobController.list);
router.post('/', authorize(['admin', 'developer']), jobDispatchRateLimiter, validate(jobCreateSchema), JobController.create);
router.get('/:id', JobController.getById);
router.post('/:id/retry', authorize(['admin', 'developer']), JobController.retry);
router.post('/:id/cancel', authorize(['admin', 'developer']), JobController.cancel);
router.get('/:id/logs', JobController.getLogs);

export default router;


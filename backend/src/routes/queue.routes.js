import { Router } from 'express';
import { QueueController, queueSchema } from '../controllers/queue.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', QueueController.list);
router.post('/', authorize(['admin', 'developer']), validate(queueSchema), QueueController.create);
router.get('/:id', QueueController.getById);
router.put('/:id', authorize(['admin', 'developer']), QueueController.update);
router.post('/:id/pause', authorize(['admin', 'developer']), QueueController.pause);
router.post('/:id/resume', authorize(['admin', 'developer']), QueueController.resume);
router.post('/:id/purge', authorize(['admin', 'developer']), QueueController.purge);
router.post('/:id/shards/scale', authorize(['admin', 'developer']), QueueController.scaleShards);
router.delete('/:id', authorize(['admin', 'developer']), QueueController.delete);
router.get('/:id/stats', QueueController.getStats);

export default router;


import { Router } from 'express';
import { DlqController } from '../controllers/dlq.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', DlqController.list);
router.get('/:id', DlqController.getById);
router.post('/:id/diagnose', authorize(['admin', 'developer']), DlqController.diagnose);
router.post('/:id/retry', authorize(['admin', 'developer']), DlqController.retry);
router.post('/bulk-retry', authorize(['admin', 'developer']), DlqController.bulkRetry);
router.post('/:id/purge', authorize(['admin', 'developer']), DlqController.purge);

export default router;


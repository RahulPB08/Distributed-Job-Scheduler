import { Router } from 'express';
import { ProjectController, projectSchema, retryPolicySchema } from '../controllers/project.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', ProjectController.list);
router.post('/', authorize(['admin', 'developer']), validate(projectSchema), ProjectController.create);
router.get('/:id', ProjectController.getById);
router.put('/:id', authorize(['admin', 'developer']), ProjectController.update);
router.delete('/:id', authorize(['admin']), ProjectController.delete);
router.get('/:id/stats', ProjectController.getStats);
router.get('/:id/retry-policies', ProjectController.listRetryPolicies);
router.post('/:id/retry-policies', authorize(['admin', 'developer']), validate(retryPolicySchema), ProjectController.createRetryPolicy);

export default router;


import { Router } from 'express';
import { RetryPolicyController } from '../controllers/retry_policy.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authenticate);

// Scoped to project:
// GET    /api/projects/:projectId/retry-policies
// POST   /api/projects/:projectId/retry-policies

// Standalone (by policy id):
// GET    /api/retry-policies/:id
// PATCH  /api/retry-policies/:id
// DELETE /api/retry-policies/:id

// Project-scoped routes (handled in project.routes.js via mergeParams)
// These are mounted at /api/projects/:projectId/retry-policies
router.get('/', RetryPolicyController.list);
router.post('/', RetryPolicyController.create);

// Individual policy routes (mounted at /api/retry-policies)
router.get('/:id', RetryPolicyController.getById);
router.patch('/:id', RetryPolicyController.update);
router.delete('/:id', RetryPolicyController.delete);

export default router;

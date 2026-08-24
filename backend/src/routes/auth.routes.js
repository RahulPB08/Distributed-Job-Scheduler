import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAdmin } from '../middlewares/rbac.middleware.js';
import { authRateLimiter } from '../middlewares/rate_limit.middleware.js';

const router = Router();

router.post('/register', authRateLimiter, AuthController.register);
router.post('/login', authRateLimiter, AuthController.login);
router.get('/me', authenticate, AuthController.getMe);
router.post('/api-key', authenticate, AuthController.regenerateApiKey);
router.get('/users/by-email', authenticate, AuthController.getUserByEmail);
router.get('/users', authenticate, requireAdmin, AuthController.listUsers);
router.delete('/users/:id', authenticate, requireAdmin, AuthController.deleteUser);

export default router;

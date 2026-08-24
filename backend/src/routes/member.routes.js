import { Router } from 'express';
import { MemberController } from '../controllers/member.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

// All member management routes require authentication
router.use(authenticate);

// GET    /api/organizations/:orgId/members        — list all members
router.get('/:orgId/members', MemberController.list);

// POST   /api/organizations/:orgId/members        — invite a user (admin-only)
router.post('/:orgId/members', MemberController.invite);

// PATCH  /api/organizations/:orgId/members/:userId — change role (admin-only)
router.patch('/:orgId/members/:userId', MemberController.updateRole);

// DELETE /api/organizations/:orgId/members/:userId — remove member (admin-only)
router.delete('/:orgId/members/:userId', MemberController.remove);

export default router;

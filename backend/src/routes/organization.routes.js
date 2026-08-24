import { Router } from 'express';
import { OrganizationController } from '../controllers/organization.controller.js';
import { MemberController } from '../controllers/member.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authenticate);

// Org CRUD
router.get('/', OrganizationController.list);
router.post('/', OrganizationController.create);
router.get('/:id', OrganizationController.getById);
router.patch('/:id', OrganizationController.update);
router.delete('/:id', OrganizationController.delete);

// Member management (with per-org RBAC enforcement)
router.get('/:orgId/members', MemberController.list);
router.post('/:orgId/members', MemberController.invite);
router.patch('/:orgId/members/:userId', MemberController.updateRole);
router.delete('/:orgId/members/:userId', MemberController.remove);

export default router;



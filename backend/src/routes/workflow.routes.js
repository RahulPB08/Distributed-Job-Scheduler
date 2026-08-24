import { Router } from 'express';
import { WorkflowController, createDAGSchema } from '../controllers/workflow.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', WorkflowController.listDAGs);
router.get('/dag', WorkflowController.listDAGs);
router.post('/dag', authorize(['admin', 'developer']), validate(createDAGSchema), WorkflowController.createDAG);
router.post('/dependencies', authorize(['admin', 'developer']), WorkflowController.addDependency);
router.delete('/dependencies/:id', authorize(['admin', 'developer']), WorkflowController.removeDependency);

export default router;

import { Router } from 'express';
import { ScheduleController, scheduleCreateSchema } from '../controllers/schedule.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';

const router = Router();

router.use(authenticate);

router.get('/', ScheduleController.list);
router.post('/', authorize(['admin', 'developer']), validate(scheduleCreateSchema), ScheduleController.create);
router.get('/:id', ScheduleController.getById);
router.put('/:id', authorize(['admin', 'developer']), ScheduleController.update);
router.post('/:id/toggle', authorize(['admin', 'developer']), ScheduleController.toggle);
router.post('/:id/trigger', authorize(['admin', 'developer']), ScheduleController.trigger);
router.delete('/:id', authorize(['admin', 'developer']), ScheduleController.delete);

export default router;


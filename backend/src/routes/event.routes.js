import { Router } from 'express';
import { EventController, createTriggerSchema, emitEventSchema } from '../controllers/event.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authorize } from '../middlewares/rbac.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';

const router = Router();

router.use(authenticate);

router.post('/emit', validate(emitEventSchema), EventController.emitEvent);
router.post('/publish', validate(emitEventSchema), EventController.emitEvent);
router.get('/triggers', EventController.listTriggers);
router.post('/triggers', authorize(['admin', 'developer']), validate(createTriggerSchema), EventController.createTrigger);
router.patch('/triggers/:id/toggle', authorize(['admin', 'developer']), EventController.toggleTrigger);
router.delete('/triggers/:id', authorize(['admin', 'developer']), EventController.deleteTrigger);

export default router;

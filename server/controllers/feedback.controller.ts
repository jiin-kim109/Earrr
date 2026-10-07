import { Router } from 'express';
import { feedbackSchema } from '../../shared/schemas/feedback.js';
import { requestGame } from '../request-context.js';
import type { LearningWorkspace } from '../services/storage/workspace.js';
import type { FeedbackRepository } from '../repositories/feedback.repository.js';

export function feedbackRoutes(feedback: FeedbackRepository) {
  const router = Router();
  router.post('/feedback', async (req, res) => {
    const input = feedbackSchema.parse(req.body);
    const workspace: LearningWorkspace | undefined = res.locals.workspace;
    const actorId = workspace ? `${workspace.kind}:${workspace.id}` : 'local';
    const session = await requestGame(res).store.sessions.active();
    await feedback.save(actorId, session?.id ?? null, input);
    res.sendStatus(204);
  });
  return router;
}

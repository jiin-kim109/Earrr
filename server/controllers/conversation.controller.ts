import { Router } from 'express';
import { z } from 'zod';
import { requestGame, reply, acknowledge } from '../request-context.js';
import { AppError } from '../errors/app-error.js';
import { transcriptSchema } from '../types/conversation.types.js';

export function conversationRoutes() {
  const router = Router();

  router.post('/transcript', async (req, res) => {
    const { store } = requestGame(res);
    const message = transcriptSchema.parse(req.body);
    await store.transaction(() => store.conversations.saveMessage(message));
    acknowledge(res);
  });

  router.get('/sessions/:id/checkpoint', async (req, res) => {
    const { store } = requestGame(res);
    const id = z.string().uuid().parse(req.params.id);
    if (!(await store.sessions.get(id))) throw AppError.create('session_not_found');
    reply(res, await store.conversations.latest(id));
  });

  router.get('/sessions/:id/events', async (req, res) => {
    const { store } = requestGame(res);
    const id = z.string().uuid().parse(req.params.id);
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.query.after ?? 0);
    reply(res, await store.conversations.events(id, after));
  });
  return router;
}

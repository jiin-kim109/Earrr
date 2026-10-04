import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { settingsSchema } from '../../shared/schemas/user.js';
import { requestGame, reply } from '../request-context.js';
import { Log } from '../services/log.service.js';

export function userRoutes() {
  const router = Router();
  router.put('/settings', async (req, res) => {
    const game = requestGame(res);
    const { store } = game;
    const settings = settingsSchema.parse(req.body);
    await store.transaction(async () => {
      await store.user.saveSettings(settings);
      const session = await store.sessions.active();
      if (session) {
        await game.recordEvent({
          id: randomUUID(),
          sessionId: session.id,
          type: 'settings.changed',
          createdAt: new Date().toISOString(),
          payload: { settings },
        });
      }
    });
    Log.event('settings.changed', {
      instrument: settings.instrument,
      volume: settings.volume,
      voice: settings.voice,
    });
    reply(res, await game.snapshot());
  });
  return router;
}

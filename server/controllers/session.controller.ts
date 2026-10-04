import { Router } from 'express';
import { z } from 'zod';
import { requestGame, reply, acknowledge } from '../request-context.js';
import type { Config } from '../config/environment.js';
import { diagnosticCodes } from '../errors/app-error.js';
import { Log } from '../services/log.service.js';

const connectionSchema = z
  .object({
    sessionId: z.string().uuid(),
    sdp: z.string().min(100).max(120_000).startsWith('v=0'),
  })
  .strict();

const diagnosticSchema = z
  .object({
    kind: z.enum(['audio', 'connection']),
    code: z.enum(diagnosticCodes),
  })
  .strict();

export function sessionRoutes(config: Config, fetcher: typeof fetch) {
  const router = Router();

  router.post('/realtime/connect', async (req, res) => {
    const game = requestGame(res);
    const { sessionId, sdp } = connectionSchema.parse(req.body);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const answer = await game.sessions.connect(
      sessionId,
      config,
      await game.snapshot(),
      sdp,
      controller.signal,
      fetcher,
      req.ip ?? 'local',
    );
    Log.event('realtime.connect_completed', {}, { sessionId });
    reply(res, { answer, sessionId });
  });
  router.get('/diagnostics', async (_req, res) =>
    reply(res, { events: await requestGame(res).store.sessions.diagnostics() }),
  );
  router.post('/diagnostics', async (req, res) => {
    const game = requestGame(res);
    const event = diagnosticSchema.parse(req.body);
    await game.store.sessions.recordDiagnostic(event.kind, event.code, null, []);
    acknowledge(res);
  });
  return router;
}

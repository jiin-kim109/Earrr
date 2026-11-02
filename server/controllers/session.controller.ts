import { Router } from 'express';
import { z } from 'zod';
import { requestGame, reply, acknowledge } from '../request-context.js';
import type { Config } from '../config/environment.js';
import { diagnosticCodes } from '../errors/app-error.js';
import type { RealtimeCallService } from '../services/realtime-call.service.js';
import { realtimeClientIp } from '../middleware.js';

const connectionSchema = z
  .object({
    sessionId: z.string().uuid(),
    sdp: z.string().min(100).max(120_000).startsWith('v=0'),
  })
  .strict();

const disconnectionSchema = z
  .object({ sessionId: z.string().uuid(), connectionId: z.string().uuid() })
  .strict();

const diagnosticSchema = z
  .object({
    kind: z.enum(['audio', 'connection']),
    code: z.enum(diagnosticCodes),
  })
  .strict();

export function sessionRoutes(config: Config, fetcher: typeof fetch, calls: RealtimeCallService) {
  const router = Router();

  router.post('/realtime/connect', async (req, res) => {
    const game = requestGame(res);
    const { sessionId, sdp } = connectionSchema.parse(req.body);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const ip = realtimeClientIp(req, config);
    const connection = await calls.connect(
      ip,
      controller.signal,
      async (signal) =>
        game.sessions.connect(sessionId, config, await game.snapshot(), sdp, signal, fetcher, ip),
      sessionId,
    );
    reply(res, { ...connection, sessionId });
  });
  router.post('/realtime/disconnect', async (req, res) => {
    const { sessionId, connectionId } = disconnectionSchema.parse(req.body);
    if (await requestGame(res).store.sessions.get(sessionId))
      await calls.disconnect(sessionId, connectionId);
    res.status(204).end();
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

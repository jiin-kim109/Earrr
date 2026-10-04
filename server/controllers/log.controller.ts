import { Router } from 'express';
import { logBatchSchema } from '../../shared/schemas/logging.js';
import { Log } from '../services/log.service.js';
import { WorkspaceDirectory } from '../services/storage/workspace.js';
import type { Store } from '../db/database.js';
import { accessToken } from './workspace.controller.js';
import { AppError } from '../errors/app-error.js';

export function logRoutes(storage: Store | WorkspaceDirectory) {
  const router = Router();
  router.post('/logs', async (req, res) => {
    const { events } = logBatchSchema.parse(req.body);
    if (!events.length) {
      res.sendStatus(202);
      return;
    }
    if (!Log.enabled) {
      res.setHeader('x-earrr-telemetry', 'disabled');
      res.sendStatus(204);
      return;
    }
    let actorId: string | null = null;
    let store: Store | null = null;
    if (storage instanceof WorkspaceDirectory) {
      const authorization = req.get('authorization');
      const guest = req.get('x-earrr-guest');
      if (authorization || guest) {
        const workspace = authorization
          ? await storage.account(accessToken(authorization))
          : await storage.guest(guest!);
        actorId = `${workspace.kind}:${workspace.id}`;
        store = workspace.store;
      }
    } else store = storage;
    const sessions = [
      ...new Set(events.map((event) => event.sessionId).filter((id) => id !== null)),
    ];
    for (const id of sessions)
      if (!store || !(await store.sessions.get(id))) throw AppError.create('session_not_found');
    for (const event of events) Log.ingest(event, actorId);
    res.sendStatus(202);
  });
  return router;
}

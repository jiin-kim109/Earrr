import { AgentService } from './services/agent/agent.service.js';
import type { Config } from './config/environment.js';
import { AppError } from './errors/app-error.js';
import { conversationRoutes } from './controllers/conversation.controller.js';
import { ownOriginApiOnly, securityHeaders } from './middleware.js';
import { requestErrors } from './errors/handler.js';
import { agentRoutes } from './controllers/agent.controller.js';
import { exerciseRoutes } from './controllers/exercise.controller.js';
import { userRoutes } from './controllers/user.controller.js';
import { sessionRoutes } from './controllers/session.controller.js';
import { workspaceRoutes, accessToken } from './controllers/workspace.controller.js';
import { WorkspaceDirectory } from './services/storage/workspace.js';
import { Store } from './db/database.js';

import express from 'express';
import type { Express } from 'express';

export function createApp(
  config: Config,
  storage: WorkspaceDirectory,
  fetcher?: typeof fetch,
): Promise<{ app: Express }>;
export function createApp(
  config: Config,
  storage: Store,
  fetcher?: typeof fetch,
): Promise<{ app: Express; game: AgentService }>;
export async function createApp(
  config: Config,
  storage: Store | WorkspaceDirectory,
  fetcher: typeof fetch = fetch,
) {
  const app = express();
  const game =
    storage instanceof Store
      ? await AgentService.create(storage, config.configured, config.deployment)
      : undefined;

  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use('/api', ownOriginApiOnly(config));
  app.use('/api/workspaces', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '160kb' }));
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      configured: config.configured,
      deployment: config.deployment,
      releaseId: config.releaseId ?? null,
      commitSha: config.commitSha ?? null,
      nodeVersion: process.versions.node,
    });
  });
  if (storage instanceof Store)
    app.get('/api/config', (_req, res) =>
      res.json({
        auth: {
          enabled: false,
          url: '',
          publishableKey: '',
          googleEnabled: false,
          guestStorage: false,
        },
      }),
    );

  if (storage instanceof WorkspaceDirectory) {
    app.use('/api', workspaceRoutes(config, storage));
    app.use('/api', async (req, res, next) => {
      const workspace = req.get('authorization')
        ? await storage.account(accessToken(req.get('authorization')))
        : await storage.guest(req.get('x-earrr-guest') ?? '');
      res.locals.workspace = workspace;
      res.locals.game = workspace.game;
      next();
    });
  } else
    app.use('/api', (_req, res, next) => {
      res.locals.game = game;
      next();
    });
  app.use('/api', agentRoutes());
  app.use('/api', userRoutes());
  app.use('/api', exerciseRoutes());
  app.use('/api', conversationRoutes());
  app.use('/api', sessionRoutes(config, fetcher));
  app.use('/api', (_req, _res, next) => {
    next(AppError.create('route_not_found'));
  });
  app.use(requestErrors(config));
  return { app, game };
}

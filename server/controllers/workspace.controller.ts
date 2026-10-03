import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config/environment.js';
import { WorkspaceDirectory } from '../services/storage/workspace.js';
import { AppError } from '../errors/app-error.js';
import { reply } from '../request-context.js';
import { guestSaveSchema } from '../../shared/schemas/user.js';

export const accessToken = (header: string | undefined) => {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  if (!match) throw AppError.create('invalid_auth_session');
  return match[1]!;
};

export function workspaceRoutes(config: Config, directory: WorkspaceDirectory) {
  const router = Router();
  router.get('/config', (_req, res) =>
    res.json({
      auth: {
        enabled: Boolean(config.supabaseUrl && config.supabasePublishableKey),
        url: config.supabaseUrl ?? '',
        publishableKey: config.supabasePublishableKey ?? '',
        googleEnabled: Boolean(config.googleEnabled),
        guestStorage: true,
      },
    }),
  );
  router.post('/workspaces/guest', async (req, res) => {
    const input = z.object({ save: guestSaveSchema.optional() }).strict().parse(req.body);
    const { workspace, token } = await directory.createGuest(input.save);
    res.locals.workspace = workspace;
    return reply(res, { snapshot: await workspace.game.snapshot(), guestToken: token });
  });
  router.post('/workspaces/import', async (req, res) => {
    const token = accessToken(req.get('authorization'));
    const input = z
      .object({ guestToken: z.string().min(32).max(128), save: guestSaveSchema })
      .strict()
      .parse(req.body);
    const workspace = await directory.migrate(token, input.guestToken, input.save);
    res.locals.workspace = workspace;
    return reply(res, await workspace.game.snapshot());
  });
  return router;
}

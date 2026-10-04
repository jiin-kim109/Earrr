import { Router } from 'express';
import { ZodError } from 'zod';
import { requestGame, reply } from '../request-context.js';
import { AppError } from '../errors/app-error.js';
import { toolRequestSchema } from '../types/agent.types.js';
import type { Store } from '../db/database.js';
import { Log, logToolResult } from '../services/log.service.js';

export function agentRoutes() {
  const router = Router();
  router.get('/state', async (_req, res) => {
    const snapshot = await requestGame(res).snapshot();
    Log.context({ sessionId: snapshot.session?.id ?? null });
    reply(res, snapshot);
  });
  router.post('/tools', async (req, res) => {
    const input = toolRequestSchema.parse(req.body);
    const result = await requestGame(res).execute(input);
    logToolResult(input, result);
    reply(res, result);
  });
  router.post('/agent/tools', async (req, res, next) => {
    const game = requestGame(res);
    let action: string | null = null;
    try {
      const input = await agentRequest(req.body, game.store);
      action = input.name;
      const result = await game.execute(input, true);
      logToolResult(input, result);
      reply(res, result);
    } catch (error) {
      const details =
        error instanceof ZodError
          ? error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.code}`)
          : [error instanceof AppError ? error.message : 'Tool execution failed.'];
      await game.store.sessions.recordDiagnostic(
        'tool',
        error instanceof AppError ? error.code : 'invalid_tool_arguments',
        action,
        details,
      );
      next(error);
    }
  });
  return router;
}

export async function agentRequest(input: unknown, store: Store) {
  const request = toolRequestSchema.parse(input);
  const args = { ...request.arguments };
  const removed: string[] = [];
  // Some realtime models echo JSON-schema metadata as argument fields.
  // Only this known non-musical key is normalized; musical values stay strict.
  if (typeof args.format === 'string') {
    delete args.format;
    removed.push('arguments.format');
  }
  if (args.answer && typeof args.answer === 'object' && !Array.isArray(args.answer)) {
    const answer = { ...args.answer };
    if ('format' in answer && typeof answer.format === 'string') {
      delete answer.format;
      removed.push('arguments.answer.format');
    }
    args.answer = answer;
  }
  if (removed.length)
    await store.sessions.recordDiagnostic('tool', 'schema_metadata_removed', request.name, removed);
  return { ...request, arguments: args };
}

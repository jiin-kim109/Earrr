import type { Response } from 'express';
import type { AgentService } from './services/agent/agent.service.js';
import type { LearningWorkspace } from './services/storage/workspace.js';

export function requestGame(res: Response): AgentService {
  const game: AgentService | undefined = res.locals.game;
  if (!game) throw new Error('A learning workspace was not resolved for this request.');
  return game;
}
export function reply(res: Response, data: unknown) {
  const workspace: LearningWorkspace | undefined = res.locals.workspace;
  return res.json(
    workspace
      ? { data, guestSave: workspace.guestSave, learningStarted: workspace.learningStarted }
      : data,
  );
}
export function acknowledge(res: Response) {
  return res.locals.workspace ? reply(res, null) : res.status(204).end();
}

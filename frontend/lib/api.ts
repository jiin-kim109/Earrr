import type { Settings, Transcript } from '../../shared/types/user.js';
import type { Snapshot, ToolResult, ToolName } from '../../server/types/agent.types.js';
import { ApiError } from '../errors/api-error.js';
import { reportFailure } from '../errors/failure.js';
import { Log } from './log.js';
import type { Curriculum } from '../../shared/types/course.js';
import type { AnswerReview } from '../../server/types/grading.types.js';
import { credentials, trackRequest, unpack, journal, journalComplete } from '../storage/access.js';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const owner = credentials();
  try {
    return await trackRequest(request<T>(path, options, owner));
  } catch (error) {
    reportFailure(error);
    throw error;
  }
}
async function request<T>(
  path: string,
  options: RequestInit,
  owner: ReturnType<typeof credentials>,
): Promise<T> {
  const pending = await journal(path, options, owner.identity);
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const logPath = `/api${path.split('?')[0]}`;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-earrr-client': '1',
        ...Log.headers(requestId),
        ...owner.headers,
        ...options.headers,
      },
      signal: options.signal ?? AbortSignal.timeout(50_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    Log.event(
      'api.failed',
      {
        path: logPath,
        durationMs: Math.round(performance.now() - started),
        code: 'network_unavailable',
      },
      { level: 'error', requestId },
    );
    throw ApiError.unreachable();
  }
  Log.event(
    'api.completed',
    { path: logPath, status: response.status, durationMs: Math.round(performance.now() - started) },
    { level: response.ok ? 'info' : 'warn', requestId },
  );
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = ApiError.response(body, response.status);
    if (
      pending &&
      response.status < 500 &&
      !['guest_session_missing', 'invalid_auth_session', 'cloud_save_conflict'].includes(error.code)
    )
      await journalComplete(pending);
    throw error;
  }
  const data = await unpack<T>(body, owner.identity);
  if (pending) await journalComplete(pending);
  return data;
}

export const getState = () => api<Snapshot>('/state');
export const getCurriculum = () => api<Curriculum>('/curriculum');
export const getAnswerReview = (id: string, signal: AbortSignal) =>
  api<AnswerReview>(`/answers/${encodeURIComponent(id)}`, { signal });
export const saveSettings = (settings: Settings) =>
  api<Snapshot>('/settings', { method: 'PUT', body: JSON.stringify(settings) });
export const saveTranscript = (message: Transcript) =>
  api<void>('/transcript', { method: 'POST', body: JSON.stringify(message) });
export const callTool = (
  name: ToolName,
  args: Record<string, unknown>,
  sessionId?: string,
  callId: string = crypto.randomUUID(),
) =>
  api<ToolResult>('/tools', {
    method: 'POST',
    body: JSON.stringify({ callId, name, arguments: args, ...(sessionId ? { sessionId } : {}) }),
  });
export const callAgentTool = (
  name: ToolName,
  args: Record<string, unknown>,
  sessionId: string | undefined,
  callId: string,
) =>
  api<ToolResult>('/agent/tools', {
    method: 'POST',
    body: JSON.stringify({ callId, name, arguments: args, ...(sessionId ? { sessionId } : {}) }),
  });
export const acknowledgePlayback = (sessionId: string, exerciseId: string) =>
  api<void>('/playback', {
    method: 'POST',
    body: JSON.stringify({ id: crypto.randomUUID(), sessionId, exerciseId }),
  });
export const acknowledgeTeaching = (sessionId: string, presentationId: string) =>
  api<Snapshot>('/teaching/delivered', {
    method: 'POST',
    body: JSON.stringify({ sessionId, presentationId }),
  });

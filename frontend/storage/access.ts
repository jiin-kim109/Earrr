import type { Session } from '@supabase/supabase-js';
import type { ApiEnvelope } from '../../shared/types/user.js';
import { clearGuest, guestSave, writeGuest, pendingActions, recordPending } from './guest.js';
import type { PendingGuestAction } from './guest.js';
import type { Snapshot } from '../../server/types/agent.types.js';
import { ApiError } from '../errors/api-error.js';
import { Log } from '../lib/log.js';

type Identity = { key: string; token?: string; guestToken?: string };
let identity: Identity = { key: 'uninitialized' };
let sessionGetter: (() => Session | null) | null = null;
let saving = Promise.resolve();
let unsaved: { owner: string; checkpoint: NonNullable<ApiEnvelope<unknown>['guestSave']> } | null =
  null;
const pending = new Set<Promise<unknown>>();
export let learningStarted = false;

export function credentials() {
  const current = sessionGetter?.();
  const session = current && identity.key === `account:${current.user.id}` ? current : null;
  return {
    identity: identity.key,
    headers: {
      ...(identity.token
        ? { Authorization: `Bearer ${session?.access_token ?? identity.token}` }
        : {}),
      ...(identity.guestToken ? { 'x-earrr-guest': identity.guestToken } : {}),
    },
  };
}
export function configureSession(getter: () => Session | null) {
  sessionGetter = getter;
}
export function trackRequest<T>(operation: Promise<T>): Promise<T> {
  pending.add(operation);
  void operation.finally(() => pending.delete(operation)).catch(() => undefined);
  return operation;
}
export async function waitForSaves() {
  await Promise.allSettled([...pending]);
  try {
    await saving;
  } catch (error) {
    if (!unsaved) throw error;
    await saveCheckpoint(unsaved.owner, unsaved.checkpoint);
  }
}
function saveCheckpoint(owner: string, checkpoint: NonNullable<ApiEnvelope<unknown>['guestSave']>) {
  const write = async () => {
    if (owner !== identity.key) return;
    unsaved = { owner, checkpoint };
    await writeGuest(checkpoint);
    unsaved = null;
  };
  saving = saving.then(write, write);
  return saving;
}
export async function unpack<T>(body: unknown, owner: string): Promise<T> {
  if (!body || typeof body !== 'object' || !('data' in body) || !('learningStarted' in body))
    return body as T;
  const result = body as ApiEnvelope<T>;
  if (owner === identity.key) {
    learningStarted = result.learningStarted;
    if (result.guestSave) {
      await saveCheckpoint(owner, result.guestSave);
    }
  }
  return result.data;
}
async function workspaceRequest(path: string, body: object, headers: Record<string, string> = {}) {
  const response = await fetch(`/api/workspaces/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-earrr-client': '1',
      ...Log.headers(),
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50_000),
  });
  const result: ApiEnvelope<unknown> = await response.json();
  if (!response.ok) throw ApiError.response(result, response.status);
  return result;
}
export async function restoreGuest(fresh = false): Promise<Snapshot> {
  const restore = () => loadGuest(fresh);
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('earrr:guest-restore', restore)
    : restore();
}
async function loadGuest(fresh: boolean): Promise<Snapshot> {
  let save = await guestSave();
  if (fresh && save?.learningStarted) {
    await clearGuest();
    save = null;
  }
  const result = await workspaceRequest('guest', { ...(save ? { save } : {}) });
  const data = result.data as { snapshot: Snapshot; guestToken: string };
  identity = { key: `guest:${result.guestSave!.id}`, guestToken: data.guestToken };
  learningStarted = result.learningStarted;
  if (result.guestSave) await writeGuest(result.guestSave);
  for (const action of await pendingActions()) {
    if (`guest:${action.guestId}` !== identity.key)
      throw new Error('Pending progress belongs to a different guest. It has not been deleted.');
    const response = await fetch(`/api${action.path}`, {
      method: action.method,
      headers: {
        'Content-Type': 'application/json',
        'x-earrr-client': '1',
        ...Log.headers(),
        'x-earrr-guest': data.guestToken,
      },
      body: action.body,
      signal: AbortSignal.timeout(50_000),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status < 500) await journalComplete(action);
      throw ApiError.response(body, response.status);
    }
    await unpack(body, identity.key);
    await journalComplete(action);
  }
  const latest = await fetch('/api/state', {
    headers: { 'x-earrr-guest': data.guestToken, 'x-earrr-client': '1', ...Log.headers() },
  });
  const loaded = await latest.json();
  if (!latest.ok) throw ApiError.response(loaded, latest.status);
  return unpack<Snapshot>(loaded, identity.key);
}
export async function restoreAccount(session: Session, migrate: boolean): Promise<Snapshot> {
  await waitForSaves();
  const source = migrate ? await guestSave() : null;
  let imported: ApiEnvelope<unknown> | null = null;
  if (migrate && source) {
    await restoreGuest();
    imported = await workspaceRequest(
      'import',
      { guestToken: identity.guestToken, save: await guestSave() },
      { Authorization: `Bearer ${session.access_token}` },
    );
    await clearGuest();
  }
  identity = { key: `account:${session.user.id}`, token: session.access_token };
  if (imported) {
    learningStarted = imported.learningStarted;
    return imported.data as Snapshot;
  }
  const response = await fetch('/api/state', {
    headers: { Authorization: `Bearer ${session.access_token}`, 'x-earrr-client': '1' },
  });
  const result = await response.json();
  if (!response.ok) throw ApiError.response(result, response.status);
  return unpack<Snapshot>(result, identity.key);
}
export function scope() {
  return identity.key;
}
export async function journal(
  path: string,
  options: RequestInit,
  owner: string,
): Promise<PendingGuestAction | null> {
  if (!owner.startsWith('guest:') || typeof options.body !== 'string') return null;
  const input = JSON.parse(options.body) as { callId?: string };
  if (!input.callId || (path !== '/tools' && path !== '/agent/tools' && path !== '/solo/answer'))
    return null;
  const action: PendingGuestAction = {
    id: input.callId,
    guestId: owner.slice('guest:'.length),
    path,
    body: options.body,
    method: 'POST',
  };
  await recordPending(action);
  return action;
}
export const journalComplete = (action: PendingGuestAction) => recordPending(action, true);

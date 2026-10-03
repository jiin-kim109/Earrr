import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Session } from '@supabase/supabase-js';
import type { GuestSave } from '../shared/types/user.js';
import type { PendingGuestAction } from '../frontend/storage/guest.js';

const local = vi.hoisted(() => ({
  guestSave: vi.fn<() => Promise<GuestSave | null>>(),
  writeGuest: vi.fn<(save: GuestSave) => Promise<void>>(),
  clearGuest: vi.fn<() => Promise<void>>(),
  pendingActions: vi.fn<() => Promise<PendingGuestAction[]>>(),
  recordPending: vi.fn<(action: PendingGuestAction, remove?: boolean) => Promise<void>>(),
}));
vi.mock('../frontend/storage/guest.js', () => local);
const guestId = randomUUID();
const save = (revision = 0, learningStarted = true): GuestSave => ({
  id: guestId,
  revision,
  learningStarted,
  checkpoint: `opaque-fixture-${revision}`,
});
function session(id = randomUUID(), access_token = 'fixture-access'): Session {
  return {
    access_token,
    refresh_token: 'fixture-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id,
      email: 'player@example.com',
      email_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
    },
  };
}
const snapshot = { totalAnswers: 1 };
const envelope = (data: unknown, guestSave?: GuestSave) =>
  Response.json({ data, ...(guestSave ? { guestSave } : {}), learningStarted: true });
let access: typeof import('../frontend/storage/access.js');
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let saved: GuestSave | null;
let actions: PendingGuestAction[];
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  saved = save();
  actions = [];
  local.guestSave.mockImplementation(async () => saved);
  local.writeGuest.mockImplementation(async (value) => {
    saved = value;
  });
  local.clearGuest.mockImplementation(async () => {
    saved = null;
    actions = [];
  });
  local.pendingActions.mockImplementation(async () => actions);
  local.recordPending.mockImplementation(async (action, remove) => {
    actions = actions.filter((current) => current.id !== action.id);
    if (!remove) actions.push(action);
  });
  fetcher = vi.fn<typeof fetch>(async (url) => {
    if (url === '/api/workspaces/guest')
      return envelope(
        { snapshot, guestToken: 'guest-fixture-capability' },
        saved ?? save(0, false),
      );
    if (url === '/api/workspaces/import') return envelope(snapshot);
    return envelope(snapshot);
  });
  vi.stubGlobal('fetch', fetcher);
  access = await import('../frontend/storage/access.js');
});
afterEach(() => vi.unstubAllGlobals());

describe('browser progress and workspace ownership', () => {
  it('recovers a failed IndexedDB checkpoint without poisoning later saves', async () => {
    await access.restoreGuest();
    local.writeGuest.mockRejectedValueOnce(new Error('Storage was temporarily unavailable.'));
    await expect(
      access.unpack({ data: snapshot, guestSave: save(1), learningStarted: true }, access.scope()),
    ).rejects.toThrow('temporarily unavailable');
    await access.unpack(
      { data: snapshot, guestSave: save(2), learningStarted: true },
      access.scope(),
    );
    await access.waitForSaves();
    expect(saved?.revision).toBe(2);
  });

  it('retries the last failed checkpoint before allowing an identity change', async () => {
    await access.restoreGuest();
    local.writeGuest.mockRejectedValueOnce(new Error('Storage failed.'));
    await expect(
      access.unpack({ data: snapshot, guestSave: save(1), learningStarted: true }, access.scope()),
    ).rejects.toThrow('Storage failed');
    await access.waitForSaves();
    expect(saved?.revision).toBe(1);
  });

  it('keeps an unacknowledged answer and replays its original call ID before migrating', async () => {
    await access.restoreGuest();
    const { api } = await import('../frontend/lib/api.js');
    const body = JSON.stringify({ callId: 'call_provider_fixture', name: 'submit_answer' });
    fetcher.mockRejectedValueOnce(new TypeError('Network disappeared.'));
    await expect(api('/tools', { method: 'POST', body })).rejects.toThrow();
    expect(actions).toHaveLength(1);
    fetcher.mockImplementation(async (url) => {
      if (url === '/api/workspaces/guest')
        return envelope({ snapshot, guestToken: 'restored-capability' }, save());
      if (url === '/api/tools') return envelope(snapshot, save(1));
      return envelope(snapshot);
    });
    await access.restoreAccount(session(), true);
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/tools')).toHaveLength(2);
    const replayed = fetcher.mock.calls.filter(([url]) => url === '/api/tools')[1]!;
    expect(replayed[1]?.body).toBe(body);
    expect(replayed[1]?.headers).toMatchObject({ 'x-earrr-guest': 'restored-capability' });
    expect(actions).toEqual([]);
    expect(local.clearGuest).toHaveBeenCalledOnce();
  });

  it('retains the journal on an uncertain server failure instead of claiming the action was undone', async () => {
    await access.restoreGuest();
    const { api } = await import('../frontend/lib/api.js');
    fetcher.mockResolvedValueOnce(
      Response.json({ error: 'Could not confirm progress.' }, { status: 503 }),
    );
    await expect(
      api('/tools', {
        method: 'POST',
        body: JSON.stringify({ callId: 'call_pending_fixture', name: 'submit_answer' }),
      }),
    ).rejects.toThrow();
    expect(actions).toHaveLength(1);
  });

  it('removes a definitively rejected action from the journal and reports the error', async () => {
    await access.restoreGuest();
    const { api } = await import('../frontend/lib/api.js');
    fetcher.mockResolvedValueOnce(Response.json({ error: 'Invalid answer.' }, { status: 422 }));
    await expect(
      api('/tools', {
        method: 'POST',
        body: JSON.stringify({ callId: 'call_rejected_fixture', name: 'submit_answer' }),
      }),
    ).rejects.toThrow();
    expect(actions).toEqual([]);
  });

  it('transparently restores expired guest capabilities and retries the same mutation once', async () => {
    await access.restoreGuest();
    const { api } = await import('../frontend/lib/api.js');
    fetcher.mockResolvedValueOnce(
      Response.json(
        { error: { code: 'guest_session_missing', message: 'Guest session expired.' } },
        { status: 401 },
      ),
    );
    const body = JSON.stringify({ callId: 'call_recovery_fixture', name: 'play_exercise' });
    await expect(api('/tools', { method: 'POST', body })).resolves.toEqual(snapshot);
    expect(actions).toEqual([]);
    const retries = fetcher.mock.calls.filter(([url]) => url === '/api/tools');
    expect(retries).toHaveLength(3);
    expect(retries.map(([, options]) => options?.body)).toEqual([body, body, body]);
  });

  it('preserves guest progress until the verified cloud import succeeds', async () => {
    await access.restoreGuest();
    fetcher.mockImplementation(async (url) =>
      url === '/api/workspaces/import'
        ? Response.json({ error: 'Cloud unavailable.' }, { status: 503 })
        : url === '/api/workspaces/guest'
          ? envelope({ snapshot, guestToken: 'guest-fixture-capability' }, save())
          : envelope(snapshot),
    );
    await expect(access.restoreAccount(session(), true)).rejects.toThrow();
    expect(local.clearGuest).not.toHaveBeenCalled();
    expect(saved?.id).toBe(guestId);
    expect(access.scope()).toBe(`guest:${guestId}`);
  });

  it('can retry cleanup after an already-committed import', async () => {
    await access.restoreGuest();
    const verified = session();
    local.clearGuest.mockRejectedValueOnce(new Error('Local cleanup failed.'));
    await expect(access.restoreAccount(verified, true)).rejects.toThrow('Local cleanup failed');
    expect(saved).not.toBeNull();
    await access.restoreAccount(verified, true);
    expect(saved).toBeNull();
    expect(access.scope()).toBe(`account:${verified.user.id}`);
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/workspaces/import')).toHaveLength(2);
  });

  it('does not require guest IndexedDB access to load a normal cloud login', async () => {
    local.guestSave.mockRejectedValue(new Error('Browser storage is disabled.'));
    const current = session();
    await expect(access.restoreAccount(current, false)).resolves.toEqual(snapshot);
    expect(local.guestSave).not.toHaveBeenCalled();
    expect(local.clearGuest).not.toHaveBeenCalled();
  });

  it('uses refreshed credentials only for the same account, never a different owner', async () => {
    const current = session();
    await access.restoreAccount(current, false);
    access.configureSession(() => ({ ...current, access_token: 'refreshed-fixture' }));
    expect(access.credentials().headers.Authorization).toBe('Bearer refreshed-fixture');
    access.configureSession(() => session(randomUUID(), 'different-owner-fixture'));
    expect(access.credentials().headers.Authorization).toBe('Bearer fixture-access');
  });

  it('does not recreate a cleared guest save when an old response arrives after account login', async () => {
    await access.restoreGuest();
    const previousOwner = access.scope();
    await access.restoreAccount(session(), true);
    const writes = local.writeGuest.mock.calls.length;
    await access.unpack(
      { data: snapshot, guestSave: save(9), learningStarted: true },
      previousOwner,
    );
    expect(local.writeGuest).toHaveBeenCalledTimes(writes);
    expect(saved).toBeNull();
  });

  it('resets learned guest data on logout but reuses a fresh guest created by another tab', async () => {
    await access.restoreGuest(true);
    expect(local.clearGuest).toHaveBeenCalledOnce();
    local.clearGuest.mockClear();
    saved = save(0, false);
    await access.restoreGuest(true);
    expect(local.clearGuest).not.toHaveBeenCalled();
    expect(saved.learningStarted).toBe(false);
  });
});

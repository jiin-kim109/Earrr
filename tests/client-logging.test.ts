import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LogEvent } from '../shared/types/logging.js';

let Log: (typeof import('../frontend/lib/log.js'))['Log'];
let local: Map<string, string>;
let calls: Array<{ events: LogEvent[]; headers: Headers; keepalive?: boolean }>;
beforeEach(async () => {
  vi.resetModules();
  local = new Map();
  calls = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('location', { pathname: '/' });
  vi.stubGlobal('navigator', { language: 'en-CA' });
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, options) => {
      calls.push({
        ...JSON.parse(String(options?.body)),
        headers: new Headers(options?.headers),
        keepalive: options?.keepalive,
      });
      return new Response(null, { status: 202 });
    }),
  );
  ({ Log } = await import('../frontend/lib/log.js'));
});
afterEach(async () => {
  await Log.flush();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('contextual browser events', () => {
  it('clears retired visitor tracking without logging anonymous startup or visibility traces', async () => {
    local.set('earrr:visitor', '------------------------------------');
    Log.initialize();
    Log.initialize();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    await Log.flush();
    expect(calls).toEqual([]);
    expect([...local.keys()]).toEqual([]);
    expect(Object.keys(Log.headers())).toEqual(['x-earrr-request-id']);
  });

  it('batches small keepalive requests with automatic session context and sanitized JSON', async () => {
    const sessionId = randomUUID();
    Log.initialize({
      session: () => sessionId,
      access: () => ({ identity: 'guest:fixture', headers: { 'x-earrr-guest': 'fixture' } }),
    });
    for (let index = 0; index < 11; index++)
      Log.event('user_submit_exercise_answer', {
        index,
        password: 'private',
        dimensions: { lesson: 'triads' },
      });
    await Log.flush();
    expect(calls.flatMap((call) => call.events)).toHaveLength(11);
    expect(calls.every((call) => call.events.length <= 5 && call.keepalive)).toBe(true);
    expect(
      calls.flatMap((call) => call.events).every((event) => event.sessionId === sessionId),
    ).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('private');
    expect(calls[0]!.headers.get('x-earrr-client')).toBe('1');
    expect(
      calls
        .flatMap((call) => call.events)
        .every(
          (event) =>
            !('visitId' in event) &&
            !('visitorId' in event) &&
            !('source' in event) &&
            !('releaseId' in event),
        ),
    ).toBe(true);
  });

  it('never sends queued events under a different identity after login or logout', async () => {
    let owner = 'guest:first';
    Log.initialize({
      session: () => null,
      access: () => ({ identity: owner, headers: { 'x-earrr-guest': owner } }),
    });
    Log.event('user_open_app', { count: 1 });
    owner = 'guest:second';
    Log.event('user_start_training', { count: 2 });
    await Log.flush();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get('x-earrr-guest')).toBe('guest:first');
    expect(calls[1]!.headers.get('x-earrr-guest')).toBe('guest:second');
    expect(calls[1]!.events.map((event) => event.event)).toEqual(['user_start_training']);
  });

  it('makes log delivery failures explicit without rejecting application work or retrying indefinitely', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValue(new TypeError('Network unavailable.'));
    Log.initialize();
    Log.event('user_open_app');
    await expect(Log.flush()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Could not send'));
    await Log.flush();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

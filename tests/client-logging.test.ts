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
  it('records one app visit and persists only an anonymous visitor id, not a log cache', async () => {
    local.set('earrr:visitor', '------------------------------------');
    Log.initialize();
    Log.initialize();
    await Log.flush();
    expect(calls.flatMap((call) => call.events)).toHaveLength(1);
    expect(calls[0]!.events[0]!.event).toBe('app.opened');
    expect(calls[0]!.events[0]!.visitorId).toBe(local.get('earrr:visitor'));
    expect(local.get('earrr:visitor')).not.toBe('------------------------------------');
    expect([...local.keys()]).toEqual(['earrr:visitor']);
  });

  it('batches small keepalive requests with automatic session context and sanitized JSON', async () => {
    const sessionId = randomUUID();
    Log.initialize({
      session: () => sessionId,
      access: () => ({ identity: 'guest:fixture', headers: { 'x-earrr-guest': 'fixture' } }),
    });
    for (let index = 0; index < 11; index++)
      Log.event('training.action', {
        index,
        password: 'private',
        dimensions: { lesson: 'triads' },
      });
    await Log.flush();
    expect(calls.flatMap((call) => call.events)).toHaveLength(12);
    expect(calls.every((call) => call.events.length <= 5 && call.keepalive)).toBe(true);
    expect(
      calls.flatMap((call) => call.events).every((event) => event.sessionId === sessionId),
    ).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('private');
    expect(calls[0]!.headers.get('x-earrr-client')).toBe('1');
  });

  it('never sends queued events under a different identity after login or logout', async () => {
    let owner = 'guest:first';
    Log.initialize({
      session: () => null,
      access: () => ({ identity: owner, headers: { 'x-earrr-guest': owner } }),
    });
    Log.event('guest.action', { count: 1 });
    owner = 'guest:second';
    Log.event('second.action', { count: 2 });
    await Log.flush();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get('x-earrr-guest')).toBe('guest:first');
    expect(calls[1]!.headers.get('x-earrr-guest')).toBe('guest:second');
    expect(calls[1]!.events.map((event) => event.event)).toEqual(['second.action']);
  });

  it('makes log delivery failures explicit without rejecting application work or retrying indefinitely', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValue(new TypeError('Network unavailable.'));
    Log.initialize();
    await expect(Log.flush()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Could not send'));
    await Log.flush();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

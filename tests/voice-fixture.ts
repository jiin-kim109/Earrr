import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { expect } from 'vitest';
import type { Config } from '../server/config/environment.js';
import type { Store } from '../server/db/database.js';
import { VoiceLimitRepository } from '../server/repositories/voice-limit.repository.js';
import { RealtimeCallService } from '../server/services/realtime-call.service.js';

export async function createVoiceFixture(
  config: Config,
  store: Store,
  now: () => number = Date.now,
) {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(provider, 'listening');
  const address = provider.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture WebSocket address is invalid.');
  const sockets = new Map<string, WebSocket>();
  const observers = new Map<string, WebSocket>();
  const hangups: string[] = [];
  const limits = new VoiceLimitRepository(store.db);
  const calls = new RealtimeCallService(
    config,
    limits,
    async (url, options) => {
      expect(options?.method).toBe('POST');
      expect(new Headers(options?.headers).get('api-key')).toBe(config.apiKey);
      const id = /\/calls\/(rtc_[a-zA-Z0-9_-]+)\/hangup$/.exec(String(url))?.[1];
      if (!id) throw new Error('Only server hangup requests belong to the fixture.');
      hangups.push(id);
      sockets.get(id)?.close(1000);
      return new Response(null, { status: 200 });
    },
    {
      now,
      socket: (url, options) => {
        const id = new URL(url).searchParams.get('call_id')!;
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?call_id=${id}`, options);
        observers.set(id, socket);
        return socket;
      },
    },
  );
  provider.on('connection', (socket, req) => {
    const id = new URL(req.url!, 'http://localhost').searchParams.get('call_id')!;
    sockets.set(id, socket);
    socket.on('close', () => sockets.delete(id));
  });
  return {
    calls,
    limits,
    sockets,
    observers,
    hangups,
    async disconnected() {
      for (const socket of sockets.values()) socket.close(1000);
      await expect
        .poll(async () => {
          const rows = await store.db.prepare('SELECT data FROM earrr_voice_limits').all();
          return rows.every((row) => JSON.parse(String(row.data)).lease === null);
        })
        .toBe(true);
    },
    async close() {
      try {
        await calls.close();
      } finally {
        for (const socket of provider.clients) socket.terminate();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
      }
    },
  };
}

import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/db/database.js';
import { realtimeClientIp } from '../server/middleware.js';
import { requestErrors } from '../server/errors/handler.js';
import { VoiceLimitRepository } from '../server/repositories/voice-limit.repository.js';
import { createVoiceFixture } from './voice-fixture.js';

const config = {
  port: 3000,
  databasePath: ':memory:',
  azureEndpoint: 'https://example.openai.azure.com',
  apiKey: 'fixture-api-key',
  deployment: 'fixture',
  transcriptionDeployment: '',
  configured: true,
};
let store: Store;
let voice: Awaited<ReturnType<typeof createVoiceFixture>>;
let now: number;

beforeEach(async () => {
  now = 1_800_000_000_000;
  store = await Store.open(':memory:');
  voice = await createVoiceFixture(config, store, () => now);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await voice.close();
  await store.close();
});

async function connect(ip = '192.0.2.1', signal = new AbortController().signal) {
  const callId = `rtc_${randomUUID().replaceAll('-', '')}`;
  await voice.calls.connect(ip, signal, async () => ({ answer: 'v=0\r\n', callId }));
  return callId;
}
async function state() {
  const row = await store.db.prepare('SELECT data FROM earrr_voice_limits ORDER BY ip_key').get();
  return JSON.parse(String(row!.data)) as {
    lease: { id: string; callId: string; until: number } | null;
    usage: Array<{ id: string; at: number; tokens: number }>;
    blockedUntil: number;
  };
}
function usage(callId: string, id: string, tokens: number) {
  voice.sockets.get(callId)!.send(
    JSON.stringify({
      type: 'response.done',
      response: { id, status: 'completed', usage: { total_tokens: tokens } },
    }),
  );
}

describe('IP-only voice protection', () => {
  it('claims one connection atomically, rejects the second before negotiation and leaves the first alive', async () => {
    let negotiations = 0;
    const negotiate = async () => {
      negotiations++;
      return { answer: 'v=0\r\n', callId: `rtc_${randomUUID().replaceAll('-', '')}` };
    };
    const results = await Promise.allSettled([
      voice.calls.connect('192.0.2.1', new AbortController().signal, negotiate),
      voice.calls.connect('192.0.2.1', new AbortController().signal, negotiate),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('voice_connection_in_use');
    expect(negotiations).toBe(1);
    expect(voice.sockets.size).toBe(1);
    expect(voice.hangups).toEqual([]);
    await connect('192.0.2.2');
    expect(voice.sockets.size).toBe(2);
  });

  it('counts provider tokens once, allows exactly 1.3M, terminates above it and preserves the exact five-minute cooldown', async () => {
    const id = await connect();
    usage(id, 'response-1', 800_000);
    usage(id, 'response-1', 800_000);
    await expect.poll(async () => (await state()).usage.length).toBe(1);
    now += 30_000;
    voice.sockets.get(id)!.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'transcription-1',
        usage: { type: 'tokens', total_tokens: 500_000 },
      }),
    );
    await expect.poll(async () => (await state()).usage.length).toBe(2);
    expect(voice.hangups).toEqual([]);
    usage(id, 'response-2', 1);
    const blockedUntil = now + 300_000;
    await expect.poll(async () => (await state()).blockedUntil).toBe(blockedUntil);
    await expect.poll(async () => (await state()).lease).toBeNull();
    expect(voice.hangups).toEqual([id]);
    await expect(connect()).rejects.toMatchObject({ code: 'voice_usage_limited', status: 429 });
    now = blockedUntil - 1;
    await expect(connect()).rejects.toMatchObject({ code: 'voice_usage_limited' });
    expect((await state()).blockedUntil).toBe(blockedUntil);
    now = blockedUntil;
    await connect();
    expect((await state()).usage).toEqual([]);
  });

  it('uses a rolling minute, not a minute-boundary reset or a fresh budget on reconnection', async () => {
    const first = await connect();
    usage(first, 'old', 1_200_000);
    await expect.poll(async () => (await state()).usage.length).toBe(1);
    now += 60_000;
    usage(first, 'new', 500_000);
    await expect.poll(async () => (await state()).usage[0]?.tokens).toBe(500_000);
    await voice.disconnected();
    const second = await connect();
    usage(second, 'new', 800_001);
    await expect.poll(async () => (await state()).lease).toBeNull();
    expect((await state()).blockedUntil).toBe(now + 300_000);
    expect(voice.hangups).toEqual([first, second]);
  });

  it('batches a burst behind a slow storage write and starts the cooldown when usage arrived, not when storage caught up', async () => {
    const id = await connect();
    const receivedAt = now;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const change = voice.limits.change.bind(voice.limits);
    const save = vi.spyOn(voice.limits, 'change').mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return change(...args);
    });
    usage(id, 'first', 100_000);
    await waiting;
    const delivered = new Promise<void>((resolve) => {
      voice.observers.get(id)!.on('message', (data) => {
        if (JSON.parse(data.toString()).response?.id === 'last') resolve();
      });
    });
    for (let index = 0; index < 12; index++) usage(id, `burst-${index}`, 100_000);
    usage(id, 'last', 1);
    await delivered;
    now += 10_000;
    release();
    await expect.poll(async () => (await state()).lease).toBeNull();
    expect((await state()).blockedUntil).toBe(receivedAt + 300_000);
    expect(save).toHaveBeenCalledTimes(3);
    expect(voice.hangups).toEqual([id]);
  });

  it('hangs up an expired persisted lease before replacing it and old cleanup cannot clear the new call', async () => {
    const old = await connect();
    now += 45_001;
    const current = await connect();
    expect(voice.hangups).toEqual([old]);
    await expect.poll(async () => (await state()).lease?.callId).toBe(current);
    usage(current, 'current', 100);
    await expect.poll(async () => (await state()).usage[0]?.tokens).toBe(100);
    expect((await state()).lease?.callId).toBe(current);
  });

  it('releases rejected negotiation without retrying and aborts without opening a provider observer', async () => {
    const rejected = vi.fn(async () => {
      throw new Error('Azure rejected the negotiation.');
    });
    await expect(
      voice.calls.connect('192.0.2.1', new AbortController().signal, rejected),
    ).rejects.toThrow('Azure rejected');
    expect(rejected).toHaveBeenCalledTimes(1);
    expect((await state()).lease).toBeNull();
    const controller = new AbortController();
    const rejectedAbort = vi.fn(async (signal: AbortSignal) => {
      controller.abort();
      signal.throwIfAborted();
      return { answer: 'v=0\r\n', callId: 'rtc_never' };
    });
    await expect(
      voice.calls.connect('192.0.2.1', controller.signal, rejectedAbort),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await state()).lease).toBeNull();
    expect(voice.sockets.size).toBe(0);
  });

  it('fails closed and really terminates when authoritative usage cannot be saved', async () => {
    const id = await connect();
    vi.spyOn(voice.limits, 'change').mockRejectedValueOnce(new Error('Usage storage unavailable.'));
    usage(id, 'response-1', 10);
    await expect.poll(async () => (await state()).lease).toBeNull();
    expect(voice.hangups).toEqual([id]);
    expect(voice.sockets.size).toBe(0);
  });

  it('does not accept a replacement when claim storage is unavailable', async () => {
    vi.spyOn(voice.limits, 'change').mockRejectedValueOnce(new Error('Claim storage unavailable.'));
    const negotiate = vi.fn();
    await expect(
      voice.calls.connect('192.0.2.1', new AbortController().signal, negotiate),
    ).rejects.toThrow('Claim storage unavailable.');
    expect(negotiate).not.toHaveBeenCalled();
  });

  it('keeps the five-minute block after the server and local database reopen', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'voice-limit-persistence-'));
    const path = join(directory, 'limits.sqlite');
    let durable = await Store.open(path);
    let fixture = await createVoiceFixture(config, durable, () => now);
    try {
      const callId = 'rtc_persistence';
      const open = () =>
        fixture.calls.connect('192.0.2.1', new AbortController().signal, async () => ({
          answer: 'v=0\r\n',
          callId,
        }));
      await open();
      fixture.sockets.get(callId)!.send(
        JSON.stringify({
          type: 'response.done',
          response: { id: 'over-budget', usage: { total_tokens: 1_300_001 } },
        }),
      );
      await expect
        .poll(async () => {
          const row = await durable.db.prepare('SELECT data FROM earrr_voice_limits').get();
          return JSON.parse(String(row!.data)).lease;
        })
        .toBeNull();
      await fixture.close();
      await durable.close();
      durable = await Store.open(path);
      fixture = await createVoiceFixture(config, durable, () => now);
      await expect(open()).rejects.toMatchObject({ code: 'voice_usage_limited' });
      now += 300_000;
      await open();
    } finally {
      await fixture.close();
      await durable.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps quota enforcement separate from guest learning archives', async () => {
    const id = await connect();
    usage(id, 'response-1', 100);
    await expect.poll(async () => (await state()).usage.length).toBe(1);
    const { exportLearning, importLearning } = await import(
      '../server/services/storage/archive.js'
    );
    const archive = await exportLearning(store);
    expect(archive.tables).not.toHaveProperty('earrr_voice_limits');
    await importLearning(store, archive);
    expect((await state()).usage[0]?.tokens).toBe(100);
  });
});

it('uses only the Azure-overwritten IP in App Service, normalizes IPv6 and ignores spoofable forwarding headers locally', async () => {
  const app = express();
  app.get('/azure', (req, res) =>
    res.json({ ip: realtimeClientIp(req, { azureAppService: true }) }),
  );
  app.get('/local', (req, res) => res.json({ ip: realtimeClientIp(req, {}) }));
  app.use(requestErrors(config));
  for (const value of [
    '192.0.2.1:50000',
    '192.0.2.1:50001',
    '::FFFF:192.0.2.1',
    '[::ffff:c000:201]:443',
  ])
    expect((await request(app).get('/azure').set('client-ip', value)).body.ip).toBe('192.0.2.1');
  expect(
    (await request(app).get('/azure').set('client-ip', '[2001:0DB8:0:0::1]:443')).body.ip,
  ).toBe('2001:db8::1');
  expect((await request(app).get('/azure').set('client-ip', '2001:db8::1:54321')).body.ip).toBe(
    '2001:db8::1',
  );
  const trusted = await request(app)
    .get('/azure')
    .set('client-ip', '203.0.113.1:50000')
    .set('x-client-ip', '192.0.2.1')
    .set('x-forwarded-for', '192.0.2.2');
  expect(trusted.body.ip).toBe('203.0.113.1');
  await request(app).get('/azure').set('x-forwarded-for', '192.0.2.1').expect(503);
  await request(app).get('/azure').set('client-ip', 'invalid').expect(503);
  await request(app).get('/azure').set('client-ip', '192.0.2.1:65536').expect(503);
  const local = await request(app)
    .get('/local')
    .set('client-ip', '192.0.2.3:443')
    .set('x-client-ip', '192.0.2.1')
    .set('x-forwarded-for', '192.0.2.2');
  expect(local.body.ip).toBe('127.0.0.1');
});

it('retries only a lost compare-and-swap and never overwrites another worker lease', async () => {
  const current = {
    usage: [],
    blockedUntil: 0,
    lease: { id: randomUUID(), callId: 'rtc_other', until: now + 45_000 },
  };
  let reads = 0;
  let writes = 0;
  const client = createClient('https://example.supabase.co', 'fixture-service-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (url, options) => {
        if (String(url).includes('/rpc/')) {
          writes++;
          expect(JSON.parse(String(options?.body)).expected_revision).toBe(0);
          return Response.json(false);
        }
        reads++;
        return Response.json(reads === 1 ? null : { revision: 1, data: current });
      },
    },
  });
  await expect(
    new VoiceLimitRepository(client).change('a'.repeat(64), (state) => {
      if (state.lease) throw new Error('A different worker owns the call.');
      state.lease = { id: randomUUID(), callId: null, until: now + 45_000 };
    }),
  ).rejects.toThrow('A different worker owns the call.');
  expect(writes).toBe(1);
});

it.skipIf(!process.env.EARRR_TEST_POSTGRES_URL)(
  'enforces compare-and-swap and service-only access in isolated PostgreSQL',
  async () => {
    const url = new URL(process.env.EARRR_TEST_POSTGRES_URL!);
    if (url.hostname !== '127.0.0.1' || process.env.EARRR_TEST_POSTGRES_ISOLATED !== '1')
      throw new Error('Voice limit SQL requires isolated local PostgreSQL.');
    const pool = new Pool({ connectionString: url.href });
    const key = 'a'.repeat(64);
    try {
      for (const role of ['anon', 'authenticated', 'service_role'])
        await pool.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role}; END IF; END $$`,
        );
      await pool.query(
        readFileSync(
          new URL('../supabase/migrations/20261011190000_earrr_voice_limits.sql', import.meta.url),
          'utf8',
        ),
      );
      const values = [key, 0, JSON.stringify({ usage: [], blockedUntil: 0, lease: null })];
      const results = await Promise.all([
        pool.query('SELECT public.earrr_write_voice_limit($1,$2,$3) AS saved', values),
        pool.query('SELECT public.earrr_write_voice_limit($1,$2,$3) AS saved', values),
      ]);
      expect(results.map((result) => result.rows[0].saved).sort()).toEqual([false, true]);
      expect(
        (await pool.query('SELECT revision FROM public.earrr_voice_limits WHERE ip_key=$1', [key]))
          .rows[0].revision,
      ).toBe('1');
      for (const role of ['anon', 'authenticated']) {
        const client = await pool.connect();
        try {
          await client.query(`SET ROLE ${role}`);
          await expect(client.query('SELECT * FROM public.earrr_voice_limits')).rejects.toThrow(
            'permission denied',
          );
          await expect(
            client.query('SELECT public.earrr_write_voice_limit($1,$2,$3)', values),
          ).rejects.toThrow('permission denied');
        } finally {
          await client.query('RESET ROLE');
          client.release();
        }
      }
    } finally {
      await pool.query('DROP FUNCTION IF EXISTS public.earrr_write_voice_limit(text,bigint,jsonb)');
      await pool.query('DROP TABLE IF EXISTS public.earrr_voice_limits');
      await pool.end();
    }
  },
);

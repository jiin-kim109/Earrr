import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import { Log } from '../server/services/log.service.js';
import { LogRepository } from '../server/repositories/log.repository.js';
import { logBatchSchema, logEventSchema, sanitizeLogMessage } from '../shared/schemas/logging.js';
import type { LogRow } from '../server/types/logging.types.js';
import { Store } from '../server/db/database.js';
import { createApp } from '../server/app.js';
import { WorkspaceDirectory } from '../server/services/storage/workspace.js';
import { CloudRepository } from '../server/repositories/cloud.repository.js';

const migration = readFileSync(
  new URL('../supabase/migrations/20261004001000_earrr_raw_events.sql', import.meta.url),
  'utf8',
);
const compatibilityMigration = readFileSync(
  new URL('../supabase/migrations/20261004171000_earrr_lean_events_compat.sql', import.meta.url),
  'utf8',
);
const leanMigration = readFileSync(
  new URL('../supabase/migrations/20261004171100_earrr_lean_events.sql', import.meta.url),
  'utf8',
);
const config = {
  port: 3101,
  databasePath: ':memory:',
  apiKey: '',
  azureEndpoint: '',
  configured: false,
  deployment: 'test',
  transcriptionDeployment: '',
};
let rows: LogRow[];
const event = (overrides = {}) => ({
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  event: 'user_open_app',
  level: 'info' as const,
  sessionId: null,
  requestId: null,
  message: { screen: 'training', lessonId: 'triads' },
  ...overrides,
});
beforeEach(() => {
  rows = [];
  Log.configure({
    write: async (batch) => {
      rows.push(...batch);
    },
    environment: 'test',
    secrets: ['fixture-private-key'],
  });
});
afterEach(async () => {
  await Log.flush();
  Log.configure({ write: null });
  vi.restoreAllMocks();
});

describe('small raw telemetry contract', () => {
  it('retains structured dimensions while redacting credentials, content and identifying strings', () => {
    const value = sanitizeLogMessage(
      {
        lessonId: 'triads',
        dimensions: { score: 0.8, choices: [1, 3, 5] },
        authorization: 'Bearer credential',
        password: 'private',
        refreshToken: 'private',
        api_key: 'private',
        userText: 'private answer',
        transcript: 'private speech',
        audio: [1, 2],
        error: 'reader@example.com fixture-private-key https://earrr.app/path?token=private#secret',
        stack: 'C:\\Users\\Example\\project\\server.ts:12',
      },
      ['fixture-private-key'],
    );
    expect(value.dimensions).toEqual({ score: 0.8, choices: [1, 3, 5] });
    expect(JSON.stringify(value)).not.toMatch(
      /reader@example|fixture-private-key|token=private|private answer|private speech|Users\\\\Example/,
    );
    for (const name of [
      'authorization',
      'password',
      'refreshToken',
      'api_key',
      'userText',
      'transcript',
      'audio',
    ])
      expect(value[name]).toBe('[redacted]');
    expect(
      logBatchSchema.safeParse({ events: Array.from({ length: 6 }, () => event()) }).success,
    ).toBe(false);
    expect(logEventSchema.safeParse(event({ message: { data: 'x'.repeat(9000) } })).success).toBe(
      false,
    );
    expect(logEventSchema.safeParse(event({ actorId: 'spoofed' })).success).toBe(false);
    expect(logEventSchema.safeParse(event({ source: 'server' })).success).toBe(false);
    expect(logEventSchema.safeParse(event({ visitId: randomUUID() })).success).toBe(false);
    expect(logEventSchema.safeParse(event({ visitorId: randomUUID() })).success).toBe(false);
    expect(logEventSchema.safeParse(event({ releaseId: 'fixture' })).success).toBe(false);
    expect(logEventSchema.safeParse(event({ event: 'user.opened' })).success).toBe(false);
    expect(
      logEventSchema.safeParse(event({ event: `user_${'training_'.repeat(11)}completed` })).success,
    ).toBe(true);
    expect(logEventSchema.safeParse(event({ event: 'user_' + 'x'.repeat(124) })).success).toBe(
      false,
    );
  });

  it('keeps only essential events from old tabs and discards removed wire metadata', () => {
    const essential = event({
      event: 'app.opened',
      visitId: randomUUID(),
      visitorId: randomUUID(),
    });
    const batch = logBatchSchema.parse({
      events: [essential, event({ event: 'api.completed' }), event({ event: 'audio.started' })],
    });
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ id: essential.id, event: 'user_open_app' });
    expect(batch.events[0]).not.toHaveProperty('visitId');
    expect(batch.events[0]).not.toHaveProperty('visitorId');
    expect(
      logBatchSchema.parse({
        events: [event({ event: 'constructor', visitId: randomUUID() })],
      }).events[0]!.event,
    ).toBe('constructor');
  });

  it('keeps async actor/session/request context isolated across concurrent users', async () => {
    const sessionA = randomUUID(),
      sessionB = randomUUID();
    const requestA = randomUUID(),
      requestB = randomUUID();
    await Promise.all([
      Log.scope({ actorId: 'account:A', sessionId: sessionA, requestId: requestA }, async () => {
        await new Promise((done) => setTimeout(done, 5));
        Log.event('user_start_training', { lessonId: 'triads' });
      }),
      Log.scope({ actorId: 'account:B', sessionId: sessionB, requestId: requestB }, async () => {
        await Promise.resolve();
        Log.event('user_submit_exercise_answer', { score: 1 });
      }),
    ]);
    await Log.flush();
    expect(rows.find((row) => row.event_name === 'user_start_training')).toMatchObject({
      actor_id: 'account:A',
      session_id: sessionA,
      request_id: requestA,
      environment: 'test',
    });
    expect(rows.find((row) => row.event_name === 'user_submit_exercise_answer')).toMatchObject({
      actor_id: 'account:B',
      session_id: sessionB,
      request_id: requestB,
    });
  });

  it('does not poison subsequent writes when the log sink fails and never throws into business code', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const write = vi.fn(async (batch: LogRow[]) => {
      rows.push(...batch);
    });
    write.mockRejectedValueOnce(new Error('temporary fixture storage failure'));
    Log.configure({ write, environment: 'test' });
    Log.event('first_event', { ok: true });
    await expect(Log.flush()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalled();
    Log.event('second_event', { ok: true });
    await Log.flush();
    expect(rows.map((row) => row.event_name)).toEqual(['second_event']);
  });

  it('uses Supabase ignore-duplicate inserts rather than allowing log record replacement', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 201 }));
    const client = createClient('https://example.supabase.co', 'fixture-service-key', {
      global: { fetch: fetcher },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    Log.event('repository_event', { lessonId: 'triads' });
    await Log.flush();
    await new LogRepository(client).write(rows);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('/rest/v1/earrr_events');
    expect(new Headers(options?.headers).get('prefer')).toContain('resolution=ignore-duplicates');
    expect(options?.body).toBe(JSON.stringify(rows));
  });

  it('accepts anonymous visits but rejects forged session ownership and reserved metadata', async () => {
    const directory = new WorkspaceDirectory({
      ...config,
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'fixture-public',
      supabaseServiceKey: 'fixture-service',
      learningSaveKey: Buffer.alloc(32, 9).toString('base64'),
    });
    try {
      const guest = await directory.createGuest();
      const other = await directory.createGuest();
      const started = await other.workspace.game.execute({
        callId: randomUUID(),
        name: 'start_session',
        arguments: { mode: 'solo' },
      });
      const { app } = await createApp(config, directory);
      const anonymous = event();
      await request(app)
        .post('/api/logs')
        .set('x-earrr-client', '1')
        .send({ events: [anonymous] })
        .expect(202);
      await request(app)
        .post('/api/logs')
        .set('x-earrr-client', '1')
        .set('x-earrr-guest', guest.token)
        .send({ events: [event({ sessionId: started.snapshot.session!.id })] })
        .expect(404);
      await request(app)
        .post('/api/logs')
        .set('x-earrr-client', '1')
        .send({ events: [event({ source: 'server' })] })
        .expect(400);
      await Log.flush();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: anonymous.id,
        actor_id: null,
      });
    } finally {
      await directory.close();
    }
  });

  it('records verified account identity rather than any actor supplied by the client', async () => {
    const id = randomUUID();
    vi.spyOn(CloudRepository.prototype, 'user').mockResolvedValue({
      id,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: new Date().toISOString(),
    });
    vi.spyOn(CloudRepository.prototype, 'get').mockResolvedValue(null);
    const directory = new WorkspaceDirectory({
      ...config,
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'fixture-public',
      supabaseServiceKey: 'fixture-service',
      learningSaveKey: Buffer.alloc(32, 9).toString('base64'),
    });
    try {
      const { app } = await createApp(config, directory);
      await request(app)
        .post('/api/logs')
        .set('x-earrr-client', '1')
        .set('Authorization', 'Bearer fixture')
        .send({ events: [event()] })
        .expect(202);
      await Log.flush();
      expect(rows[0]?.actor_id).toBe(`account:${id}`);
    } finally {
      await directory.close();
    }
  });

  it('uses the persisted guest as retention identity across page restores', async () => {
    const directory = new WorkspaceDirectory({
      ...config,
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'fixture-public',
      supabaseServiceKey: 'fixture-service',
      learningSaveKey: Buffer.alloc(32, 9).toString('base64'),
    });
    try {
      const first = await directory.createGuest();
      expect(first.workspace.guestSave).toBeDefined();
      const restored = await directory.createGuest(first.workspace.guestSave!);
      const { app } = await createApp(config, directory);
      for (const token of [first.token, restored.token])
        await request(app)
          .post('/api/logs')
          .set('x-earrr-client', '1')
          .set('x-earrr-guest', token)
          .send({ events: [event()] })
          .expect(202);
      await Log.flush();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.actor_id))).toEqual(
        new Set([`guest:${first.workspace.id}`]),
      );
    } finally {
      await directory.close();
    }
  });

  it('logs grading only after its enclosing transaction commits', async () => {
    const store = await Store.open(':memory:');
    try {
      const { app, game } = await createApp(config, store);
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!.id;
      const played = await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
      const failed = vi
        .spyOn(game, 'recordEvent')
        .mockRejectedValueOnce(new Error('fixture rollback'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const input = {
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      };
      await request(app).post('/api/tools').set('x-earrr-client', '1').send(input).expect(500);
      await Log.flush();
      expect(rows.some((row) => row.event_name === 'user_submit_exercise_answer')).toBe(false);
      expect(rows.some((row) => row.event_name === 'server_request_failed')).toBe(true);
      failed.mockRestore();
      await request(app).post('/api/tools').set('x-earrr-client', '1').send(input).expect(200);
      await Log.flush();
      const grade = rows.find((row) => row.event_name === 'user_submit_exercise_answer')!;
      expect(grade.id).toBe(input.callId);
      expect(grade.session_id).toBe(sessionId);
      expect(grade.message).toMatchObject({
        callId: input.callId,
        questionId: exercise.id,
        score: 1,
      });
      expect(grade.message).not.toHaveProperty('answer');
      await request(app).post('/api/tools').set('x-earrr-client', '1').send(input).expect(200);
      await Log.flush();
      expect(
        new Set(
          rows
            .filter((row) => row.event_name === 'user_submit_exercise_answer')
            .map((row) => row.id),
        ).size,
      ).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('defines one service-only raw table and a 30-day received-time cleanup, without an analytics pipeline', () => {
    expect(migration.match(/create table /gi)).toHaveLength(1);
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke all on public.earrr_events from anon, authenticated');
    expect(migration).toContain('message jsonb not null');
    expect(migration).toContain("received_at < now() - interval '30 days'");
    expect(migration).toContain("'17 * * * *'");
    expect(migration).not.toMatch(/create materialized view|google.analytics/i);
    expect(compatibilityMigration).toContain('alter column source drop not null');
    for (const column of ['source', 'visit_id', 'visitor_id', 'release_id'])
      expect(leanMigration).toContain(`drop column ${column}`);
    expect(leanMigration).toContain("replace(replace(event_name, '.', '_'), '-', '_')");
    expect(leanMigration).not.toMatch(/delete from|truncate|create (?:table|materialized view)/i);
  });

  it('does not log successful requests, settings, playback or incomplete answers', async () => {
    const store = await Store.open(':memory:');
    try {
      const { app, game } = await createApp(config, store);
      await request(app).get('/api/state').expect(200);
      await request(app).get('/api/curriculum').expect(200);
      await request(app)
        .put('/api/settings')
        .set('x-earrr-client', '1')
        .send(await store.user.getSettings())
        .expect(200);
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!.id;
      const played = await request(app)
        .post('/api/tools')
        .set('x-earrr-client', '1')
        .send({
          callId: randomUUID(),
          sessionId,
          name: 'play_exercise',
          arguments: {},
        })
        .expect(200);
      await request(app)
        .post('/api/playback')
        .set('x-earrr-client', '1')
        .send({
          id: randomUUID(),
          sessionId,
          exerciseId: played.body.snapshot.current.id,
        })
        .expect(204);
      await request(app)
        .post('/api/tools')
        .set('x-earrr-client', '1')
        .send({
          callId: randomUUID(),
          sessionId,
          name: 'submit_answer',
          arguments: { exerciseId: played.body.snapshot.current.id, answer: {} },
        })
        .expect(200);
      await Log.flush();
      expect(rows).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('records one stable round result alongside each committed answer', async () => {
    const store = await Store.open(':memory:');
    try {
      const { app, game } = await createApp(config, store);
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!.id;
      for (let index = 0; index < 8; index++) {
        const question = await game.execute({
          callId: randomUUID(),
          sessionId,
          name: 'play_exercise',
          arguments: {},
        });
        const exercise = (await store.exercises.get(question.snapshot.current!.id))!;
        await request(app)
          .post('/api/tools')
          .set('x-earrr-client', '1')
          .send({
            callId: randomUUID(),
            sessionId,
            name: 'submit_answer',
            arguments: { exerciseId: exercise.id, answer: exercise.expected },
          })
          .expect(200);
      }
      await Log.flush();
      expect(rows.filter((row) => row.event_name === 'user_submit_exercise_answer')).toHaveLength(
        8,
      );
      const rounds = rows.filter((row) => row.event_name === 'user_complete_exercise_round');
      expect(rounds).toHaveLength(1);
      expect(rounds[0]!.id).toBe(rounds[0]!.message.id);
      expect(rounds[0]!.message).toMatchObject({ passed: true, correct: 8, answered: 8 });
      expect(rounds[0]!.message).not.toHaveProperty('answers');
    } finally {
      await store.close();
    }
  });
});

it.skipIf(!process.env.EARRR_TEST_POSTGRES_URL)(
  'purges only events received over 30 days ago, regardless of client clock skew',
  async () => {
    const connection = process.env.EARRR_TEST_POSTGRES_URL!;
    if (
      new URL(connection).hostname !== '127.0.0.1' ||
      process.env.EARRR_TEST_POSTGRES_ISOLATED !== '1'
    )
      throw new Error('The logging retention check requires the isolated local PostgreSQL runner.');
    const pool = new Pool({ connectionString: connection });
    const schema = `earrr_logs_${randomUUID().replaceAll('-', '')}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const definition = migration.match(
        /create table if not exists public\.earrr_events \([\s\S]*?\n\);/,
      )![0];
      await pool.query(definition.replace('public.earrr_events', `"${schema}".earrr_events`));
      await pool.query(
        compatibilityMigration.replaceAll('public.earrr_events', `"${schema}".earrr_events`),
      );
      const currentId = randomUUID();
      await pool.query(
        `INSERT INTO "${schema}".earrr_events(id,timestamp,event_name,level,environment,message)
         VALUES($1,now(),$2,'info','test','{}')`,
        [currentId, `user_${'training_'.repeat(11)}completed`],
      );
      const legacyId = randomUUID();
      await pool.query(
        `INSERT INTO "${schema}".earrr_events(id,timestamp,event_name,level,source,actor_id,environment,message)
        VALUES($1,now(),'app.opened','info','client','visitor:fixture','test','{}')`,
        [legacyId],
      );
      await pool.query(leanMigration.replaceAll('public.earrr_events', `"${schema}".earrr_events`));
      const legacy = await pool.query(
        `SELECT event_name,actor_id FROM "${schema}".earrr_events WHERE id=$1`,
        [legacyId],
      );
      expect(legacy.rows).toEqual([{ event_name: 'app_opened', actor_id: null }]);
      const columns = await pool.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
        [schema, 'earrr_events'],
      );
      for (const column of ['source', 'visit_id', 'visitor_id', 'release_id'])
        expect(columns.rows.map((row) => row.column_name)).not.toContain(column);
      expect(
        (await pool.query(`SELECT id FROM "${schema}".earrr_events WHERE id=$1`, [currentId])).rows,
      ).toHaveLength(1);
      await pool.query(`DELETE FROM "${schema}".earrr_events WHERE id=ANY($1::uuid[])`, [
        [legacyId, currentId],
      ]);
      const insert = `INSERT INTO "${schema}".earrr_events(id,timestamp,received_at,event_name,level,environment,message)
      VALUES($1,$2,$3,'fixture_event','info','test','{"count":1}')`;
      await pool.query(insert, [randomUUID(), '2099-01-01', new Date(Date.now() - 31 * 86400_000)]);
      await pool.query(insert, [randomUUID(), '2000-01-01', new Date()]);
      const cleanup = migration.match(/\$\$(delete from public\.earrr_events[\s\S]*?;)\$\$/)?.[1];
      if (!cleanup) throw new Error('The retention migration is missing its cleanup query.');
      await pool.query(cleanup.replace('public.earrr_events', `"${schema}".earrr_events`));
      const kept = await pool.query(`SELECT timestamp FROM "${schema}".earrr_events`);
      expect(kept.rows).toHaveLength(1);
      expect(kept.rows[0].timestamp.getUTCFullYear()).toBe(2000);
    } finally {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  },
);

import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/db/database.js';
import { createApp } from '../server/app.js';
import { FeedbackRepository } from '../server/repositories/feedback.repository.js';
import { CloudRepository } from '../server/repositories/cloud.repository.js';
import { WorkspaceDirectory } from '../server/services/storage/workspace.js';
import { exportLearning, importLearning } from '../server/services/storage/archive.js';
import { feedbackSchema } from '../shared/schemas/feedback.js';
import type { FeedbackSubmission } from '../shared/types/feedback.js';
import { AppError } from '../server/errors/app-error.js';

const config = {
  port: 3101,
  databasePath: ':memory:',
  apiKey: '',
  azureEndpoint: '',
  configured: false,
  deployment: 'test',
  transcriptionDeployment: '',
};
const submission: FeedbackSubmission = {
  rating: 4,
  message: 'The short questions make practice easier.',
  replyEmail: null,
};
afterEach(() => vi.restoreAllMocks());

describe('simple owner-scoped feedback', () => {
  it('validates a bounded rating, message and optional response address without client identity fields', () => {
    expect(feedbackSchema.parse({ ...submission, message: '  Helpful.  ' }).message).toBe(
      'Helpful.',
    );
    expect(
      feedbackSchema.parse({ ...submission, replyEmail: 'listener@example.com' }).replyEmail,
    ).toBe('listener@example.com');
    for (const values of [
      { rating: 0 },
      { rating: 6 },
      { rating: 2.5 },
      { rating: '4' },
      { message: '   ' },
      { message: 'x'.repeat(4001) },
      { replyEmail: 'not-an-email' },
      { replyEmail: 'x'.repeat(255) },
      { actorId: 'account:someone-else' },
      { sessionId: randomUUID() },
    ])
      expect(feedbackSchema.safeParse({ ...submission, ...values }).success).toBe(false);
  });

  it('replaces the local player row across sessions without changing learning or copying feedback into saves', async () => {
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
      const before = await game.snapshot();
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .send({ ...submission, replyEmail: 'listener@example.com' })
        .expect(204);
      const first = await store.db.prepare('SELECT * FROM earrr_feedback').get();
      expect(first).toMatchObject({
        actor_id: 'local',
        session_id: sessionId,
        rating: 4,
        reply_email: 'listener@example.com',
      });
      expect(await game.snapshot()).toEqual(before);
      await game.execute({ callId: randomUUID(), sessionId, name: 'end_session', arguments: {} });
      const secondId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!.id;
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .send({ rating: 5, message: 'I like the new pacing.', replyEmail: null })
        .expect(204);
      const rows = await store.db.prepare('SELECT * FROM earrr_feedback').all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: 'local',
        session_id: secondId,
        rating: 5,
        message: 'I like the new pacing.',
        reply_email: null,
        created_at: first!.created_at,
      });
      const archive = await exportLearning(store);
      expect(archive.tables).not.toHaveProperty('earrr_feedback');
      expect(JSON.stringify(archive)).not.toContain('listener@example.com');
      await importLearning(store, archive);
      expect(await store.db.prepare('SELECT * FROM earrr_feedback').all()).toEqual(rows);
    } finally {
      await store.close();
    }
  });

  it('persists local feedback after the app closes and reopens', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'feedback-persistence-'));
    const path = join(directory, 'local.sqlite');
    let store = await Store.open(path);
    try {
      await new FeedbackRepository(store.db).save('local', null, submission);
      await store.close();
      store = await Store.open(path);
      expect(await store.db.prepare('SELECT * FROM earrr_feedback').get()).toMatchObject({
        actor_id: 'local',
        rating: 4,
        message: submission.message,
        reply_email: null,
      });
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses Supabase merge-upsert on the verified owner instead of appending duplicate rows', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 201 }));
    const client = createClient('https://example.supabase.co', 'fixture-service-key', {
      global: { fetch: fetcher },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await new FeedbackRepository(client).save(`guest:${randomUUID()}`, null, submission);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('/rest/v1/earrr_feedback?on_conflict=actor_id');
    expect(new Headers(options?.headers).get('prefer')).toContain('resolution=merge-duplicates');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      rating: 4,
      message: submission.message,
      reply_email: null,
    });
    expect(JSON.parse(String(options?.body))).not.toHaveProperty('created_at');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('assigns account/guest identity on the server and keeps unrelated owners separate', async () => {
    const accountId = randomUUID();
    vi.spyOn(CloudRepository.prototype, 'user').mockImplementation(async (token) => {
      if (token !== 'account-fixture') throw AppError.create('invalid_auth_session');
      return {
        id: accountId,
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
        email_confirmed_at: new Date().toISOString(),
      };
    });
    vi.spyOn(CloudRepository.prototype, 'get').mockResolvedValue(null);
    vi.spyOn(CloudRepository.prototype, 'put').mockResolvedValue();
    const rows = new Map<string, FeedbackSubmission>();
    const save = vi
      .spyOn(FeedbackRepository.prototype, 'save')
      .mockImplementation(async (actorId, _sessionId, input) => {
        rows.set(actorId, input);
      });
    const directory = new WorkspaceDirectory({
      ...config,
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'fixture-public-key',
      supabaseServiceKey: 'fixture-service-key',
      learningSaveKey: Buffer.alloc(32, 7).toString('base64'),
    });
    try {
      const first = await directory.createGuest();
      const restored = await directory.createGuest(first.workspace.guestSave!);
      const other = await directory.createGuest();
      const { app } = await createApp(config, directory);
      for (const token of [first.token, restored.token, other.token])
        await request(app)
          .post('/api/feedback')
          .set('x-earrr-client', '1')
          .set('x-earrr-guest', token)
          .send(submission)
          .expect(204);
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .set('Authorization', 'Bearer account-fixture')
        .send(submission)
        .expect(204);
      expect(rows.size).toBe(3);
      expect(rows.has(`guest:${first.workspace.id}`)).toBe(true);
      expect(rows.has(`guest:${other.workspace.id}`)).toBe(true);
      expect(rows.has(`account:${accountId}`)).toBe(true);
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .set('x-earrr-guest', first.token)
        .send({ ...submission, actorId: `guest:${other.workspace.id}` })
        .expect(400);
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .set('x-earrr-guest', 'missing-capability')
        .send(submission)
        .expect(401);
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .set('Authorization', 'Bearer invalid-token')
        .send(submission)
        .expect(401);
      expect(save).toHaveBeenCalledTimes(4);
      await request(app).get('/api/feedback').set('x-earrr-guest', first.token).expect(404);
    } finally {
      await directory.close();
    }
  });

  it('requires app-origin protections and reports real storage errors without exposing submitted content', async () => {
    const store = await Store.open(':memory:');
    try {
      const { app } = await createApp(config, store);
      await request(app).post('/api/feedback').send(submission).expect(403);
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .set('Origin', 'https://other.example')
        .send(submission)
        .expect(403);
      await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .send({ ...submission, rating: 0 })
        .expect(400);
      vi.spyOn(FeedbackRepository.prototype, 'save').mockRejectedValueOnce(
        AppError.create('feedback_storage_unavailable'),
      );
      const response = await request(app)
        .post('/api/feedback')
        .set('x-earrr-client', '1')
        .send({ ...submission, replyEmail: 'private@example.com' })
        .expect(503);
      expect(response.body.error.code).toBe('feedback_storage_unavailable');
      expect(JSON.stringify(response.body)).not.toMatch(/private@example|short questions/);
      expect(await store.db.prepare('SELECT * FROM earrr_feedback').all()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('defines one service-only central table with a unique owner and no analytics or learning linkage', () => {
    const migration = readFileSync(
      new URL('../supabase/migrations/20261006180000_earrr_feedback.sql', import.meta.url),
      'utf8',
    );
    expect(migration.match(/create table /gi)).toHaveLength(1);
    expect(migration).toContain('actor_id text primary key');
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke all on public.earrr_feedback from anon, authenticated');
    expect(migration).toContain(
      'grant select, insert, update on public.earrr_feedback to service_role',
    );
    expect(migration).not.toMatch(/earrr_events|earrr_learning_saves|create policy|pg_cron/);
  });
});

it.skipIf(!process.env.EARRR_TEST_POSTGRES_URL)(
  'persists feedback upserts through the same isolated PostgreSQL storage boundary',
  async () => {
    const connection = new URL(process.env.EARRR_TEST_POSTGRES_URL!);
    if (connection.hostname !== '127.0.0.1' || process.env.EARRR_TEST_POSTGRES_ISOLATED !== '1')
      throw new Error('Feedback storage checks require isolated local PostgreSQL.');
    const pool = new Pool({ connectionString: connection.href });
    const schema = `earrr_feedback_${randomUUID().replaceAll('-', '')}`;
    let store: Store | undefined;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      store = await Store.open(connection.href);
      const repository = new FeedbackRepository(store.db);
      const actorId = `guest:${randomUUID()}`;
      await repository.save(actorId, null, submission);
      await repository.save(actorId, null, {
        ...submission,
        rating: 5,
        replyEmail: 'reply@example.com',
      });
      const rows = await store.db.prepare('SELECT * FROM earrr_feedback').all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: actorId,
        rating: 5,
        reply_email: 'reply@example.com',
      });
    } finally {
      await store?.close();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  },
);

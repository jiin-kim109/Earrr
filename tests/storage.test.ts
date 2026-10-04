import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { postgresParameters } from '../server/db/postgres.js';
import { createApp } from '../server/app.js';
import request from 'supertest';
import type { ToolName } from '../server/types/agent.types.js';
import { migrateLegacyData } from '../server/db/migrations.js';
import { initializePostgres } from '../server/db/postgres-schema.js';
import { exportLearning, importLearning } from '../server/services/storage/archive.js';
import type { Transcript } from '../shared/types/user.js';

const postgresUrl = process.env.EARRR_TEST_POSTGRES_URL;
const backends = [':memory:', ...(postgresUrl ? [postgresUrl] : [])];

async function openStore(connection: string) {
  if (connection === ':memory:') {
    const store = await Store.open(connection);
    return { store, cleanup: () => store.close() };
  }
  const url = new URL(connection);
  if (url.hostname !== '127.0.0.1' || process.env.EARRR_TEST_POSTGRES_ISOLATED !== '1')
    throw new Error('Storage tests require the isolated local PostgreSQL runner.');
  const schema = `earrr_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: connection });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  try {
    const store = await Store.open(url.href);
    return {
      store,
      cleanup: async () => {
        await store.close();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
}

for (const connection of backends) {
  describe(connection === ':memory:' ? 'SQLite database port' : 'PostgreSQL database port', () => {
    it('persists sessions, rounds, receipts and canonical chat without checkpoint copies', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const game = await AgentService.create(store, false, 'test');
        const sessionId = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'solo' },
          })
        ).snapshot.session!.id;
        const call = (name: ToolName, args: object = {}) =>
          game.execute({ callId: randomUUID(), sessionId, name, arguments: args });
        const question = await call('play_exercise');
        const exercise = (await store.exercises.get(question.snapshot.current!.id))!;
        const result = await call('submit_answer', {
          exerciseId: exercise.id,
          answer: exercise.expected,
        });
        expect(result.snapshot.totalAnswers).toBe(1);
        expect(result.snapshot.course.round.correct).toBe(1);
        const feedback = await game.exercises.reviewAnswer(result.snapshot.feedback!.attemptId!);
        expect(feedback.example.midi).toEqual(exercise.audio.events.map((note) => note.midi));
        const next = await call('play_exercise');
        const count = (await game.snapshot()).session!.listened;
        const receipt = randomUUID();
        await store.transaction(async () => {
          await store.sessions.recordPlayback(
            receipt,
            exercise.id,
            (await store.sessions.get(sessionId))!,
          );
          await store.sessions.recordPlayback(
            receipt,
            exercise.id,
            (await store.sessions.get(sessionId))!,
          );
        });
        expect((await game.snapshot()).session!.listened).toBe(count + 1);
        const message: Transcript = {
          id: randomUUID(),
          sessionId,
          role: 'user',
          text: 'Could you replay that answer?',
          createdAt: new Date().toISOString(),
        };
        await store.conversations.saveMessage(message);
        expect((await game.snapshot()).transcript).toEqual([message]);
        expect((await store.conversations.latest(sessionId))?.state).not.toHaveProperty('messages');
        const before = (await game.snapshot()).course;
        const replay = await call('replay_exercise', { exerciseId: exercise.id });
        expect(replay.review?.exerciseId).toBe(exercise.id);
        expect(replay.snapshot.current?.id).toBe(next.snapshot.current!.id);
        expect(replay.snapshot.course).toEqual(before);
        const reopened = await AgentService.create(store, false, 'test');
        expect((await reopened.snapshot()).current?.id).toBe(next.snapshot.current!.id);
        expect((await reopened.snapshot()).transcript).toEqual([message]);
        expect((await store.conversations.events(sessionId, 0)).length).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });

    it('orders dialogue across sessions, upserts in place, and rejects foreign-session overwrites', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const game = await AgentService.create(store, false, 'test');
        const first = await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        });
        const sessionId = first.snapshot.session!.id;
        const later: Transcript = {
          id: 'assistant:later',
          sessionId,
          role: 'assistant',
          text: 'The notes go up.',
          createdAt: '2026-10-02T10:00:02.000Z',
          delivery: 'spoken',
          feedbackId: randomUUID(),
        };
        const earlier: Transcript = {
          id: 'user:earlier',
          sessionId,
          role: 'user',
          text: 'Up?',
          createdAt: '2026-10-02T10:00:01.000Z',
        };
        await store.conversations.saveMessage(later);
        await store.conversations.saveMessage(earlier);
        const sequence = (await store.db
          .prepare('SELECT seq FROM transcripts WHERE id=?')
          .get(later.id))!.seq;
        const updated = { ...later, text: 'The notes go', delivery: 'interrupted' as const };
        await store.conversations.saveMessage(updated);
        await store.conversations.saveMessage(updated);
        expect(
          (await store.db.prepare('SELECT seq FROM transcripts WHERE id=?').get(later.id))!.seq,
        ).toBe(sequence);
        await game.execute({ callId: randomUUID(), sessionId, name: 'end_session', arguments: {} });
        const next = await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        });
        const currentId = next.snapshot.session!.id;
        const tied: Transcript = {
          ...earlier,
          id: 'system:new-session',
          sessionId: currentId,
          role: 'system',
          text: 'Practice resumed.',
        };
        await store.conversations.saveMessage(tied);
        await expect(
          store.conversations.saveMessage({ ...updated, sessionId: currentId }),
        ).rejects.toMatchObject({ code: 'call_id_reused' });
        await expect(
          store.conversations.saveMessage({
            ...updated,
            id: randomUUID(),
            sessionId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'session_not_found' });
        expect((await game.snapshot()).transcript).toEqual([earlier, tied, updated]);
        expect(await store.conversations.messages(0)).toEqual([]);
        await expect(store.conversations.messages(-1)).rejects.toThrow();
        expect((await store.conversations.latest(sessionId))?.state).not.toHaveProperty('messages');
      } finally {
        await cleanup();
      }
    });

    it('returns only the newest 100 ordered messages while archiving every canonical record', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const game = await AgentService.create(store, false, 'test');
        const sessionId = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'solo' },
          })
        ).snapshot.session!.id;
        const messages: Transcript[] = Array.from({ length: 105 }, (_, index) => ({
          id: `user:window-${index}`,
          sessionId,
          role: 'user',
          text: `Saved message ${index}.`,
          createdAt: new Date(
            Date.UTC(2026, 9, 2, 10, 0, Math.floor((104 - index) / 2)),
          ).toISOString(),
        }));
        await store.transaction(async () => {
          for (const message of messages) await store.conversations.saveMessage(message);
        });
        const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        expect((await game.snapshot()).transcript).toEqual(ordered.slice(-100));
        const archive = await exportLearning(store);
        expect(archive.tables.transcripts).toHaveLength(105);
        expect(await importLearning(store, archive)).toBe(false);
        expect(await exportLearning(store)).toEqual(archive);
        expect((await game.snapshot()).transcript).toEqual(ordered.slice(-100));
        const latest: Transcript = {
          ...messages[0]!,
          id: 'assistant:after-import',
          role: 'assistant',
          text: 'The imported history is intact.',
          createdAt: '2026-10-02T10:01:00.000Z',
        };
        await store.conversations.saveMessage(latest);
        expect((await game.snapshot()).transcript).toEqual([...ordered, latest].slice(-100));
        expect((await exportLearning(store)).tables.transcripts).toHaveLength(106);
      } finally {
        await cleanup();
      }
    });

    it('serializes concurrent identical grading and rolls back a failed checkpoint', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const game = await AgentService.create(store, false, 'test');
        const sessionId = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'solo' },
          })
        ).snapshot.session!.id;
        const play = () =>
          game.execute({ callId: randomUUID(), sessionId, name: 'play_exercise', arguments: {} });
        const exercise = (await store.exercises.get((await play()).snapshot.current!.id))!;
        const input = {
          callId: randomUUID(),
          sessionId,
          name: 'submit_answer',
          arguments: { exerciseId: exercise.id, answer: exercise.expected },
        };
        await Promise.all([game.execute(input), game.execute(input), game.execute(input)]);
        expect((await game.snapshot()).course.round.answers).toHaveLength(1);
        expect((await game.snapshot()).totalAnswers).toBe(1);
        const pending = (await store.exercises.get((await play()).snapshot.current!.id))!;
        const failed = {
          ...input,
          callId: randomUUID(),
          arguments: { exerciseId: pending.id, answer: pending.expected },
        };
        const save = vi
          .spyOn(game, 'recordEvent')
          .mockRejectedValueOnce(new Error('Checkpoint failed'));
        await expect(game.execute(failed)).rejects.toThrow('Checkpoint failed');
        save.mockRestore();
        expect(await store.attempts.get(pending.id)).toBeNull();
        expect((await store.exercises.get(pending.id))?.status).toBe('unanswered');
        expect((await game.execute(failed)).snapshot.totalAnswers).toBe(2);
      } finally {
        await cleanup();
      }
    });

    it('migrates old chat tables, caption events and checkpoint messages without changing learning or tool retries', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const game = await AgentService.create(store, false, 'test');
        const sessionId = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'solo' },
          })
        ).snapshot.session!.id;
        const callId = randomUUID();
        const played = await game.execute({
          callId,
          sessionId,
          name: 'play_exercise',
          arguments: {},
        });
        const checkpoint = (await store.conversations.latest(sessionId))!;
        const cached = (await store.agent.getCall(callId))!;
        const marker = 'OLD CAPTION PAYLOAD';
        const oldState = JSON.stringify({ ...checkpoint.state, messages: [{ text: marker }] });
        const canonical: Transcript = {
          id: randomUUID(),
          sessionId,
          role: 'assistant',
          text: marker,
          createdAt: new Date().toISOString(),
          delivery: 'spoken',
        };
        await store.conversations.saveMessage(canonical);
        await store.db
          .prepare('UPDATE session_checkpoints SET state=? WHERE sequence=?')
          .run(oldState, checkpoint.sequence);
        const event = await store.db
          .prepare(
            'INSERT INTO conversation_events(event_id,session_id,kind,created_at,payload) VALUES(?,?,?,?,?) RETURNING sequence',
          )
          .get(
            randomUUID(),
            sessionId,
            'message.saved',
            new Date().toISOString(),
            JSON.stringify({ text: marker }),
          );
        await store.db
          .prepare(
            'INSERT INTO session_checkpoints(session_id,event_sequence,created_at,state) VALUES(?,?,?,?)',
          )
          .run(sessionId, event!.sequence!, new Date().toISOString(), oldState);
        await store.db
          .prepare('UPDATE tool_calls SET data=? WHERE id=?')
          .run(
            JSON.stringify({ ...cached.payload, snapshot: { transcript: [{ text: marker }] } }),
            callId,
          );
        if (store.db.kind === 'sqlite') {
          await store.db.exec('PRAGMA user_version = 10');
          await migrateLegacyData(store, 10, () => new Date());
        } else {
          await store.db.exec('UPDATE schema_version SET version=10 WHERE id=1');
          await initializePostgres(store.db);
        }
        const schema =
          store.db.kind === 'sqlite'
            ? "SELECT name FROM sqlite_master WHERE name='transcripts'"
            : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='transcripts'";
        expect(await store.db.prepare(schema).all()).toHaveLength(1);
        expect((await game.snapshot()).transcript).toEqual([canonical]);
        expect((await game.snapshot()).current).toEqual(played.snapshot.current);
        expect((await game.snapshot()).session).toEqual(played.snapshot.session);
        expect((await store.conversations.latest(sessionId))?.state).not.toHaveProperty('messages');
        expect(JSON.stringify(await store.conversations.events(sessionId))).not.toContain(marker);
        const restoredCall = (await store.agent.getCall(callId))!;
        expect(restoredCall.hash).toBe(cached.hash);
        expect(restoredCall.payload).toEqual(cached.payload);
        expect(
          Number(
            (
              await store.db
                .prepare(
                  store.db.kind === 'sqlite'
                    ? 'PRAGMA user_version'
                    : 'SELECT version AS user_version FROM schema_version WHERE id=1',
                )
                .get()
            )?.user_version,
          ),
        ).toBe(13);
      } finally {
        await cleanup();
      }
    });

    it('recreates schema-11 chat storage without changing learning records or retry hashes', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const game = await AgentService.create(store, false, 'test');
        const started = await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        });
        const sessionId = started.snapshot.session!.id;
        const callId = randomUUID();
        await game.execute({ callId, sessionId, name: 'play_exercise', arguments: {} });
        const before = await exportLearning(store);
        const cached = await store.agent.getCall(callId);
        await store.db.exec('DROP TABLE transcripts');
        if (store.db.kind === 'sqlite') {
          await store.db.exec('PRAGMA user_version = 11');
          await migrateLegacyData(store, 11, () => new Date());
        } else {
          await store.db.exec('UPDATE schema_version SET version=11 WHERE id=1');
          await initializePostgres(store.db);
        }
        expect(await exportLearning(store)).toEqual(before);
        expect(await store.agent.getCall(callId)).toEqual(cached);
        const message: Transcript = {
          id: 'user:after-version-11',
          sessionId,
          role: 'user',
          text: 'Keep this conversation.',
          createdAt: new Date().toISOString(),
        };
        await store.conversations.saveMessage(message);
        expect((await game.snapshot()).transcript).toEqual([message]);
      } finally {
        await cleanup();
      }
    });

    it('holds snapshots behind pending writes rather than exposing partial state', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const game = await AgentService.create(store, false, 'test');
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const updating = store.transaction(async () => {
          await store.user.saveSettings({ ...(await store.user.getSettings()), volume: 0.25 });
          entered();
          await gate;
        });
        await inside;
        let complete = false;
        const snapshot = game.snapshot().then((result) => {
          complete = true;
          return result;
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(complete).toBe(false);
        } finally {
          release();
        }
        await updating;
        expect((await snapshot).settings.volume).toBe(0.25);
      } finally {
        await cleanup();
      }
    });

    it('keeps concurrent playback receipts from overwriting a committed answer', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        const { app, game } = await createApp(
          {
            port: 3101,
            databasePath: ':memory:',
            azureEndpoint: '',
            apiKey: '',
            deployment: 'test',
            transcriptionDeployment: '',
            configured: false,
          },
          store,
        );
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
        const calls = [
          request(app)
            .post('/api/tools')
            .set('x-earrr-client', '1')
            .send({
              callId: randomUUID(),
              sessionId,
              name: 'submit_answer',
              arguments: { exerciseId: exercise.id, answer: exercise.expected },
            }),
          ...Array.from({ length: 4 }, () =>
            request(app).post('/api/playback').set('x-earrr-client', '1').send({
              id: randomUUID(),
              sessionId,
              exerciseId: exercise.id,
            }),
          ),
        ];
        const responses = await Promise.all(calls);
        expect(responses.every((response) => response.status < 300)).toBe(true);
        const state = await game.snapshot();
        expect(state.session).toMatchObject({ answered: 1, correct: 1, listened: 4 });
        expect(state.course.round.correct).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it('persists tutorial positions and confirmed round resets through the shared service API', async () => {
      const { store, cleanup } = await openStore(connection);
      try {
        await store.progress.completeLesson('pitch-direction', new Date().toISOString());
        const game = await AgentService.create(store, true, 'test');
        const sessionId = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'coach', focus: 'intervals-foundation' },
          })
        ).snapshot.session!.id;
        const call = (name: ToolName, args: object = {}, agent = true) =>
          game.execute({ callId: randomUUID(), sessionId, name, arguments: args }, agent);
        const parked = await call('start_practice');
        const demo = await call('teach_lesson', { stepId: 'major-third' });
        await call('select_lesson', { skillId: 'pitch-direction' });
        const returned = await call('select_lesson', { skillId: 'intervals-foundation' });
        expect(returned.teaching).toMatchObject({
          stepId: 'major-third',
          autoContinue: true,
          example: demo.teaching!.example,
        });
        expect(returned.teaching?.presentationId).not.toBe(demo.teaching!.presentationId);
        expect(returned.snapshot.current?.id).toBe(parked.snapshot.current!.id);
        const roundId = returned.snapshot.course.round.id!;
        const reset = await call('teach_lesson', { restart: true, discardRoundId: roundId });
        expect(reset.snapshot.current).toBeNull();
        expect(reset.snapshot.course.round.answers).toEqual([]);
        expect(reset.snapshot.course.round.id).not.toBe(roundId);
        expect(reset.snapshot.totalAnswers).toBe(0);
        await expect(
          call('teach_lesson', { restart: true, discardRoundId: roundId }),
        ).rejects.toThrow('round changed');
        const preserved = await store.sessions.lessonPosition('intervals-foundation', 'coach');
        expect(preserved?.teaching?.index).toBe(demo.teaching!.index);
      } finally {
        await cleanup();
      }
    });
  });
}

it('binds PostgreSQL placeholders without touching quoted text or comments', () => {
  expect(
    postgresParameters(`SELECT '?' AS literal, ? AS value, "?" -- ?\nWHERE key = ? /* ? */`),
  ).toBe(`SELECT '?' AS literal, $1 AS value, "?" -- ?\nWHERE key = $2 /* ? */`);
});

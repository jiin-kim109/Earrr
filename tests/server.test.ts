import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config/environment.js';
import { Store } from '../server/db/database.js';
import type { ToolName, ToolResult } from '../server/types/agent.types.js';
import { parseSoloAnswer } from '../server/services/grading.service.js';
import { publicExercise } from '../server/services/exercise/exercise.service.js';
import { skills } from '../server/services/exercise/catalog.js';

import request from 'supertest';

const config: Config = {
  port: 3000,
  databasePath: ':memory:',
  azureEndpoint: 'https://example.cognitiveservices.azure.com',
  apiKey: 'test-credential-not-a-real-key',
  deployment: 'test-realtime',
  transcriptionDeployment: '',
  configured: true,
};
let store: Store;
let app: Awaited<ReturnType<typeof createApp>>['app'];
let game: Awaited<ReturnType<typeof createApp>>['game'];
let sessionId: string;

const tool = (name: ToolName, args: Record<string, unknown> = {}, callId = randomUUID()) =>
  request(app)
    .post('/api/tools')
    .set('x-earrr-client', '1')
    .send({ callId, name, arguments: args, ...(sessionId ? { sessionId } : {}) });

beforeEach(async () => {
  store = await Store.open(':memory:');
  ({ app, game } = await createApp(config, store));
  sessionId = '';
});
afterEach(async () => await store.close());

async function start(focus = 'triads', mode = 'solo') {
  for (const skill of skills.slice(
    0,
    skills.findIndex((item) => item.id === focus),
  )) {
    await store.db
      .prepare('INSERT OR IGNORE INTO lesson_completions(skill_id,completed_at) VALUES(?,?)')
      .run(skill.id, new Date().toISOString());
  }
  const result = await tool('start_session', { focus, mode });
  expect(result.status).toBe(200);
  sessionId = (result.body as ToolResult).snapshot.session!.id;
  const played = await tool(mode === 'coach' ? 'start_practice' : 'play_exercise');
  expect(played.status).toBe(200);
  return played.body as ToolResult;
}

describe('local session authority', () => {
  it('saves canonical chat without duplicating learning checkpoints or provider events', async () => {
    await start();
    const initial = (await store.conversations.latest(sessionId))!;
    expect(initial.state.current?.id).toBe((await store.sessions.active())?.currentExerciseId);
    const event = {
      id: randomUUID(),
      sessionId,
      type: 'response.interrupted',
      responseId: 'response-a',
      turn: 2,
      createdAt: new Date().toISOString(),
    };
    await request(app).post('/api/events').set('x-earrr-client', '1').send(event).expect(404);
    const message = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      text: 'Play the example again.',
      createdAt: new Date().toISOString(),
    };
    await request(app).post('/api/transcript').set('x-earrr-client', '1').send(message).expect(204);
    await request(app).post('/api/transcript').set('x-earrr-client', '1').send(message).expect(204);
    expect(await store.conversations.latest(sessionId)).toEqual(initial);
    expect((await request(app).get('/api/state')).body.transcript).toEqual([message]);
    const callId = randomUUID();
    await tool('replay_exercise', {}, callId).expect(200);
    await tool('replay_exercise', {}, callId).expect(200);
    const events = await request(app).get(`/api/sessions/${sessionId}/events`).expect(200);
    expect(events.body.filter((item: { id: string }) => item.id === `tool:${callId}`)).toHaveLength(
      1,
    );
    const checkpoint = await request(app).get(`/api/sessions/${sessionId}/checkpoint`).expect(200);
    expect(checkpoint.body.sequence).toBeGreaterThan(initial.sequence);
    expect(checkpoint.body.state).not.toHaveProperty('messages');
    expect(checkpoint.body.state.current).not.toHaveProperty('expected');
    expect(checkpoint.body.state.session.id).toBe(sessionId);
    expect((await request(app).get('/api/state')).body.transcript).toEqual([message]);
    expect(JSON.stringify(events.body)).not.toContain(message.text);
  });

  it('validates transcript fields and refuses a stable message ID from another session', async () => {
    await start('pitch-direction');
    const message = {
      id: 'assistant:stable-response',
      sessionId,
      role: 'assistant',
      text: 'Listen to the second note.',
      createdAt: '2026-10-02T10:00:00.000Z',
      delivery: 'spoken',
      feedbackId: randomUUID(),
    };
    for (const invalid of [
      { ...message, role: 'tool' },
      { ...message, delivery: 'pending' },
      { ...message, createdAt: 'yesterday' },
      { ...message, feedbackId: 'not-an-attempt' },
      { ...message, text: '' },
      { ...message, responseId: 'provider-boundary' },
    ]) {
      await request(app)
        .post('/api/transcript')
        .set('x-earrr-client', '1')
        .send(invalid)
        .expect(400);
    }
    await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .send({ ...message, sessionId: randomUUID() })
      .expect(404);
    await request(app).post('/api/transcript').send(message).expect(403);
    await request(app).post('/api/transcript').set('x-earrr-client', '1').send(message).expect(204);
    await tool('end_session').expect(200);
    expect((await request(app).get('/api/state')).body.transcript).toEqual([message]);
    await start('pitch-direction');
    const conflict = await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .send({ ...message, sessionId, text: 'Overwrite another session.' })
      .expect(409);
    expect(conflict.body.error.code).toBe('call_id_reused');
    const updated = { ...message, text: 'Listen to the second', delivery: 'interrupted' };
    await request(app).post('/api/transcript').set('x-earrr-client', '1').send(updated).expect(204);
    expect((await request(app).get('/api/state')).body.transcript).toEqual([updated]);
    expect((await store.conversations.messages()).map((item) => item.sessionId)).toEqual([
      message.sessionId,
    ]);
  });

  it('prepares next material atomically with agent grading, but never changes a checkpoint without a choice', async () => {
    const first = await start('triads', 'coach');
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    const body = {
      callId: randomUUID(),
      sessionId,
      name: 'submit_answer',
      arguments: { exerciseId: exercise.id, answer: exercise.expected },
    };
    const answer = await request(app)
      .post('/api/agent/tools')
      .set('x-earrr-client', '1')
      .send(body)
      .expect(200);
    expect(answer.body.grade.verdict).toBe('correct');
    expect(answer.body.gradedExerciseId).toBe(exercise.id);
    expect(answer.body.snapshot.current.id).not.toBe(exercise.id);
    expect(answer.body.audio.events.length).toBeGreaterThan(0);
    const repeated = await request(app)
      .post('/api/agent/tools')
      .set('x-earrr-client', '1')
      .send(body)
      .expect(200);
    expect(repeated.body.snapshot.totalAnswers).toBe(1);
    expect((await store.conversations.latest(sessionId))?.state.feedback?.exerciseId).toBe(
      exercise.id,
    );
  });

  it('removes all separate narrator endpoints', async () => {
    await request(app).post('/api/speech').set('x-earrr-client', '1').send({}).expect(404);
    await request(app)
      .post('/api/feedback/delivered')
      .set('x-earrr-client', '1')
      .send({})
      .expect(404);
  });

  it('rolls back grading if its durable checkpoint cannot be written', async () => {
    const played = await start();
    const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
    const before = (await store.conversations.latest(sessionId))!.sequence;
    const original = game.recordEvent.bind(game);
    game.recordEvent = () => {
      throw new Error('Simulated checkpoint write failure.');
    };
    const callId = randomUUID();
    await tool(
      'submit_answer',
      { exerciseId: exercise.id, answer: exercise.expected },
      callId,
    ).expect(500);
    expect(await store.attempts.get(exercise.id)).toBeNull();
    expect(await store.agent.getCall(callId)).toBeNull();
    expect((await store.conversations.latest(sessionId))?.sequence).toBe(before);
    game.recordEvent = original;
    const result = await tool(
      'submit_answer',
      { exerciseId: exercise.id, answer: exercise.expected },
      callId,
    );
    expect(result.body.snapshot.totalAnswers).toBe(1);
  });

  it('starts with honest empty progress and no exposed key or answer', async () => {
    const initial = await request(app).get('/api/state');
    expect(initial.body.totalAnswers).toBe(0);
    expect(initial.body.transcript).toEqual([]);
    expect(initial.body.streak).toBe(0);
    expect(initial.body.progress).toHaveLength(skills.length);
    expect(JSON.stringify(initial.body)).not.toContain(config.apiKey);
    const played = await start();
    expect(played.snapshot.current).not.toHaveProperty('expected');
    expect(played.snapshot.current).not.toHaveProperty('reveal');
    expect(played.audio?.events.length).toBeGreaterThan(0);
  });

  it('does not replace an unanswered exercise, even after another play request', async () => {
    const first = await start();
    const blocked = await tool('play_exercise', { skillId: 'extensions' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('lesson_change_required');
    const replayed = await tool('play_exercise');
    expect(replayed.body.snapshot.current.id).toBe(first.snapshot.current!.id);
    expect(replayed.body.audio).toEqual(first.audio);
  });

  it('keeps answers and mastery idempotent across duplicate or retried tool calls', async () => {
    const first = await start();
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    const callId = randomUUID();
    const args = { exerciseId: exercise.id, answer: exercise.expected };
    const scored = await tool('submit_answer', args, callId);
    const retried = await tool('submit_answer', args, callId);
    const duplicate = await tool('submit_answer', args);
    expect(scored.body.grade.verdict).toBe('correct');
    expect(retried.body.snapshot.progress).toEqual(scored.body.snapshot.progress);
    expect(duplicate.body.snapshot.totalAnswers).toBe(1);
    expect(await store.attempts.recent()).toHaveLength(1);
    expect(scored.body.snapshot).not.toHaveProperty('achievements');
    expect(scored.body.snapshot).not.toHaveProperty('totalXp');
  });

  it('rejects reusing a call identifier for a different action', async () => {
    await start();
    const callId = randomUUID();
    await tool('inspect_progress', {}, callId);
    expect((await tool('pause_session', {}, callId)).status).toBe(409);
    expect((await store.sessions.active())?.status).toBe('active');
  });

  it('does not let a delayed answer score the next question', async () => {
    const first = await start();
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    await tool('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
    await tool('play_exercise');
    const stale = await tool('submit_answer', {
      exerciseId: exercise.id,
      answer: exercise.expected,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_exercise');
    expect((await store.attempts.totals()).answers).toBe(1);
  });

  it('preserves context through pause, resume, and free replays', async () => {
    const first = await start();
    expect((await tool('pause_session')).status).toBe(200);
    expect((await tool('play_exercise')).status).toBe(409);
    expect((await tool('resume_session')).status).toBe(200);
    const replayed = await tool('replay_exercise');
    expect(replayed.body.audio).toEqual(first.audio);
    expect(replayed.body.snapshot.current.hintCount).toBe(0);
    expect(replayed.body.snapshot.totalAnswers).toBe(0);
  });

  it('replays the previous exercise without overwriting the current one', async () => {
    const first = await start();
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    await tool('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
    const second = await tool('play_exercise');
    const replayed = await tool('replay_exercise', { target: 'previous' });
    expect(replayed.body.audio).toEqual(first.audio);
    expect(replayed.body.snapshot.current.id).toBe(second.body.snapshot.current.id);
  });

  it('asks for missing inversion information without revealing or scoring', async () => {
    const first = await start('triad-inversions');
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    const result = await tool('submit_answer', {
      exerciseId: exercise.id,
      answer: { quality: exercise.expected.quality },
    });
    expect(result.body.grade.verdict).toBe('incomplete');
    expect(result.body.grade.expectedLabel).toBe('');
    expect(result.body.snapshot.totalAnswers).toBe(0);
    expect(result.body.snapshot.current).not.toHaveProperty('reveal');
  });

  it('records hints as assisted evidence and skips without an accuracy penalty', async () => {
    const first = await start();
    const id = first.snapshot.current!.id;
    await tool('give_hint', { exerciseId: id });
    const exercise = (await store.exercises.get(id))!;
    const result = await tool('submit_answer', { exerciseId: id, answer: exercise.expected });
    const progress = result.body.snapshot.progress.find(
      (item: { skillId: string }) => item.skillId === 'triads',
    );
    expect(progress.unassistedCorrect).toBe(0);
    expect(progress.attempts).toBe(1);
    const next = await tool('play_exercise');
    await tool('skip_exercise', { exerciseId: next.body.snapshot.current.id });
    expect((await store.attempts.totals()).answers).toBe(1);
    expect(
      (await store.progress.getAll()).find((item) => item.skillId === 'triads')?.attempts,
    ).toBe(1);
  });

  it('counts acknowledged audio once, not merely generating a question', async () => {
    const result = await start();
    expect(result.snapshot.session?.listened).toBe(0);
    const body = { id: randomUUID(), sessionId, exerciseId: result.snapshot.current!.id };
    await request(app).post('/api/playback').set('x-earrr-client', '1').send(body).expect(204);
    await request(app).post('/api/playback').set('x-earrr-client', '1').send(body).expect(204);
    expect((await store.sessions.active())?.listened).toBe(1);
  });

  it('ends a session durably and will not score into it afterward', async () => {
    const first = await start();
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    await tool('end_session');
    expect(await store.sessions.active()).toBeNull();
    expect((await store.sessions.get(sessionId))?.endedAt).not.toBeNull();
    expect(
      (await tool('submit_answer', { exerciseId: exercise.id, answer: exercise.expected })).status,
    ).toBe(409);
  });

  it('blocks foreign origins, nonlocal hosts, and unmarked mutations', async () => {
    await request(app).get('/api/state').set('host', 'evil.example').expect(403);
    await request(app).get('/api/state').set('origin', 'https://evil.example').expect(403);
    await request(app).post('/api/tools').send({}).expect(403);
    await request(app)
      .post('/api/tools')
      .set('x-earrr-client', '1')
      .send({ name: 'invent_reward' })
      .expect(400);
  });
});

describe('honestly labeled solo mode', () => {
  it('parses conventional major and minor chord notation', async () => {
    const result = await start('triad-inversions');
    const current = publicExercise((await store.exercises.get(result.snapshot.current!.id))!);
    expect(parseSoloAnswer('C minor, first inversion', current)).toEqual({
      root: 'C',
      quality: 'minor',
      inversion: 1,
    });
    expect(parseSoloAnswer('Cm', current)).toEqual({ root: 'C', quality: 'minor' });
    expect(parseSoloAnswer('CM', current)).toEqual({ root: 'C', quality: 'major' });
    expect(parseSoloAnswer('cm', current)).toEqual({ root: 'C', quality: 'minor' });
    expect(parseSoloAnswer('c7b5', current)).toEqual({ root: 'C', quality: '7b5' });
    expect(parseSoloAnswer('cadd9', current)).toEqual({ root: 'C', quality: 'add9' });
    expect(parseSoloAnswer('add9', current)).toEqual({ quality: 'add9' });
    expect(parseSoloAnswer('CM/E', current)).toEqual({ root: 'C', quality: 'major', inversion: 1 });
    expect(parseSoloAnswer('CM7', current)).toEqual({ root: 'C', quality: 'major7' });
  });
  it('does not silently replace natural language AI with a regex coach', async () => {
    const result = await start();
    const response = await request(app).post('/api/solo/answer').set('x-earrr-client', '1').send({
      sessionId,
      exerciseId: result.snapshot.current!.id,
      text: 'I wonder if this is the same as the previous one',
      callId: randomUUID(),
    });
    expect(response.status).toBe(422);
    expect((await store.attempts.totals()).answers).toBe(0);
  });
});

describe('server-only realtime negotiation', () => {
  it('validates and rate-limits connections through the same session service', async () => {
    let requests = 0;
    const fetcher: typeof fetch = async (input) => {
      requests++;
      return String(input).endsWith('client_secrets')
        ? Response.json({ value: 'ephemeral-test-token' })
        : new Response('v=0\r\ns=session-test\r\n', { status: 201 });
    };
    app = (await createApp(config, store, fetcher)).app;
    const connect = () =>
      request(app)
        .post('/api/realtime/connect')
        .set('x-earrr-client', '1')
        .send({ sessionId, sdp: `v=0\r\ns=${'offer'.repeat(30)}` });
    await start('triads', 'coach');
    await tool('pause_session');
    expect((await connect()).body.error.code).toBe('session_not_ready');
    expect(requests).toBe(0);
    await tool('resume_session');
    for (let attempt = 0; attempt < 8; attempt++) await connect().expect(200);
    const limited = await connect().expect(429);
    expect(limited.body.error.code).toBe('reconnect_rate_limited');
    expect(requests).toBe(16);
  });

  it('keeps permanent and ephemeral credentials out of the browser response', async () => {
    const upstream: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      upstream.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('client_secrets')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          session: {
            output_modalities: ['audio'],
            audio: {
              input: { turn_detection: { create_response: false, interrupt_response: true } },
            },
          },
        });
      }
      return url.endsWith('client_secrets')
        ? Response.json({ value: 'ephemeral-secret-for-unit-test' })
        : new Response('v=0\r\ns=unit-test-answer\r\n', { status: 201 });
    };
    app = (await createApp(config, store, fetcher)).app;
    await start('triads', 'coach');
    const response = await request(app)
      .post('/api/realtime/connect')
      .set('x-earrr-client', '1')
      .send({ sessionId, sdp: `v=0\r\ns=${'offer'.repeat(30)}` });
    expect(response.status).toBe(200);
    expect(response.body.answer).toContain('v=0');
    expect(JSON.stringify(response.body)).not.toMatch(/secret|credential/);
    expect(upstream[0]?.headers.get('api-key')).toBe(config.apiKey);
    expect(upstream[1]?.headers.get('authorization')).toBe('Bearer ephemeral-secret-for-unit-test');
  });

  it('reports provider rejection explicitly and preserves the exercise', async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ error: { message: 'unauthorized' } }, { status: 401 });
    app = (await createApp(config, store, fetcher)).app;
    const first = await start('triads', 'coach');
    const response = await request(app)
      .post('/api/realtime/connect')
      .set('x-earrr-client', '1')
      .send({ sessionId, sdp: `v=0\r\ns=${'offer'.repeat(30)}` });
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('azure_401');
    expect((await store.sessions.active())?.currentExerciseId).toBe(first.snapshot.current!.id);
  });
});

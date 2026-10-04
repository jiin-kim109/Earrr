import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { Store } from '../server/db/database.js';
import type { AgentService } from '../server/services/agent/agent.service.js';
import type { ToolName } from '../server/types/agent.types.js';
import { createExercise } from '../server/services/exercise/generator.js';
import {
  essentialIntervals,
  intervalLessons,
  skills,
} from '../server/services/exercise/catalog.js';
import { teachingSteps } from '../server/services/exercise/lessons.js';
import { intervalNames } from '../server/services/exercise/music.js';
import { defaultSettings } from '../server/repositories/user.repository.js';

let store: Store;
let game: AgentService;
let app: Awaited<ReturnType<typeof createApp>>['app'];
let sessionId: string;

beforeEach(async () => {
  store = await Store.open(':memory:');
  ({ app, game } = await createApp(
    {
      port: 3101,
      databasePath: ':memory:',
      configured: false,
      azureEndpoint: '',
      apiKey: '',
      deployment: 'test',
      transcriptionDeployment: '',
    },
    store,
  ));
  await store.progress.completeLesson('pitch-direction', new Date().toISOString());
  await store.progress.finishIntroduction('intervals-foundation', 'skipped');
  sessionId = '';
  sessionId = (await call('start_session', { mode: 'coach', focus: 'intervals-foundation' }))
    .snapshot.session!.id;
});
afterEach(async () => await store.close());

async function call(name: ToolName, args: Record<string, unknown> = {}, agent = true) {
  return await game.execute(
    { callId: randomUUID(), sessionId: sessionId || undefined, name, arguments: args },
    agent,
  );
}

describe('two direct interval practice stages', () => {
  it('puts rising/falling practice directly after pitch direction, then simultaneous practice', async () => {
    expect(skills.slice(0, 4).map((skill) => skill.id)).toEqual([
      'pitch-direction',
      'intervals-foundation',
      'intervals-harmonic',
      'triads',
    ]);
    expect(skills).toHaveLength(29);
    expect(
      (await game.snapshot()).course.lessons.slice(0, 4).map((lesson) => lesson.unlocked),
    ).toEqual([true, true, false, false]);
  });

  it.each(['intervals-foundation', 'intervals-harmonic'] as const)(
    '%s randomizes all five intervals, roots, and registers while keeping its playback mode',
    (skillId) => {
      const modes = new Set<string>();
      const distances = new Set<number>();
      const roots = new Set<number>();
      const registers = new Set<number>();
      for (let seed = 0; seed < 400; seed++) {
        const exercise = createExercise({
          id: randomUUID(),
          seed,
          skillId,
          settings: defaultSettings,
          now: new Date().toISOString(),
        });
        expect(exercise.audio.events).toHaveLength(2);
        expect(exercise.audio.events.every((note) => note.role === 'exercise')).toBe(true);
        expect(exercise).not.toHaveProperty('reference');
        expect(exercise).not.toHaveProperty('listening');
        const [first, second] = exercise.audio.events;
        modes.add(
          first!.at === second!.at
            ? 'together'
            : first!.midi < second!.midi
              ? 'ascending'
              : 'descending',
        );
        distances.add(Math.abs(first!.midi - second!.midi));
        roots.add(exercise.root);
        registers.add(exercise.register);
      }
      expect(modes).toEqual(new Set(intervalLessons[skillId].presentations));
      expect(distances).toEqual(new Set(essentialIntervals));
      expect(roots.size).toBe(12);
      expect(registers.size).toBe(2);
    },
  );

  it('keeps labeled teaching for all five intervals, separate from direct practice', () => {
    for (const skillId of ['intervals-foundation', 'intervals-harmonic'] as const) {
      const steps = teachingSteps(skillId, 'piano');
      for (const distance of essentialIntervals) {
        const demo = steps.find((step) => step.demoLabel === intervalNames[distance])!;
        expect(demo).toBeDefined();
        const events = demo.audio!.events;
        if (skillId === 'intervals-harmonic') {
          expect(events.map((note) => note.midi)).toEqual([60, 60 + distance]);
          expect(events[0]?.at).toBe(events[1]?.at);
        } else {
          expect(events.map((note) => note.midi)).toEqual([60, 60 + distance, 60 + distance, 60]);
          expect(new Set(events.map((note) => note.at)).size).toBe(4);
        }
      }
    }
  });

  it('returns one question, grades it directly, and prepares one next question', async () => {
    const played = await call('play_exercise');
    expect(played.audio?.events).toHaveLength(2);
    expect(played.agent.presentation?.context.parts.map((part) => part.kind)).toEqual([
      'instruction',
    ]);
    expect(played).not.toHaveProperty('reference');
    expect(played).not.toHaveProperty('playback');
    const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
    const result = await call('submit_answer', {
      exerciseId: exercise.id,
      answer: exercise.expected,
    });
    expect(result.grade?.verdict).toBe('correct');
    expect(result.snapshot.totalAnswers).toBe(1);
    expect(result.snapshot.current?.id).not.toBe(exercise.id);
    expect(result.audio?.events).toHaveLength(2);
    expect(result.agent.presentation?.context.parts.map((part) => part.kind)).toEqual([
      'feedback',
      'next_question',
    ]);
  });

  it('replays the same two notes silently, including after pause/resume', async () => {
    const played = await call('play_exercise');
    const replay = await call('replay_exercise');
    expect(replay.reply).toBe('none');
    expect(replay.audio).toEqual(played.audio);
    expect(replay.snapshot.current?.id).toBe(played.snapshot.current?.id);
    expect(replay.snapshot.totalAnswers).toBe(0);
    await call('pause_session');
    const resumed = await call('resume_session');
    expect(resumed.reply).toBe('none');
    expect(resumed.audio).toEqual(played.audio);
  });

  it('rejects removed comparison inputs and no longer has a per-question delivery endpoint', async () => {
    await expect(call('select_lesson', { skillId: 'intervals-comparison' })).rejects.toThrow();
    await expect(call('replay_exercise', { target: 'reference' })).rejects.toThrow();
    await request(app)
      .post('/api/exercises/delivered')
      .set('x-earrr-client', '1')
      .send({})
      .expect(404);
  });

  it('serves catalog metadata without audio and fetches labeled examples separately', async () => {
    const curriculum = await request(app).get('/api/curriculum').expect(200);
    expect(curriculum.body.lessons).toHaveLength(29);
    expect(curriculum.body.lessons[1]).toMatchObject({
      id: 'intervals-foundation',
      checkpoint: { questions: 10, correct: 8 },
    });
    expect(JSON.stringify(curriculum.body)).not.toContain('"events"');
    const examples = await request(app)
      .get('/api/lessons/intervals-harmonic/examples?instrument=guitar')
      .expect(200);
    expect(examples.body.some((item: { label: string }) => item.label === 'perfect fifth')).toBe(
      true,
    );
    expect(
      examples.body.every(
        (item: { audio: { instrument: string } }) => item.audio.instrument === 'guitar',
      ),
    ).toBe(true);
    await request(app).get('/api/lessons/intervals-comparison/examples').expect(400);
    expect((await game.snapshot()).totalAnswers).toBe(0);
  });
});

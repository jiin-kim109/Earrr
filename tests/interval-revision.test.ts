import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { exportLearning, importLearning } from '../server/services/storage/archive.js';
import { newTeachingProgress } from '../server/services/exercise/exercise.service.js';
import type { Exercise } from '../server/types/exercise.types.js';

type IntervalLesson = 'intervals-foundation' | 'intervals-harmonic';

async function makeLegacyFourth(store: Store, exercise: Exercise, sessionId: string) {
  const [first, second] = exercise.audio.events;
  if (!first || !second) throw new Error('The interval fixture needs two notes.');
  const lower = Math.min(first.midi, second.midi);
  const pitches = first.midi > second.midi ? [lower + 5, lower] : [lower, lower + 5];
  const legacy: Exercise = {
    ...exercise,
    expected: { interval: 5 },
    label: 'perfect fourth',
    explanation: 'A perfect fourth spans five semitones.',
    audio: {
      ...exercise.audio,
      events: exercise.audio.events.map((event, index) => ({ ...event, midi: pitches[index]! })),
    },
  };
  await store.exercises.save(legacy, sessionId);
  const round = (await store.progress.round(exercise.skillId))!;
  const target = round.remaining.find((item) => item.id === exercise.roundTargetId)!;
  target.target.interval = 5;
  await store.progress.saveRound(round);
  return legacy;
}

async function checkRestoredRound(source: Store, restored: Store, skillId: IntervalLesson) {
  await source.progress.completeLesson('pitch-direction', '2026-10-01T00:00:00.000Z');
  const oldGame = await AgentService.create(source, true, 'test');
  const sessionId = (
    await oldGame.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'solo', focus: skillId },
    })
  ).snapshot.session!.id;
  const played = await oldGame.execute({
    callId: randomUUID(),
    sessionId,
    name: 'play_exercise',
    arguments: {},
  });
  const first = await makeLegacyFourth(
    source,
    (await source.exercises.get(played.snapshot.current!.id))!,
    sessionId,
  );
  const gradeCallId = randomUUID();
  const input = {
    callId: gradeCallId,
    sessionId,
    name: 'submit_answer' as const,
    arguments: { exerciseId: first.id, answer: { interval: 5 } },
  };
  const graded = await oldGame.execute(input, true);
  const pending = await makeLegacyFourth(
    source,
    (await source.exercises.get(graded.snapshot.current!.id))!,
    sessionId,
  );
  const round = (await source.progress.round(skillId))!;
  round.remaining.find((item) => item.id !== pending.roundTargetId)!.target.interval = 5;
  await source.progress.saveRound(round);
  const cached = (await source.agent.getCall(gradeCallId))!;
  await source.db
    .prepare('UPDATE tool_calls SET data=? WHERE id=?')
    .run(JSON.stringify({ ...cached.payload, audio: pending.audio }), gradeCallId);
  const active = (await source.sessions.active())!;
  await source.sessions.save({
    ...active,
    playedTutorialSteps: ['major-third', 'perfect-fourth'],
  });
  await source.sessions.saveLessonPosition(skillId, 'coach', {
    phase: 'practice',
    teaching: null,
    currentExerciseId: pending.id,
    previousExerciseId: first.id,
    playedTutorialSteps: ['major-third', 'perfect-fourth'],
  });
  await source.db.prepare('UPDATE course SET revision=2').run();
  const attempts = await source.attempts.recent();
  await importLearning(restored, await exportLearning(source));
  const originalRound = await restored.progress.round(skillId);
  const failingSave = vi
    .spyOn(restored.exercises, 'save')
    .mockRejectedValueOnce(new Error('Interval replacement could not be saved.'));
  await expect(AgentService.create(restored, true, 'test')).rejects.toThrow(
    'Interval replacement could not be saved.',
  );
  failingSave.mockRestore();
  expect(
    (await restored.db.prepare('SELECT revision FROM course WHERE id=1').get())?.revision,
  ).toBe(2);
  expect(await restored.progress.round(skillId)).toEqual(originalRound);
  expect((await restored.sessions.active())!.currentExerciseId).toBe(pending.id);
  const game = await AgentService.create(restored, true, 'test');
  const state = await game.snapshot();
  const replacement = (await restored.exercises.get(state.current!.id))!;
  expect(replacement.id).not.toBe(pending.id);
  expect([3, 4, 7, 12]).toContain(replacement.expected.interval);
  expect(Math.abs(replacement.audio.events[0]!.midi - replacement.audio.events[1]!.midi)).toBe(
    replacement.expected.interval,
  );
  expect(state.totalAnswers).toBe(1);
  expect(state.course.completedLessons).toBe(1);
  expect(await restored.attempts.recent()).toEqual(attempts);
  expect((await restored.progress.round(skillId))!.answers).toEqual(round.answers);
  expect((await restored.progress.round(skillId))!.remaining).toHaveLength(9);
  expect(
    (await restored.progress.round(skillId))!.remaining.some((item) => item.target.interval === 5),
  ).toBe(false);
  expect((await restored.sessions.lessonPosition(skillId, 'coach'))!.currentExerciseId).toBe(
    replacement.id,
  );
  expect((await restored.sessions.lessonPosition(skillId, 'coach'))!.previousExerciseId).toBe(
    first.id,
  );
  expect((await restored.sessions.lessonPosition(skillId, 'coach'))!.playedTutorialSteps).toEqual([
    'major-third',
  ]);
  const retry = await game.execute(input, true);
  expect(retry.grade).toEqual(graded.grade);
  expect(retry.gradedExerciseId).toBe(first.id);
  expect(retry.playbackExerciseId).toBe(replacement.id);
  expect(retry.audio).toEqual(replacement.audio);
  expect(retry.snapshot.totalAnswers).toBe(1);
  expect(await restored.exercises.get(first.id)).toEqual(await source.exercises.get(first.id));
  expect((await game.exercises.reviewAnswer(attempts[0]!.id)).example?.semitones).toBe(5);
  const before = await game.snapshot();
  await game.restoreCheckpoint();
  expect(await game.snapshot()).toEqual(before);
  const result = await game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'submit_answer',
    arguments: { exerciseId: replacement.id, answer: replacement.expected },
  });
  expect(result.grade?.verdict).toBe('correct');
  expect(result.snapshot.totalAnswers).toBe(2);
  expect(result.snapshot.course.round.answers).toHaveLength(2);
}

describe('four-interval curriculum restoration', () => {
  it.each(['intervals-foundation', 'intervals-harmonic'] as const)(
    'replaces unasked %s fourths while retaining grades, rounds, parked questions and cached retries',
    async (skillId) => {
      const source = await Store.open(':memory:');
      const restored = await Store.open(':memory:');
      try {
        await checkRestoredRound(source, restored, skillId);
      } finally {
        await source.close();
        await restored.close();
      }
    },
  );

  it.each(['intervals-foundation', 'intervals-harmonic'] as const)(
    'moves the removed %s tutorial step to the fifth and rejects its obsolete delivery receipt',
    async (skillId) => {
      const store = await Store.open(':memory:');
      try {
        let game = await AgentService.create(store, true, 'test');
        const session = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'coach', focus: skillId },
          })
        ).snapshot.session!;
        const teaching = {
          ...newTeachingProgress(skillId),
          index: 3,
          stepId: 'perfect-fourth',
          delivered: true,
          lastDemoIndex: 3,
          lastDemoStepId: 'perfect-fourth',
        };
        const overviewCallId = randomUUID();
        await game.execute({
          callId: overviewCallId,
          sessionId: session.id,
          name: 'play_exercise',
          arguments: {},
        });
        await store.sessions.save({
          ...session,
          teaching,
          playedTutorialSteps: ['perfect-fourth'],
        });
        await store.sessions.saveLessonPosition(skillId, 'coach', {
          phase: 'teaching',
          teaching,
          currentExerciseId: null,
          previousExerciseId: null,
          playedTutorialSteps: ['perfect-fourth'],
        });
        await store.db.prepare('UPDATE course SET revision=2').run();
        game = await AgentService.create(store, true, 'test');
        const state = await game.snapshot();
        expect(state.teaching?.stepId).toBe('perfect-fifth');
        expect(state.teaching?.index).toBe(3);
        expect(state.teaching?.total).toBe(6);
        expect(state.teaching?.delivered).toBe(false);
        expect(state.teaching?.presentationId).not.toBe(teaching.presentationId);
        expect(await game.exercises.teachingDelivered(session.id, teaching.presentationId)).toBe(
          false,
        );
        expect((await store.sessions.lessonPosition(skillId, 'coach'))!.teaching?.stepId).toBe(
          'perfect-fifth',
        );
        expect(state.course.completedLessons).toBe(0);
        expect(state.totalAnswers).toBe(0);
        expect(await store.agent.getCall(overviewCallId)).toBeNull();
      } finally {
        await store.close();
      }
    },
  );
});

it.skipIf(!process.env.EARRR_TEST_POSTGRES_URL)(
  'restores the reduced interval course through the same PostgreSQL storage boundary',
  async () => {
    const connection = new URL(process.env.EARRR_TEST_POSTGRES_URL!);
    if (connection.hostname !== '127.0.0.1' || process.env.EARRR_TEST_POSTGRES_ISOLATED !== '1')
      throw new Error('The interval revision check requires isolated local PostgreSQL.');
    const pool = new Pool({ connectionString: connection.href });
    const schema = `earrr_interval_${randomUUID().replaceAll('-', '')}`;
    let restored: Store | undefined;
    const source = await Store.open(':memory:');
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      restored = await Store.open(connection.href);
      await checkRestoredRound(source, restored, 'intervals-foundation');
    } finally {
      await restored?.close();
      await source.close();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  },
);

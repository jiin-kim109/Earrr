import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { restoreCourseRevision } from '../server/services/exercise/course-revision.js';
import { newTeachingProgress } from '../server/services/exercise/exercise.service.js';
import { exportLearning } from '../server/services/storage/archive.js';
import { createExercise } from '../server/services/exercise/generator.js';

describe('curriculum layout revision', () => {
  it.each([
    ['scale-degrees', 'scales'],
    ['chord-roots', 'triad-inversions'],
  ] as const)(
    'redirects a saved %s tutorial to %s without rewriting earned history',
    async (retired, destination) => {
      const store = await Store.open(':memory:');
      try {
        const game = await AgentService.create(store, true, 'test');
        const sessionId = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'coach' },
          })
        ).snapshot.session!.id;
        const first = await game.execute({
          callId: randomUUID(),
          sessionId,
          name: 'play_exercise',
          arguments: {},
        });
        const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
        await game.execute({
          callId: randomUUID(),
          sessionId,
          name: 'submit_answer',
          arguments: { exerciseId: exercise.id, answer: exercise.expected },
        });
        await store.progress.completeLesson(retired, new Date().toISOString());
        await store.progress.completeLesson('triads', new Date().toISOString());
        await store.db.prepare('UPDATE course SET skill_id=?,revision=3 WHERE id=1').run(retired);
        await store.sessions.save({
          ...(await store.sessions.get(sessionId))!,
          focus: retired,
          phase: 'teaching',
          teaching: newTeachingProgress(retired),
          currentExerciseId: null,
        });
        const oldExercise = createExercise({
          id: randomUUID(),
          skillId: retired,
          seed: 2,
          settings: await store.user.getSettings(),
          now: new Date().toISOString(),
        });
        await store.exercises.save(oldExercise, sessionId);
        const cachedId = randomUUID();
        await store.agent.saveCall(cachedId, 'kept-idempotency-hash', {
          ok: true,
          reply: 'none',
          message: 'Old replay.',
          audio: oldExercise.audio,
          playbackExerciseId: oldExercise.id,
        });
        const attempts = await store.attempts.recent();
        const completions = await store.db
          .prepare('SELECT * FROM lesson_completions ORDER BY skill_id')
          .all();
        const restored = await AgentService.create(store, true, 'test');
        const snapshot = await restored.snapshot();
        expect(snapshot.course.selectedLesson).toBe(destination);
        expect(snapshot.teaching?.lessonId).toBe(destination);
        expect(snapshot.teaching?.stepId).toBe('overview');
        expect(snapshot.totalAnswers).toBe(1);
        expect(snapshot.course.completedLessons).toBe(1);
        expect(await store.attempts.recent()).toEqual(attempts);
        const cached = await store.agent.getCall(cachedId);
        expect(cached?.hash).toBe('kept-idempotency-hash');
        expect(cached?.payload).not.toHaveProperty('audio');
        expect((await store.exercises.get(oldExercise.id))?.audio).toEqual(oldExercise.audio);
        expect(
          await store.db.prepare('SELECT * FROM lesson_completions ORDER BY skill_id').all(),
        ).toEqual(completions);
        const before = await exportLearning(store);
        await restoreCourseRevision(store);
        expect(await exportLearning(store)).toEqual(before);
      } finally {
        await store.close();
      }
    },
  );

  it('keeps in-progress rounds and a saved final progression invitation while new examples are inserted', async () => {
    const store = await Store.open(':memory:');
    try {
      const game = await AgentService.create(store, true, 'test');
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach', focus: 'progressions' },
        })
      ).snapshot.session!.id;
      const question = await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'start_practice',
        arguments: {},
      });
      await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'teach_lesson',
        arguments: { stepId: 'ready-for-practice' },
      });
      const session = (await store.sessions.get(sessionId))!;
      await store.sessions.save({ ...session, teaching: { ...session.teaching!, index: 3 } });
      await store.db.exec('UPDATE course SET revision=3');
      const round = await store.progress.round('progressions');
      const restored = await AgentService.create(store, true, 'test');
      const snapshot = await restored.snapshot();
      expect(snapshot.teaching).toMatchObject({
        stepId: 'ready-for-practice',
        index: 5,
        awaitingPractice: true,
      });
      expect(snapshot.current?.id).toBe(question.snapshot.current!.id);
      expect(await store.progress.round('progressions')).toEqual(round);
    } finally {
      await store.close();
    }
  });

  it('rolls back a failed layout migration rather than leaving a partly redirected save', async () => {
    const store = await Store.open(':memory:');
    try {
      const game = await AgentService.create(store, true, 'test');
      const session = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach' },
        })
      ).snapshot.session!;
      await store.db.exec("UPDATE course SET revision=3,skill_id='scale-degrees'");
      await store.sessions.save({
        ...session,
        focus: 'scale-degrees',
        phase: 'teaching',
        teaching: newTeachingProgress('scale-degrees'),
      });
      const before = await exportLearning(store);
      const save = vi
        .spyOn(store.sessions, 'save')
        .mockRejectedValueOnce(new Error('Fixture persistence failure.'));
      await expect(restoreCourseRevision(store)).rejects.toThrow('Fixture persistence failure.');
      save.mockRestore();
      expect(await exportLearning(store)).toEqual(before);
      await restoreCourseRevision(store);
      expect((await store.db.prepare('SELECT revision FROM course').get())?.revision).toBe(4);
    } finally {
      await store.close();
    }
  });
});

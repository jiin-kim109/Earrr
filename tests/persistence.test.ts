import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentService as Game } from '../server/services/agent/agent.service.js';
import { Store } from '../server/db/database.js';
import type { ToolName } from '../server/types/agent.types.js';
import type { Transcript } from '../shared/types/user.js';
import { exportLearning } from '../server/services/storage/archive.js';

describe('durable progress and atomic answers', () => {
  it.each([3, 4])(
    'migrates old pitch-direction tutorial step %i without changing practice records',
    async (index) => {
      mkdirSync(resolve('test-results'), { recursive: true });
      const directory = mkdtempSync(resolve('test-results', 'direction-tutorial-'));
      const path = join(directory, 'practice.sqlite');
      let store = await Store.open(path);
      try {
        const game = await Game.create(store, true, 'test');
        const sessionId = (
          await game.execute({
            callId: randomUUID(),
            name: 'start_session',
            arguments: { mode: 'coach' },
          })
        ).snapshot.session!.id;
        const call = async (name: ToolName, args: Record<string, unknown> = {}) =>
          await game.execute({ callId: randomUUID(), sessionId, name, arguments: args });
        const first = await call('start_practice');
        const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
        await call('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
        const pending = await call('play_exercise');
        const introduction = await call('teach_lesson', { restart: true });
        const presentationId = introduction.teaching!.presentationId;
        const session = (await store.sessions.get(sessionId))!;
        await store.sessions.save({
          ...session,
          status: 'paused',
          teaching: {
            ...session.teaching!,
            index,
            lastDemoIndex: 3,
            delivered: true,
            autoContinue: true,
          },
        });
        const attempts = await store.attempts.recent();
        const completions = await store.db
          .prepare('SELECT * FROM lesson_completions ORDER BY skill_id')
          .all();
        await store.db.exec('PRAGMA user_version = 6');
        await store.close();
        store = await Store.open(path);
        const restored = await Game.create(store, true, 'test');
        const snapshot = await restored.snapshot();
        expect(snapshot.session).toMatchObject({
          id: sessionId,
          status: 'paused',
          phase: 'teaching',
        });
        expect(snapshot.teaching).toMatchObject({
          stepId: 'ready-for-practice',
          index: 3,
          awaitingPractice: true,
          delivered: false,
          autoContinue: false,
          lastDemoId: 'down',
        });
        expect(snapshot.teaching?.presentationId).not.toBe(presentationId);
        expect(await restored.exercises.teachingDelivered(sessionId, presentationId)).toBe(false);
        expect(snapshot.current?.id).toBe(pending.snapshot.current!.id);
        expect(await store.attempts.recent()).toEqual(attempts);
        expect((await store.exercises.get(exercise.id))?.audio).toEqual(exercise.audio);
        expect(
          await store.db.prepare('SELECT * FROM lesson_completions ORDER BY skill_id').all(),
        ).toEqual(completions);
        const updatedId = snapshot.teaching!.presentationId;
        await store.close();
        store = await Store.open(path);
        expect(
          (await (await Game.create(store, true, 'test')).snapshot()).teaching?.presentationId,
        ).toBe(updatedId);
      } finally {
        await store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('migrates a paused retired introduction and rejects completion of its old segment', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'retired-introduction-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      await store.progress.completeLesson('pitch-direction', new Date().toISOString());
      const game = await Game.create(store, true, 'test');
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach', focus: 'intervals-foundation' },
        })
      ).snapshot.session!.id;
      const presentationId = (await game.snapshot()).teaching!.presentationId;
      await game.execute({ callId: randomUUID(), sessionId, name: 'pause_session', arguments: {} });
      await store.db
        .prepare(
          `
        UPDATE sessions SET data = json_set(data, '$.focus', 'intervals-comparison',
          '$.teaching.lessonId', 'intervals-comparison') WHERE id = ?
      `,
        )
        .run(sessionId);
      await store.db.exec(
        "UPDATE course SET skill_id = 'intervals-comparison'; PRAGMA user_version = 3",
      );
      await store.close();
      store = await Store.open(path);
      const restored = await Game.create(store, true, 'test');
      expect((await restored.snapshot()).session).toMatchObject({
        id: sessionId,
        status: 'paused',
        focus: 'intervals-foundation',
        phase: 'teaching',
      });
      expect((await restored.snapshot()).teaching).toMatchObject({
        lessonId: 'intervals-foundation',
        stepId: 'overview',
      });
      expect((await restored.snapshot()).teaching?.presentationId).not.toBe(presentationId);
      expect(await restored.exercises.teachingDelivered(sessionId, presentationId)).toBe(false);
      expect((await restored.snapshot()).totalAnswers).toBe(0);
      expect((await store.conversations.latest(sessionId))?.state.teaching?.lessonId).toBe(
        'intervals-foundation',
      );
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retires comparison practice without losing its history or awarding melodic mastery', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'comparison-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      await store.progress.completeLesson('pitch-direction', new Date().toISOString());
      await store.progress.finishIntroduction('intervals-foundation', 'skipped');
      let game = await Game.create(store, true, 'test');
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach', focus: 'intervals-foundation' },
        })
      ).snapshot.session!.id;
      const call = async (name: ToolName, args: Record<string, unknown> = {}) =>
        await game.execute({ callId: randomUUID(), sessionId, name, arguments: args });
      const first = await call('play_exercise');
      const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
      await call('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
      const pending = await call('play_exercise');
      const before = await store.attempts.totals();
      const retired = 'intervals-comparison';
      await store.db
        .prepare(
          "UPDATE attempts SET skill_id = ?, data = json_set(data, '$.skillId', ?) WHERE session_id = ?",
        )
        .run(retired, retired, sessionId);
      await store.db
        .prepare("UPDATE exercises SET data = json_set(data, '$.skillId', ?) WHERE session_id = ?")
        .run(retired, sessionId);
      await store.db
        .prepare(
          "UPDATE progress SET skill_id = ?, data = json_set(data, '$.skillId', ?) WHERE skill_id = 'intervals-foundation'",
        )
        .run(retired, retired);
      await store.db
        .prepare("UPDATE sessions SET data = json_set(data, '$.focus', ?) WHERE id = ?")
        .run(retired, sessionId);
      await store.db
        .prepare("UPDATE settings SET data = json_set(data, '$.defaultFocus', ?) WHERE id = 1")
        .run(retired);
      await store.db.prepare('UPDATE course SET skill_id = ? WHERE id = 1').run(retired);
      await store.db
        .prepare('INSERT INTO lesson_completions(skill_id, completed_at) VALUES (?, ?)')
        .run(retired, new Date().toISOString());
      const cachedId = randomUUID();
      await store.db
        .prepare('INSERT INTO tool_calls(id, request_hash, created_at, data) VALUES (?, ?, ?, ?)')
        .run(
          cachedId,
          'obsolete',
          new Date().toISOString(),
          JSON.stringify({ ok: true, reply: 'reference', reference: { label: 'minor third' } }),
        );
      await store.db.exec('PRAGMA user_version = 3');
      await store.close();
      store = await Store.open(path);
      game = await Game.create(store, true, 'test');
      const restored = await game.snapshot();
      expect(restored.session).toMatchObject({
        id: sessionId,
        focus: 'intervals-foundation',
        phase: 'practice',
        currentExerciseId: null,
      });
      expect(restored.settings).not.toHaveProperty('defaultFocus');
      expect(restored.course.selectedLesson).toBe('intervals-foundation');
      expect(restored.course.completedLessons).toBe(1);
      expect(
        restored.course.lessons.find((lesson) => lesson.skillId === 'intervals-foundation'),
      ).toMatchObject({
        answered: 0,
        status: 'not_started',
        unlocked: true,
      });
      expect(await store.attempts.totals()).toEqual(before);
      expect(await store.agent.getCall(cachedId)).toBeNull();
      expect(
        (
          await store.db
            .prepare('SELECT skill_id FROM attempts WHERE exercise_id = ?')
            .get(exercise.id)
        )?.skill_id,
      ).toBe(retired);
      expect(await store.exercises.get(pending.snapshot.current!.id)).not.toBeNull();
      expect((await store.conversations.latest(sessionId))?.state.session.focus).toBe(
        'intervals-foundation',
      );
      const checkpoint = restored.checkpoint;
      expect((await (await Game.create(store, true, 'test')).snapshot()).checkpoint).toBe(
        checkpoint,
      );
      const next = await call('play_exercise');
      expect(next.snapshot.current?.skillId).toBe('intervals-foundation');
      expect(next.audio?.events).toHaveLength(2);
      expect(next).not.toHaveProperty('reference');
      await expect(
        call('submit_answer', {
          exerciseId: pending.snapshot.current!.id,
          answer: { interval: 3 },
        }),
      ).rejects.toThrow('different exercise');
      expect(await store.attempts.totals()).toEqual(before);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds tutoring to a legacy paused session without replacing its unanswered exercise', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'tutoring-upgrade-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      const game = await Game.create(store, true, 'test');
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach' },
        })
      ).snapshot.session!.id;
      const played = await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'start_practice',
        arguments: {},
      });
      await game.execute({ callId: randomUUID(), sessionId, name: 'pause_session', arguments: {} });
      await store.db
        .prepare("UPDATE sessions SET data=json_remove(data, '$.phase', '$.teaching') WHERE id=?")
        .run(sessionId);
      await store.db.exec('DELETE FROM lesson_introductions; PRAGMA user_version = 2');
      await store.close();
      store = await Store.open(path);
      const resumed = await Game.create(store, true, 'test');
      const upgraded = await resumed.snapshot();
      expect(upgraded.session?.status).toBe('paused');
      expect(upgraded.session?.phase).toBe('teaching');
      expect(upgraded.teaching?.stepId).toBe('overview');
      expect(upgraded.current?.id).toBe(played.snapshot.current!.id);
      expect(upgraded.totalAnswers).toBe(0);
      await resumed.execute({
        callId: randomUUID(),
        sessionId,
        name: 'resume_session',
        arguments: {},
      });
      const demonstration = await resumed.execute({
        callId: randomUUID(),
        sessionId,
        name: 'teach_lesson',
        arguments: { stepId: 'up' },
      });
      const id = demonstration.teaching!.presentationId;
      await store.close();
      store = await Store.open(path);
      const restored = await (await Game.create(store, true, 'test')).snapshot();
      expect(restored.teaching?.presentationId).toBe(id);
      expect(restored.teaching?.stepId).toBe('up');
      expect(restored.current?.id).toBe(played.snapshot.current!.id);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists the exact graded feedback without a voice-delivery dependency', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'feedback-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      const game = await Game.create(store, true, 'test');
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach' },
        })
      ).snapshot.session!.id;
      const played = await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'start_practice',
        arguments: {},
      });
      const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
      const result = await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      });
      const feedback = result.snapshot.feedback!;
      expect(feedback.grade.verdict).toBe('correct');
      await store.close();
      store = await Store.open(path);
      expect(await (await Game.create(store, true, 'test')).latestFeedback(sessionId)).toEqual(
        feedback,
      );
      const checkpoint = await store.conversations.latest(sessionId);
      expect(checkpoint?.state.feedback).toEqual(feedback);
      expect(checkpoint?.state.current?.id).toBe(exercise.id);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades an old mixed-chapter session while preserving answers and canonical chat', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'migration-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      const game = await Game.create(store, false, 'test');
      const session = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!;
      const result = await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'play_exercise',
        arguments: {},
      });
      const exercise = (await store.exercises.get(result.snapshot.current!.id))!;
      await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      });
      const expected = await store.attempts.totals();
      await store.db
        .prepare(
          "UPDATE settings SET data = json_set(data, '$.instrument', 'felt', '$.defaultFocus', 'adaptive')",
        )
        .run();
      await store.sessions.save({ ...(await store.sessions.get(session.id))!, focus: 'adaptive' });
      const legacyMessage: Transcript = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'user',
        text: 'Again, please.',
        createdAt: new Date().toISOString(),
      };
      await store.conversations.saveMessage(legacyMessage);
      await store.db.exec('PRAGMA user_version = 1');
      await store.close();
      store = await Store.open(path);
      expect(await store.attempts.totals()).toEqual(expected);
      expect(
        await store.db.prepare("SELECT name FROM sqlite_master WHERE name='transcripts'").all(),
      ).toHaveLength(1);
      expect(await store.conversations.messages()).toEqual([legacyMessage]);
      expect((await store.sessions.get(session.id))?.status).toBe('ended');
      expect(await store.sessions.active()).toBeNull();
      expect((await store.user.getSettings()).instrument).toBe('piano');
      const course = (await (await Game.create(store, false, 'test')).snapshot()).course;
      expect(course.selectedLesson).toBe('pitch-direction');
      expect(course.lessons[0]?.answered).toBe(1);
      expect(await store.exercises.get(exercise.id)).not.toBeNull();
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reopens a schema-11 learning-only save with empty chat and preserves cached retries', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'chat-version-12-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      const game = await Game.create(store, false, 'test');
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!.id;
      const request = { callId: randomUUID(), sessionId, name: 'play_exercise', arguments: {} };
      const played = await game.execute(request);
      const archive = await exportLearning(store);
      const cached = await store.agent.getCall(request.callId);
      await store.db.exec('DROP TABLE transcripts; PRAGMA user_version = 11');
      await store.close();
      store = await Store.open(path);
      const restored = await Game.create(store, false, 'test');
      expect((await store.db.prepare('PRAGMA user_version').get())?.user_version).toBe(13);
      expect(await exportLearning(store)).toEqual(archive);
      expect(await store.agent.getCall(request.callId)).toEqual(cached);
      const retry = await restored.execute(request);
      expect(retry.snapshot.current).toEqual(played.snapshot.current);
      expect(retry.snapshot.transcript).toEqual([]);
      expect(await exportLearning(store)).toEqual(archive);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores the unanswered exercise, settings, and earned progress after a server restart', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'persistence-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      let game = await Game.create(store, false, 'test');
      const session = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo', focus: 'pitch-direction' },
        })
      ).snapshot.session!;
      const first = await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'play_exercise',
        arguments: {},
      });
      const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
      await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      });
      const pending = await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'play_exercise',
        arguments: {},
      });
      await store.user.saveSettings({ ...(await store.user.getSettings()), volume: 0.4 });
      const progress = (await game.snapshot()).progress;
      await store.close();

      store = await Store.open(path);
      game = await Game.create(store, false, 'test');
      const restored = await game.snapshot();
      expect(restored.current?.id).toBe(pending.snapshot.current!.id);
      expect(restored.current?.status).toBe('unanswered');
      expect(restored.totalAnswers).toBe(1);
      expect(restored.progress).toEqual(progress);
      expect(restored.settings.volume).toBe(0.4);
      const replay = await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'replay_exercise',
        arguments: {},
      });
      expect(replay.audio).toEqual(pending.audio);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back an interrupted write instead of awarding partial or duplicate progress', async () => {
    const store = await Store.open(':memory:');
    try {
      const game = await Game.create(store, false, 'test');
      const session = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo', focus: 'pitch-direction' },
        })
      ).snapshot.session!;
      const played = await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'play_exercise',
        arguments: {},
      });
      const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
      const call = {
        callId: randomUUID(),
        sessionId: session.id,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      };
      const save = vi.spyOn(store.progress, 'save').mockImplementationOnce(() => {
        throw new Error('Simulated interrupted write.');
      });
      await expect(game.execute(call)).rejects.toThrow('Simulated interrupted write.');
      expect(await store.attempts.get(exercise.id)).toBeNull();
      expect(await store.agent.getCall(call.callId)).toBeNull();
      expect((await game.snapshot()).current?.status).toBe('unanswered');
      expect((await game.snapshot()).totalAnswers).toBe(0);
      save.mockRestore();
      const recovered = await game.execute(call);
      expect(recovered.snapshot.totalAnswers).toBe(1);
      expect(
        recovered.snapshot.progress.find((item) => item.skillId === 'pitch-direction')?.correct,
      ).toBe(1);
    } finally {
      await store.close();
    }
  });
});

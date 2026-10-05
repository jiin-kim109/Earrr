import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { skills } from '../server/services/exercise/catalog.js';
import { roundPlan, roundRule } from '../server/services/exercise/rounds.js';
import { createExercise } from '../server/services/exercise/generator.js';
import { gradeAnswer } from '../server/services/grading.service.js';
import { defaultSettings } from '../server/repositories/user.repository.js';
import type { ToolName, ToolResult } from '../server/types/agent.types.js';

async function fixture(path = ':memory:') {
  const store = await Store.open(path);
  const game = await AgentService.create(store, false, 'test');
  const sessionId = (
    await game.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'solo' },
    })
  ).snapshot.session!.id;
  const call = async (
    name: ToolName,
    args: Record<string, unknown> = {},
    callId = randomUUID(),
    agent = false,
  ) => await game.execute({ callId, sessionId, name, arguments: args }, agent);
  const answer = async (correct: boolean) => {
    const played = await call('play_exercise');
    const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
    return await call('submit_answer', {
      exerciseId: exercise.id,
      answer: correct
        ? exercise.expected
        : { direction: exercise.expected.direction === 'up' ? 'down' : 'up' },
    });
  };
  return { store, game, call, answer, sessionId };
}

describe('planned ten-question rounds', () => {
  it.each([0, 1, 2])(
    'passes immediately after eight correct answers with %i preceding misses',
    async (misses) => {
      const { store, game, answer, call } = await fixture();
      try {
        for (let index = 0; index < misses; index++) await answer(false);
        let result: ToolResult | undefined;
        for (let index = 0; index < 8; index++) {
          result = await answer(true);
          if (index < 7) expect(result.roundResult).toBeUndefined();
        }
        expect(result!.roundResult).toMatchObject({
          passed: true,
          correct: 8,
          answered: 8 + misses,
          questions: 10,
        });
        expect(result!.roundResult!.answers).toHaveLength(8 + misses);
        expect(result!.snapshot.session?.answered).toBe(8 + misses);
        expect(result!.snapshot.session?.awaitingRoundChoice).toBe(true);
        expect((await call('play_exercise')).audio).toBeUndefined();
        expect((await game.snapshot()).totalAnswers).toBe(8 + misses);
        const question = (await game.snapshot()).current!.id;
        await call('pause_session');
        await call('resume_session');
        expect((await game.snapshot()).current!.id).toBe(question);
        expect((await call('play_exercise')).audio).toBeUndefined();
        const next = await call('start_round');
        expect(next.snapshot.current!.id).not.toBe(question);
        expect(next.snapshot.course.round.answers).toEqual([]);
      } finally {
        await store.close();
      }
    },
  );

  it('closes a legacy eight-correct saved round once and keeps the last grade visible on restore', async () => {
    const { store, game, answer, call } = await fixture();
    try {
      for (let index = 0; index < 7; index++) await answer(true);
      const before = (await store.progress.round('pitch-direction'))!;
      const completed = await answer(true);
      const session = completed.snapshot.session!;
      const exercise = (await store.exercises.get(completed.gradedExerciseId!))!;
      await store.progress.saveRound({
        ...before,
        answers: completed.roundResult!.answers,
        remaining: before.remaining.filter((item) => item.id !== exercise.roundTargetId),
        awaitingChoice: false,
      });
      await store.db
        .prepare('DELETE FROM lesson_completions WHERE skill_id=?')
        .run('pitch-direction');
      await store.sessions.save({ ...session, awaitingRoundChoice: false });
      const restored = await AgentService.create(store, false, 'test');
      const state = await restored.snapshot();
      expect(state.totalAnswers).toBe(8);
      expect(state.course.round.previous).toMatchObject({ passed: true, answered: 8, correct: 8 });
      expect(state.session?.awaitingRoundChoice).toBe(true);
      expect(state.current?.id).toBe(exercise.id);
      expect(state.course.lessons[1]?.unlocked).toBe(true);
      const repeated = await AgentService.create(store, false, 'test');
      expect((await repeated.snapshot()).course.round).toEqual(state.course.round);
      expect((await call('play_exercise')).audio).toBeUndefined();
      expect((await game.snapshot()).totalAnswers).toBe(8);
    } finally {
      await store.close();
    }
  });

  it('stops at the third miss and requires start_round after pause, navigation and restart', async () => {
    const { store, call, answer, sessionId } = await fixture();
    try {
      let result: ToolResult | undefined;
      for (const correct of [false, true, false, true, false]) result = await answer(correct);
      expect(result!.roundResult).toMatchObject({
        passed: false,
        correct: 2,
        answered: 5,
        questions: 10,
      });
      expect(result!.snapshot.course.round.answers).toEqual([]);
      expect(result!.snapshot.session?.awaitingRoundChoice).toBe(true);
      const stoppedId = result!.snapshot.current!.id;
      expect((await call('play_exercise')).audio).toBeUndefined();
      await call('pause_session');
      await call('resume_session');
      expect((await call('play_exercise')).audio).toBeUndefined();
      await store.progress.completeLesson('pitch-direction', new Date().toISOString());
      await call('select_lesson', { skillId: 'intervals-foundation' });
      await call('play_exercise');
      await call('select_lesson', { skillId: 'pitch-direction' });
      expect((await call('play_exercise')).audio).toBeUndefined();
      const restored = await AgentService.create(store, false, 'test');
      expect((await restored.snapshot()).session?.awaitingRoundChoice).toBe(true);
      const resumed = await restored.execute({
        callId: randomUUID(),
        sessionId,
        name: 'start_round',
        arguments: {},
      });
      expect(resumed.audio).toBeDefined();
      expect(resumed.snapshot.current!.id).not.toBe(stoppedId);
      expect(resumed.snapshot.course.round.answers).toEqual([]);
      await expect(call('start_round')).rejects.toThrow('still in progress');
    } finally {
      await store.close();
    }
  });

  it('restores the exact unanswered sound and assistance state after visiting another lesson', async () => {
    const { store, game, call, answer } = await fixture();
    try {
      await store.progress.completeLesson('pitch-direction', new Date().toISOString());
      await answer(true);
      const first = await call('play_exercise');
      const id = first.snapshot.current!.id;
      await call('give_hint', { exerciseId: id });
      const before = (await game.snapshot()).course.round;
      await call('select_lesson', { skillId: 'intervals-foundation' });
      await call('play_exercise');
      await call('select_lesson', { skillId: 'pitch-direction' });
      const returned = await call('play_exercise');
      expect(returned.snapshot.current).toMatchObject({ id, status: 'unanswered', hintCount: 1 });
      expect(returned.audio).toEqual(first.audio);
      expect(returned.snapshot.course.round).toEqual(before);
    } finally {
      await store.close();
    }
  });

  it('reviews only scored answers and replays any saved answer without changing the pending question', async () => {
    const { store, game, call, answer, sessionId } = await fixture();
    try {
      const graded = await answer(false);
      const feedback = graded.snapshot.feedback!;
      const saved = await game.exercises.reviewAnswer(feedback.attemptId!);
      expect(saved.exerciseId).toBe(feedback.exerciseId);
      expect(saved.example.midi.length).toBe(2);
      const next = await call('play_exercise');
      await expect(game.exercises.reviewAnswer(next.snapshot.current!.id)).rejects.toThrow(
        'saved answer',
      );
      await expect(
        call('replay_exercise', { exerciseId: next.snapshot.current!.id }),
      ).rejects.toThrow('saved answer');
      await call('pause_session');
      const before = await game.snapshot();
      const replay = await call('replay_exercise', { exerciseId: feedback.exerciseId });
      expect(replay.review?.example).toEqual(saved.example);
      expect(replay.snapshot.session?.id).toBe(sessionId);
      expect(replay.snapshot.current?.id).toBe(next.snapshot.current!.id);
      expect(replay.snapshot.course).toEqual(before.course);
      expect(replay.snapshot.totalAnswers).toBe(before.totalAnswers);
      expect(replay.snapshot.session?.status).toBe('paused');
    } finally {
      await store.close();
    }
  });

  it.each(skills.map((skill) => skill.id))(
    '%s has ten valid planned questions at the same pass threshold',
    (skillId) => {
      expect(roundRule).toEqual({ questions: 10, correct: 8 });
      for (let round = 1; round <= 4; round++) {
        const plan = roundPlan(skillId, round, 100 + round);
        expect(plan).toHaveLength(10);
        expect(plan).toEqual(roundPlan(skillId, round, 100 + round));
        for (const [seed, target] of plan.entries()) {
          const exercise = createExercise({
            id: randomUUID(),
            skillId,
            seed,
            target,
            settings: defaultSettings,
            now: new Date().toISOString(),
          });
          expect(gradeAnswer(exercise, exercise.expected).verdict).toBe('correct');
          if (target.quality) expect(exercise.expected.quality).toBe(target.quality);
          if (target.inversion !== undefined)
            expect(exercise.expected.inversion).toBe(target.inversion);
          if (target.interval) expect(exercise.expected.interval).toBe(target.interval);
          if (target.direction) expect(exercise.expected.direction).toBe(target.direction);
          if (target.scale) expect(exercise.expected.scale).toBe(target.scale);
          if (target.degree) expect(exercise.expected.degree).toBe(target.degree);
          if (target.length)
            expect((exercise.expected.melody ?? exercise.expected.progression)?.length).toBe(
              target.length,
            );
          for (const note of exercise.audio.events) {
            expect(note.midi).toBeGreaterThanOrEqual(36);
            expect(note.midi).toBeLessThanOrEqual(100);
          }
        }
      }
    },
  );

  it('keeps five up/five down while balancing ten questions across four essential intervals', () => {
    for (let seed = 0; seed < 30; seed++) {
      const directions = roundPlan('pitch-direction', 1, seed);
      expect(directions.filter((item) => item.direction === 'up')).toHaveLength(5);
      expect(directions.filter((item) => item.direction === 'down')).toHaveLength(5);
      const melodic = roundPlan('intervals-foundation', 1, seed);
      const harmonic = roundPlan('intervals-harmonic', 1, seed);
      expect(melodic.filter((item) => item.presentation === 'ascending')).toHaveLength(5);
      expect(melodic.filter((item) => item.presentation === 'descending')).toHaveLength(5);
      expect(melodic.some((item) => item.interval === 5)).toBe(false);
      expect(harmonic.some((item) => item.interval === 5)).toBe(false);
      for (const interval of [3, 4, 7, 12]) {
        expect(
          new Set(
            melodic.filter((item) => item.interval === interval).map((item) => item.presentation),
          ),
        ).toEqual(new Set(['ascending', 'descending']));
        for (const plan of [melodic, harmonic]) {
          const count = plan.filter((item) => item.interval === interval).length;
          expect(count).toBeGreaterThanOrEqual(2);
          expect(count).toBeLessThanOrEqual(3);
        }
      }
    }
    expect(
      new Set(
        Array.from({ length: 30 }, (_, seed) =>
          JSON.stringify(roundPlan('intervals-foundation', 1, seed)),
        ),
      ).size,
    ).toBeGreaterThan(20);
    for (const skill of ['intervals-foundation', 'intervals-harmonic'] as const) {
      const planned = Array.from({ length: 4 }, (_, index) =>
        roundPlan(skill, index + 1, index),
      ).flat();
      for (const interval of [3, 4, 7, 12]) {
        expect(planned.filter((item) => item.interval === interval)).toHaveLength(10);
        if (skill === 'intervals-foundation')
          for (const presentation of ['ascending', 'descending'])
            expect(
              planned.filter(
                (item) => item.interval === interval && item.presentation === presentation,
              ),
            ).toHaveLength(5);
      }
    }
    const chromatic = Array.from({ length: 6 }, (_, index) =>
      roundPlan('intervals-chromatic', index + 1, index),
    ).flat();
    expect(new Set(chromatic.map((item) => item.interval)).size).toBe(12);
  });

  it('waits for explicit consent after a failed round and never carries scores into a retry', async () => {
    const { store, game, answer, call } = await fixture();
    try {
      let result: ToolResult | undefined;
      for (let index = 0; index < 10; index++) {
        result = await answer(index < 7);
        if (index < 9) {
          expect(result.roundResult).toBeUndefined();
          expect(result.snapshot.course.round.answers).toHaveLength(index + 1);
          expect(result.snapshot.course.lessons[0]?.status).not.toBe('completed');
        }
      }
      expect(result!.roundResult).toMatchObject({
        number: 1,
        correct: 7,
        passed: false,
        requiredCorrect: 8,
        questions: 10,
      });
      expect(result!.snapshot.course.round).toMatchObject({ number: 2, correct: 0, answers: [] });
      expect(result!.snapshot.course.round.previous?.passed).toBe(false);
      expect((await call('play_exercise')).audio).toBeUndefined();
      await call('start_round');
      for (let index = 0; index < 8; index++) {
        result = await answer(true);
        if (index < 7) expect(result.lessonCompleted).toBe(false);
      }
      expect(result!.roundResult).toMatchObject({ number: 2, correct: 8, passed: true });
      expect(result!.snapshot.course.round).toMatchObject({ number: 3, correct: 0, answers: [] });
      expect(result!.snapshot.session?.awaitingRoundChoice).toBe(true);
      expect((await game.snapshot()).totalAnswers).toBe(18);
      expect((await game.snapshot()).course.lessons[1]?.unlocked).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('starts a new balanced review round after passing, while keeping prior completion', async () => {
    const { store, game, call, answer } = await fixture();
    try {
      for (let index = 0; index < 8; index++) await answer(true);
      const passedId = (await game.snapshot()).course.round.id;
      expect((await call('play_exercise')).audio).toBeUndefined();
      await call('start_round');
      let result: ToolResult | undefined;
      for (let index = 0; index < 3; index++) result = await answer(false);
      expect(result!.roundResult).toMatchObject({
        correct: 0,
        passed: false,
        number: 2,
        answered: 3,
      });
      expect(result!.snapshot.course.round.id).not.toBe(passedId);
      expect(result!.snapshot.course.round.answers).toEqual([]);
      expect(result!.snapshot.course.lessons[0]?.status).toBe('completed');
      expect(result!.snapshot.course.lessons[1]?.unlocked).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('keeps replays, skips, incomplete answers and duplicate submissions out of the count', async () => {
    const { store, game, call } = await fixture();
    try {
      let result = await call('play_exercise');
      for (let index = 0; index < 12; index++) {
        await call('replay_exercise');
        await call('skip_exercise', { exerciseId: result.snapshot.current!.id });
        result = await call('play_exercise');
      }
      expect((await game.snapshot()).course.round.answers).toEqual([]);
      expect((await game.snapshot()).totalAnswers).toBe(0);
      const exercise = (await store.exercises.get(result.snapshot.current!.id))!;
      expect(
        (await call('submit_answer', { exerciseId: exercise.id, answer: {} })).grade?.verdict,
      ).toBe('incomplete');
      expect((await game.snapshot()).course.round.answers).toEqual([]);
      const args = { exerciseId: exercise.id, answer: exercise.expected };
      const id = randomUUID();
      await call('submit_answer', args, id);
      await call('submit_answer', args, id);
      await call('submit_answer', args);
      expect((await game.snapshot()).course.round.answers).toHaveLength(1);
      expect((await game.snapshot()).totalAnswers).toBe(1);
      expect((await game.snapshot()).course.round).not.toHaveProperty('remaining');
      expect(JSON.stringify(result.agent.context)).not.toContain('roundTargetId');
    } finally {
      await store.close();
    }
  });

  it('rolls back round completion and reset when the enclosing checkpoint fails', async () => {
    const { store, game, call, answer } = await fixture();
    try {
      for (let index = 0; index < 7; index++) await answer(true);
      const question = await call('play_exercise');
      const exercise = (await store.exercises.get(question.snapshot.current!.id))!;
      const before = await store.progress.round('pitch-direction');
      const spy = vi.spyOn(game, 'recordEvent').mockImplementationOnce(() => {
        throw new Error('Checkpoint interrupted');
      });
      const args = { exerciseId: exercise.id, answer: exercise.expected };
      const id = randomUUID();
      await expect(call('submit_answer', args, id)).rejects.toThrow('Checkpoint interrupted');
      expect(await store.progress.round('pitch-direction')).toEqual(before);
      expect(await store.attempts.get(exercise.id)).toBeNull();
      expect((await game.snapshot()).course.lessons[0]?.status).not.toBe('completed');
      spy.mockRestore();
      const completed = await call('submit_answer', args, id);
      expect(completed.roundResult?.passed).toBe(true);
      expect(completed.snapshot.course.round.answers).toHaveLength(0);
      expect((await call('submit_answer', args, id)).snapshot.course.round.number).toBe(2);
    } finally {
      await store.close();
    }
  });

  it('restores the exact remaining order and unfinished round after restart', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'round-restart-'));
    const path = join(directory, 'practice.sqlite');
    const active = await fixture(path);
    let store = active.store;
    try {
      for (let index = 0; index < 4; index++) await active.answer(index < 3);
      const pending = await active.call('play_exercise');
      const before = await store.progress.round('pitch-direction');
      await store.close();
      store = await Store.open(path);
      const game = await AgentService.create(store, false, 'test');
      expect(await store.progress.round('pitch-direction')).toEqual(before);
      expect((await game.snapshot()).course.round.answers).toHaveLength(4);
      expect((await game.snapshot()).current?.id).toBe(pending.snapshot.current!.id);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts fixed rounds cleanly when upgrading a legacy rolling-window question', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'round-upgrade-'));
    const path = join(directory, 'practice.sqlite');
    const active = await fixture(path);
    let store = active.store;
    try {
      for (let index = 0; index < 3; index++) await active.answer(true);
      const pending = (await active.call('play_exercise')).snapshot.current!;
      const attempts = await store.attempts.recent();
      const progress = await store.progress.getAll();
      await store.db
        .prepare(
          "UPDATE exercises SET data=json_remove(data,'$.roundId','$.roundTargetId') WHERE id=?",
        )
        .run(pending.id);
      await store.db.exec('DELETE FROM practice_rounds; PRAGMA user_version = 7');
      await store.close();
      store = await Store.open(path);
      const game = await AgentService.create(store, false, 'test');
      expect((await store.db.prepare('PRAGMA user_version').get())?.user_version).toBe(13);
      expect((await game.snapshot()).current).toBeNull();
      expect((await game.snapshot()).course.round).toMatchObject({
        number: 1,
        correct: 0,
        answers: [],
      });
      expect(await store.attempts.recent()).toEqual(attempts);
      expect(await store.progress.getAll()).toEqual(progress);
      expect(await store.exercises.get(pending.id)).not.toBeNull();
      const played = await game.execute({
        callId: randomUUID(),
        sessionId: active.sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      expect(played.snapshot.current?.id).not.toBe(pending.id);
      expect((await store.exercises.get(played.snapshot.current!.id))?.roundId).toBe(
        (await game.snapshot()).course.round.id,
      );
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import type { ToolName } from '../server/types/agent.types.js';
import { skillIds } from '../shared/schemas/course.js';
import { teachingSteps } from '../server/services/exercise/lessons.js';

let store: Store;
let game: AgentService;
let sessionId: string | undefined;
beforeEach(async () => {
  store = await Store.open(':memory:');
  game = await AgentService.create(store, true, 'test');
  await store.progress.completeLesson('pitch-direction', new Date().toISOString());
  sessionId = (
    await game.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'coach', focus: 'intervals-foundation' },
    })
  ).snapshot.session!.id;
});
afterEach(() => store.close());
const call = (name: ToolName, args: Record<string, unknown> = {}, agent = false) =>
  game.execute({ callId: randomUUID(), sessionId, name, arguments: args }, agent);

async function answerOne() {
  const first = await call('start_practice');
  const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
  await call('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
  return call('play_exercise');
}

describe('one saved learning position per lesson and mode', () => {
  it('restores a reviewed tutorial step instead of silently reverting to practice', async () => {
    const pending = await answerOne();
    const demo = await call('teach_lesson', { stepId: 'minor-third' });
    const id = demo.teaching!.presentationId;
    await game.exercises.teachingDelivered(sessionId!, id);
    const round = (await game.snapshot()).course.round;
    await call('select_lesson', { skillId: 'pitch-direction' }, true);
    const returned = await call('select_lesson', { skillId: 'intervals-foundation' }, true);
    expect(returned.snapshot.session?.phase).toBe('teaching');
    expect(returned.teaching).toMatchObject({
      stepId: 'minor-third',
      index: demo.teaching!.index,
      autoContinue: true,
      delivered: false,
      example: demo.teaching!.example,
    });
    expect(returned.teaching!.presentationId).not.toBe(id);
    expect(await game.exercises.teachingDelivered(sessionId!, id)).toBe(false);
    expect(returned.snapshot.current?.id).toBe(pending.snapshot.current!.id);
    expect(returned.snapshot.course.round).toEqual(round);
    const resumed = await call('start_practice');
    expect(resumed.snapshot.current?.id).toBe(pending.snapshot.current!.id);
    expect(resumed.audio).toEqual(pending.audio);
    expect(resumed.snapshot.totalAnswers).toBe(1);
  });

  it('keeps a final readiness invitation unscored and waiting after navigation', async () => {
    await call('teach_lesson', { stepId: 'ready-for-practice' });
    await call('select_lesson', { skillId: 'pitch-direction' });
    const returned = await call('select_lesson', { skillId: 'intervals-foundation' }, true);
    expect(returned.teaching).toMatchObject({ awaitingPractice: true, autoContinue: false });
    expect(returned.snapshot.current).toBeNull();
    expect(returned.snapshot.totalAnswers).toBe(0);
    expect((await call('play_exercise')).snapshot.current).toBeNull();
  });

  it('allows direct future and earlier step selection while only marking valid delivered explanations', async () => {
    const pending = await answerOne();
    const late = await call('teach_lesson', { stepId: 'octave' });
    expect(late.teaching?.playedSteps).toEqual([]);
    expect(late.teaching?.autoContinue).toBe(true);
    expect(await game.exercises.teachingDelivered(sessionId!, late.teaching!.presentationId)).toBe(
      true,
    );
    const early = await call('teach_lesson', { stepId: 'minor-third' });
    expect(early.teaching?.playedSteps).toEqual(['octave']);
    expect(early.teaching?.delivered).toBe(false);
    expect(await game.exercises.teachingDelivered(sessionId!, late.teaching!.presentationId)).toBe(
      false,
    );
    expect(await game.exercises.teachingDelivered(sessionId!, early.teaching!.presentationId)).toBe(
      true,
    );
    const ready = await call('teach_lesson', { stepId: 'ready-for-practice' });
    expect(ready.teaching?.playedSteps).toEqual(['octave', 'minor-third']);
    expect(ready.snapshot.current?.id).toBe(pending.snapshot.current!.id);
    expect(ready.snapshot.totalAnswers).toBe(1);
    expect(ready.teaching?.awaitingPractice).toBe(true);
    await call('start_practice');
    await call('select_lesson', { skillId: 'pitch-direction' });
    const returned = await call('select_lesson', { skillId: 'intervals-foundation' });
    const review = await call('teach_lesson', { stepId: 'octave' });
    expect(review.teaching?.playedSteps).toEqual(['octave', 'minor-third']);
    expect(returned.snapshot.current?.id).toBe(pending.snapshot.current!.id);
  });

  it('keeps played-step indications scoped to their lesson when step IDs overlap', async () => {
    const overview = await call('play_exercise');
    await game.exercises.teachingDelivered(sessionId!, overview.teaching!.presentationId);
    expect((await game.snapshot()).teaching?.playedSteps).toEqual(['overview']);
    await call('select_lesson', { skillId: 'pitch-direction' });
    const pitch = await call('teach_lesson', { stepId: 'overview' });
    expect(pitch.teaching?.playedSteps).toEqual([]);
    const returned = await call('select_lesson', { skillId: 'intervals-foundation' }, true);
    expect(returned.teaching?.playedSteps).toEqual(['overview']);
  });

  it('separates the solo position from a saved coach tutorial', async () => {
    const demo = await call('teach_lesson', { stepId: 'major-third' });
    await call('end_session');
    sessionId = (await call('start_session', { mode: 'solo' })).snapshot.session!.id;
    const solo = await call('play_exercise');
    expect(solo.snapshot.teaching).toBeNull();
    expect(solo.snapshot.current?.status).toBe('unanswered');
    await call('end_session');
    sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
    const coach = await call('play_exercise');
    expect(coach.teaching?.stepId).toBe(demo.teaching!.stepId);
    expect(coach.teaching?.presentationId).not.toBe(demo.teaching!.presentationId);
    expect(coach.snapshot.current).toBeNull();
  });

  it('preserves the exact tutorial, question and round through database restart', async () => {
    await store.close();
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'lesson-position-'));
    const path = join(directory, 'practice.sqlite');
    store = await Store.open(path);
    try {
      await store.progress.completeLesson('pitch-direction', new Date().toISOString());
      game = await AgentService.create(store, true, 'test');
      sessionId = undefined;
      sessionId = (await call('start_session', { mode: 'coach', focus: 'intervals-foundation' }))
        .snapshot.session!.id;
      const pending = await answerOne();
      const demo = await call('teach_lesson', { stepId: 'perfect-fifth' });
      const before = (await game.snapshot()).course.round;
      await call('select_lesson', { skillId: 'pitch-direction' });
      await store.close();
      store = await Store.open(path);
      game = await AgentService.create(store, true, 'test');
      const returned = await call('select_lesson', { skillId: 'intervals-foundation' }, true);
      expect(returned.teaching?.stepId).toBe(demo.teaching!.stepId);
      expect(returned.teaching?.example).toEqual(demo.teaching!.example);
      expect(returned.snapshot.current?.id).toBe(pending.snapshot.current!.id);
      expect(returned.snapshot.course.round).toEqual(before);
      await call('end_session');
      sessionId = undefined;
      sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
      expect((await call('play_exercise')).teaching?.stepId).toBe(demo.teaching!.stepId);
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('explicit tutorial reset', () => {
  it('resets only the confirmed round and retains all saved attempts and completions', async () => {
    const pending = await answerOne();
    const before = await game.snapshot();
    const attempts = await store.attempts.recent();
    const result = await call('teach_lesson', {
      restart: true,
      discardRoundId: before.course.round.id,
    });
    expect(result.teaching?.stepId).toBe('overview');
    expect(result.snapshot.current).toBeNull();
    expect(result.snapshot.session).toMatchObject({
      currentExerciseId: null,
      previousExerciseId: null,
      awaitingRoundChoice: false,
    });
    expect(result.snapshot.course.round).toMatchObject({ correct: 0, answers: [], previous: null });
    expect(result.snapshot.course.round.id).not.toBe(before.course.round.id);
    expect(result.snapshot.totalAnswers).toBe(before.totalAnswers);
    expect(result.snapshot.progress).toEqual(before.progress);
    expect(await store.attempts.recent()).toEqual(attempts);
    expect(result.snapshot.course.lessons).toEqual(before.course.lessons);
    expect(await store.exercises.get(pending.snapshot.current!.id)).not.toBeNull();
    const next = await call('start_practice');
    expect(next.snapshot.current?.id).not.toBe(pending.snapshot.current!.id);
    expect(next.snapshot.course.round.answers).toEqual([]);
  });

  it('rejects stale reset consent without changing the active question or tutorial mode', async () => {
    await answerOne();
    const before = await game.snapshot();
    await expect(
      call('teach_lesson', { restart: true, discardRoundId: randomUUID() }),
    ).rejects.toThrow('round changed');
    const after = await game.snapshot();
    expect(after.session).toEqual(before.session);
    expect(after.current).toEqual(before.current);
    expect(after.course).toEqual(before.course);
    expect(after.totalAnswers).toBe(before.totalAnswers);
  });

  it('does not revive a parked question from a round reset in the other input mode', async () => {
    await call('end_session');
    sessionId = (await call('start_session', { mode: 'solo' })).snapshot.session!.id;
    const solo = await call('play_exercise');
    const oldId = solo.snapshot.current!.id;
    await call('end_session');
    sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
    await call('teach_lesson', { restart: true, discardRoundId: solo.snapshot.course.round.id });
    await call('end_session');
    sessionId = (await call('start_session', { mode: 'solo' })).snapshot.session!.id;
    const fresh = await call('play_exercise');
    expect(fresh.snapshot.current?.id).not.toBe(oldId);
    expect((await store.exercises.get(fresh.snapshot.current!.id))!.roundId).toBe(
      fresh.snapshot.course.round.id,
    );
  });
});

describe('unscored piano facts', () => {
  it.each(skillIds)(
    'uses actual %s demo notes in the same diagram contract as grading',
    async (skillId) => {
      for (const step of teachingSteps(skillId, 'piano')) {
        if (!step.audio) continue;
        for (const skill of (await game.snapshot()).course.lessons) {
          await store.progress.completeLesson(skill.skillId, new Date().toISOString());
        }
        await call('select_lesson', { skillId });
        const demo = await call('teach_lesson', { stepId: step.id });
        expect(demo.teaching?.example?.midi).toEqual(
          [...step.audio.events].sort((a, b) => a.at - b.at).map((note) => note.midi),
        );
        expect(demo.teaching?.example?.notes.length).toBe(demo.teaching?.example?.midi.length);
        expect(demo.playbackExerciseId).toBeUndefined();
        expect(demo.snapshot.totalAnswers).toBe(0);
        expect(demo.snapshot.course.round.answers).toEqual([]);
      }
    },
  );
});

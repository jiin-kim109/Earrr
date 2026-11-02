import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentService as Game } from '../server/services/agent/agent.service.js';
import { Store } from '../server/db/database.js';
import { skills } from '../server/services/exercise/catalog.js';
import type { SkillId } from '../shared/types/course.js';
import type { ToolName } from '../server/types/agent.types.js';
import {
  agentInstructions,
  narrationText,
  presentationContext,
  publicToolResult,
} from '../server/services/agent/presentation.js';

let store: Store;
let game: Game;
let sessionId: string;
beforeEach(async () => {
  store = await Store.open(':memory:');
  game = await Game.create(store, true, 'test');
  sessionId = '';
});
afterEach(async () => await store.close());
const call = async (name: ToolName, args: Record<string, unknown> = {}, agent = true) =>
  await game.execute(
    { callId: randomUUID(), ...(sessionId ? { sessionId } : {}), name, arguments: args },
    agent,
  );
async function start(id: SkillId) {
  for (const skill of skills)
    await store.db
      .prepare('INSERT INTO lesson_completions(skill_id,completed_at) VALUES(?,?)')
      .run(skill.id, new Date().toISOString());
  await store.progress.finishIntroduction(id, 'skipped');
  sessionId = (await call('start_session', { focus: id, mode: 'coach' })).snapshot.session!.id;
  return await call('play_exercise');
}

describe('one presentation contract across the whole course', () => {
  it('keeps interval naming explicit when returning from pitch direction and restarting a saved failed round', async () => {
    let interval = await start('intervals-foundation');
    for (let miss = 0; miss < 3; miss++) {
      interval = await call('submit_answer', {
        exerciseId: interval.snapshot.current!.id,
        answer: { interval: 1 },
      });
    }
    expect(interval.roundResult?.passed).toBe(false);
    await call('select_lesson', { skillId: 'pitch-direction' });
    const selected = await call('select_lesson', { skillId: 'intervals-foundation' });
    expect(selected.snapshot.session?.awaitingRoundChoice).toBe(true);
    const round = (await store.progress.round('intervals-foundation'))!;
    round.remaining[0]!.target.presentation = 'descending';
    await store.progress.saveRound(round);
    const restarted = await call('start_round');
    expect(restarted.reply).toBe('cue');
    expect(restarted.snapshot.current).toMatchObject({
      skillId: 'intervals-foundation',
      required: ['interval'],
      prompt: 'Name the interval. The two notes sound descending.',
    });
    expect(restarted.agent.presentation?.context.parts).toEqual([
      { kind: 'next_question', cue: 'Two notes descending.', required: ['interval'] },
    ]);
    expect(restarted.agent.presentation?.narration).toBeUndefined();
    expect(narrationText(restarted)).toBeNull();
    expect(restarted.snapshot.totalAnswers).toBe(3);
    expect(restarted.snapshot.course.round.answers).toHaveLength(0);
  });

  it('scripts only fixed teaching and leaves every practice cue and answer to live Realtime', async () => {
    sessionId = (await call('start_session', { mode: 'coach', focus: 'triads' })).snapshot.session!
      .id;
    const selected = await call('play_exercise');
    const text = narrationText(selected);
    expect(text).toContain(selected.teaching!.narration);
    expect(text).toContain('click Skip or ask me to skip');
    const spelling = structuredClone(selected);
    const teaching = spelling.agent.presentation!.context.parts[0]!;
    if (teaching.kind !== 'teaching') throw new Error('Expected fixed teaching.');
    teaching.explanation = 'Hear G flat, Bbb, Db, F#, and E##.';
    expect(narrationText(spelling)).toContain(
      'Hear G flat, B double flat, D flat, F sharp, and E double sharp.',
    );
    const question = await call('start_practice');
    expect(narrationText(question)).toBeNull();
    const exercise = (await store.exercises.get(question.snapshot.current!.id))!;
    const correct = await call('submit_answer', {
      exerciseId: exercise.id,
      answer: exercise.expected,
    });
    expect(narrationText(correct)).toBeNull();
    expect(
      narrationText(await call('give_hint', { exerciseId: correct.snapshot.current!.id })),
    ).toBeNull();
    const next = (await store.exercises.get(correct.snapshot.current!.id))!;
    const wrong = await call('submit_answer', {
      exerciseId: next.id,
      answer: { ...next.expected, quality: next.expected.quality === 'major' ? 'minor' : 'major' },
    });
    expect(narrationText(wrong)).toBeNull();
    expect(narrationText(await call('inspect_progress'))).toBeNull();
    expect(narrationText(await call('play_exercise'))).toBeNull();
  });

  it('keeps routine context small without dropping question, grading or round facts from the model or UI', async () => {
    const first = await start('intervals-foundation');
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    const result = await call('submit_answer', {
      exerciseId: exercise.id,
      answer: exercise.expected,
    });
    const before = structuredClone(result.snapshot);
    const context = publicToolResult(result);
    expect(context).not.toHaveProperty('lessonChoices');
    expect(context.course).not.toHaveProperty('lessons');
    expect(context.course.round).not.toHaveProperty('answers');
    expect(context.course).toMatchObject({
      selectedLesson: before.course.selectedLesson,
      completedLessons: before.course.completedLessons,
      nextLesson: before.course.nextLesson,
      currentLesson: before.course.lessons.find(
        (lesson) => lesson.skillId === before.course.selectedLesson,
      ),
      completedLessonIds: before.course.lessons
        .filter((lesson) => lesson.status === 'completed')
        .map((lesson) => lesson.skillId),
      round: {
        id: before.course.round.id,
        correct: before.course.round.correct,
        answered: before.course.round.answers.length,
      },
    });
    expect(context.current?.id).toBe(before.current?.id);
    expect(context.current?.required).toEqual(before.current?.required);
    expect(context.grade?.played).toEqual(before.feedback?.example);
    expect(result.snapshot).toEqual(before);
    expect(result.snapshot.course.lessons).toHaveLength(skills.length);
  });

  it('retains the complete catalog at connection and restores detailed progress when asked', async () => {
    const first = await start('triads');
    const prompt = agentInstructions(first.snapshot);
    const initial = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"session":'))!);
    expect(
      initial.lessonChoices.map((lesson: { id: string; name: string }) => ({
        id: lesson.id,
        name: lesson.name,
      })),
    ).toEqual(skills.map((lesson) => ({ id: lesson.id, name: lesson.shortName })));
    expect(initial.lessonChoices.every((lesson: object) => !('completed' in lesson))).toBe(true);
    expect(initial.course).not.toHaveProperty('lessons');
    const requested = await call('inspect_progress');
    expect(requested.agent.context).toEqual(publicToolResult(requested, true));
    expect(requested.agent.context.course.lessons).toEqual(requested.snapshot.course.lessons);
    expect(requested.agent.context.course.round.answers).toEqual(
      requested.snapshot.course.round.answers,
    );
    expect(requested.agent.context.lessonChoices).toHaveLength(skills.length);
    const paused = await call('pause_session');
    expect(paused.agent.context.session?.status).toBe('paused');
    expect(paused.agent.context).not.toHaveProperty('lessonChoices');
    expect(paused.agent.context.course).not.toHaveProperty('lessons');
  });

  it.each(skills.map((skill) => skill.id))(
    '%s introduces the task once, scores briefly, and replays without a follow-up',
    async (id) => {
      const first = await start(id);
      expect(first.reply).toBe('instruction');
      expect(presentationContext(first).parts.map((part) => part.kind)).toEqual(['instruction']);
      expect(publicToolResult(first).current?.prompt).toBe(first.snapshot.current!.prompt);
      const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
      const answer = await call('submit_answer', {
        exerciseId: exercise.id,
        answer: exercise.expected,
      });
      expect(answer.reply).toBe('feedback');
      expect(answer.grade?.verdict).toBe('correct');
      expect(answer.snapshot.current?.id).not.toBe(exercise.id);
      expect(answer.audio).toBeDefined();
      expect(presentationContext(answer).parts.map((part) => part.kind)).toEqual([
        'feedback',
        'next_question',
      ]);
      expect(
        presentationContext(answer).parts.find((part) => part.kind === 'feedback')?.played,
      ).toEqual(answer.snapshot.feedback?.example);
      expect(
        presentationContext(answer).parts.find((part) => part.kind === 'next_question'),
      ).toMatchObject({ required: answer.snapshot.current!.required });
      expect(answer.agent.context).toEqual(publicToolResult(answer));
      expect(answer.agent.presentation?.context).toEqual(presentationContext(answer));
      expect(answer.agent.presentation?.instructions).toContain('parts in order');
      const model = publicToolResult(answer);
      expect(model.current).not.toHaveProperty('prompt');
      expect(model).not.toHaveProperty('message');
      expect(model.grade).not.toHaveProperty('feedback');
      expect(model.grade?.expectedAnswer).toBe(exercise.label);
      const again = await call('replay_exercise');
      expect(again.reply).toBe('none');
      expect(again.agent.presentation).toBeUndefined();
      expect(presentationContext(again).parts.some((part) => part.kind === 'next_question')).toBe(
        false,
      );
      expect(again.audio).toEqual(answer.audio);
      const continued = await call('play_exercise');
      expect(continued.reply).toBe('none');
      expect(continued.snapshot.current?.id).toBe(answer.snapshot.current?.id);
    },
  );

  it('retains only necessary changing cues, without repeating the task', async () => {
    const first = await start('triad-inversions');
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    await call('submit_answer', { exerciseId: exercise.id, answer: exercise.expected }, false);
    const next = await call('play_exercise');
    expect(next.reply).toBe('cue');
    expect(presentationContext(next).parts.map((part) => part.kind)).toEqual(['next_question']);
    expect(presentationContext({ ...next, nextQuestion: false }).parts).toEqual([
      { kind: 'listening_cue', cue: next.snapshot.current!.cue, required: ['inversion'] },
    ]);
    expect(next.snapshot.current?.cue).toMatch(/major.*bass position/i);
    expect(publicToolResult(next).current).not.toHaveProperty('prompt');
  });

  it('still explains a new lesson and named demo, but not a replay of the same demo', async () => {
    await start('pitch-direction');
    const selected = await call('select_lesson', { skillId: 'intervals-foundation' });
    expect(selected.reply).toBe('teaching');
    const demo = await call('teach_lesson', { stepId: 'major-third' });
    expect(demo.reply).toBe('teaching');
    await game.exercises.teachingDelivered(sessionId, demo.teaching!.presentationId);
    const replay = await call('replay_exercise');
    expect(replay.reply).toBe('none');
    expect(replay.audio).toEqual(demo.audio);
  });

  it('explains errors and incomplete answers rather than treating them as silent playback', async () => {
    const first = await start('triad-inversions');
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    const missing = await call('submit_answer', {
      exerciseId: exercise.id,
      answer: { quality: exercise.expected.quality },
    });
    expect(missing.reply).toBe('feedback');
    expect(missing.grade?.verdict).toBe('incomplete');
    expect(missing.audio).toBeUndefined();
    expect(presentationContext(missing).parts.map((part) => part.kind)).toEqual(['feedback']);
    expect(
      presentationContext(missing).parts.find((part) => part.kind === 'feedback')?.played,
    ).toBeUndefined();
    expect((await call('pause_session')).reply).toBe('message');
  });

  it('announces a manually requested new question without repeating the task', async () => {
    const first = await start('intervals-foundation');
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    await call('submit_answer', { exerciseId: exercise.id, answer: exercise.expected }, false);
    const next = await call('play_exercise');
    expect(next.reply).toBe('cue');
    expect(presentationContext(next).parts).toEqual([
      { kind: 'next_question', cue: next.snapshot.current!.cue, required: ['interval'] },
    ]);
    expect(next.snapshot.current?.cue).toMatch(/^Two notes (ascending|descending)\.$/);
    expect(publicToolResult(next).current).not.toHaveProperty('prompt');
  });

  it('keeps saved-result reviews separate from automatic next questions', async () => {
    const first = await start('intervals-foundation');
    const exercise = (await store.exercises.get(first.snapshot.current!.id))!;
    const answer = await call('submit_answer', {
      exerciseId: exercise.id,
      answer: exercise.expected,
    });
    expect(answer.reply).toBe('feedback');
    expect(answer.audio).toBeDefined();
    expect(presentationContext(answer).parts.map((part) => part.kind)).toEqual([
      'feedback',
      'next_question',
    ]);
    expect(presentationContext(await call('review_answer')).parts.map((part) => part.kind)).toEqual(
      ['feedback'],
    );
  });

  it('does not announce a new question for hints or a passed checkpoint', async () => {
    sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
    let result = await call('start_practice');
    const hint = await call('give_hint', { exerciseId: result.snapshot.current!.id });
    expect(presentationContext(hint).parts.some((part) => part.kind === 'next_question')).toBe(
      false,
    );
    let passed = false;
    for (let index = 0; index < 80 && !passed; index++) {
      const exercise = (await store.exercises.get(result.snapshot.current!.id))!;
      result = await call('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
      passed = result.lessonCompleted === true;
    }
    expect(passed).toBe(true);
    expect(result.audio).toBeUndefined();
    expect(presentationContext(result).parts.map((part) => part.kind)).toEqual([
      'feedback',
      'round_result',
      'checkpoint',
    ]);
  });
});

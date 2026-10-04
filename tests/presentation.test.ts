import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentService as Game } from '../server/services/agent/agent.service.js';
import { Store } from '../server/db/database.js';
import { skills } from '../server/services/exercise/catalog.js';
import type { SkillId } from '../shared/types/course.js';
import type { ToolName } from '../server/types/agent.types.js';
import { presentationContext, publicToolResult } from '../server/services/agent/presentation.js';

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
      { kind: 'next_question', cue: next.snapshot.current!.cue },
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

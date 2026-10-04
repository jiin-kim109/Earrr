import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { exportLearning, importLearning } from '../server/services/storage/archive.js';
import { skills } from '../server/services/exercise/catalog.js';
import type { ToolName } from '../server/types/agent.types.js';

let store: Store;
let game: AgentService;
let sessionId: string | undefined;
const call = (name: ToolName, args: Record<string, unknown> = {}, agent = false) =>
  game.execute({ callId: randomUUID(), sessionId, name, arguments: args }, agent);
beforeEach(async () => {
  store = await Store.open(':memory:');
  game = await AgentService.create(store, true, 'test');
  sessionId = undefined;
});
afterEach(async () => store.close());

async function welcome() {
  sessionId = (await call('start_session', { mode: 'coach', welcome: true })).snapshot.session!.id;
  return call('play_exercise');
}

describe('brief unscored section 00 Welcome', () => {
  it('has one short greeting and a next-section question, without music, grades or mastery', async () => {
    const result = await welcome();
    expect(game.exercises.curriculum().welcome).toMatchObject({ number: 0, name: 'Welcome' });
    expect(game.exercises.curriculum().lessons).toHaveLength(29);
    expect(result.teaching).toMatchObject({
      section: 'welcome',
      stepId: 'welcome',
      total: 1,
      autoContinue: false,
      awaitingPractice: false,
      example: null,
    });
    expect(result.teaching!.title).toBe('Welcome');
    expect(result.teaching!.narration.split(/\s+/).length).toBeLessThanOrEqual(35);
    expect(result.teaching!.narration).not.toMatch(/earrr|pitch direction/i);
    expect(result.teaching!.narration).toMatch(/AI coach/);
    expect(result.teaching!.narration).toMatch(/basic pitch.*advanced chords and harmony/);
    expect(result.teaching!.narration).toMatch(/Shall we.+\?$/);
    expect(result.audio).toBeUndefined();
    expect(result.snapshot.current).toBeNull();
    expect(result.snapshot.totalAnswers).toBe(0);
    expect(result.snapshot.course.completedLessons).toBe(0);
    expect(result.snapshot.course.round.id).toBeNull();
    expect(result.agent.presentation?.context.parts).toContainEqual(
      expect.objectContaining({ kind: 'teaching', section: 'welcome' }),
    );
  });

  it('waits after greeting delivery, progress inspection and replay until explicit continuation', async () => {
    const initial = await welcome();
    const presentationId = initial.teaching!.presentationId;
    expect(await game.exercises.teachingDelivered(sessionId!, presentationId)).toBe(true);
    await call('inspect_progress');
    expect((await game.snapshot()).teaching?.section).toBe('welcome');
    const replay = await call('replay_exercise');
    expect(replay.teaching?.section).toBe('welcome');
    expect(replay.teaching?.presentationId).not.toBe(presentationId);
    expect(replay.audio).toBeUndefined();
    await expect(call('continue_teaching', { presentationId })).rejects.toThrow(
      'introduction changed',
    );
    const next = await call('continue_teaching', {
      presentationId: replay.teaching!.presentationId,
    });
    expect(next.teaching?.section).toBeUndefined();
    expect(next.teaching?.stepId).toBe('overview');
    expect(next.snapshot.current).toBeNull();
    expect(next.snapshot.course.welcomeSeen).toBe(true);
    expect(next.snapshot.course.completedLessons).toBe(0);
    expect(await store.progress.introductionSeen('pitch-direction')).toBe(false);
  });

  it('keeps the separate tutorial-to-exercise consent boundary after leaving Welcome', async () => {
    const initial = await welcome();
    await call('continue_teaching', { presentationId: initial.teaching!.presentationId });
    const ready = await call('teach_lesson', { stepId: 'ready-for-practice' });
    await game.exercises.teachingDelivered(sessionId!, ready.teaching!.presentationId);
    const stillWaiting = await call('continue_teaching', {
      presentationId: ready.teaching!.presentationId,
    });
    expect(stillWaiting.teaching?.awaitingPractice).toBe(true);
    expect(stillWaiting.snapshot.current).toBeNull();
    const practice = await call('start_practice');
    expect(practice.snapshot.session?.phase).toBe('practice');
    expect(practice.snapshot.current?.status).toBe('unanswered');
    expect(practice.snapshot.totalAnswers).toBe(0);
  });

  it('parks an unfinished round and restores its exact question when returning to the same lesson', async () => {
    sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
    const question = await call('start_practice');
    const shown = await call('show_welcome');
    expect(shown.teaching?.section).toBe('welcome');
    expect(shown.snapshot.course.round).toEqual(question.snapshot.course.round);
    const returned = await call('select_lesson', { skillId: 'pitch-direction' }, true);
    expect(returned.snapshot.teaching).toBeNull();
    expect(returned.snapshot.current?.id).toBe(question.snapshot.current!.id);
    expect(returned.audio).toEqual(question.audio);
    expect(returned.snapshot.course.round).toEqual(question.snapshot.course.round);
    expect(returned.snapshot.totalAnswers).toBe(0);
  });

  it('does not turn skipping Welcome into a skipped quiz attempt', async () => {
    sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
    const question = await call('start_practice');
    await call('show_welcome');
    const resumed = await call('skip_exercise', { exerciseId: question.snapshot.current!.id });
    expect(resumed.snapshot.current?.id).toBe(question.snapshot.current!.id);
    expect(resumed.snapshot.current?.status).toBe('unanswered');
    expect(resumed.snapshot.totalAnswers).toBe(0);
    expect(await store.attempts.recent()).toHaveLength(0);
  });

  it('restores a reviewed tutorial step with a fresh delivery ID instead of restarting its lesson', async () => {
    await store.progress.completeLesson(skills[0]!.id, new Date().toISOString());
    sessionId = (await call('start_session', { mode: 'coach', focus: 'intervals-foundation' }))
      .snapshot.session!.id;
    const original = await call('teach_lesson', { stepId: 'minor-third' });
    const shown = await call('show_welcome');
    const returned = await call('continue_teaching', {
      presentationId: shown.teaching!.presentationId,
    });
    expect(returned.teaching).toMatchObject({
      stepId: 'minor-third',
      autoContinue: true,
      example: original.teaching!.example,
    });
    expect(returned.teaching!.presentationId).not.toBe(original.teaching!.presentationId);
    expect(returned.snapshot.course.completedLessons).toBe(1);
  });

  it('persists pending Welcome and its parked lesson through a portable guest/account archive', async () => {
    const initial = await welcome();
    await game.exercises.teachingDelivered(sessionId!, initial.teaching!.presentationId);
    const archive = await store.transaction(() => exportLearning(store));
    await store.close();
    store = await Store.open(':memory:');
    await importLearning(store, archive);
    game = await AgentService.create(store, true, 'test');
    const restored = await game.snapshot();
    expect(restored.teaching?.section).toBe('welcome');
    expect(restored.teaching?.presentationId).toBe(initial.teaching!.presentationId);
    expect(restored.course.welcomeSeen).toBe(false);
    const continued = await call('continue_teaching', {
      presentationId: restored.teaching!.presentationId,
    });
    expect(continued.teaching?.stepId).toBe('overview');
    expect(continued.snapshot.course.welcomeSeen).toBe(true);
  });

  it('resumes on explicit section entry without replacing a paused question', async () => {
    sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
    const question = await call('start_practice');
    await call('pause_session');
    const resumed = await call('select_lesson', { skillId: 'pitch-direction' }, true);
    expect(resumed.snapshot.session?.status).toBe('active');
    expect(resumed.snapshot.current?.id).toBe(question.snapshot.current!.id);
    expect(resumed.audio).toEqual(question.audio);
    expect(resumed.snapshot.course.round).toEqual(question.snapshot.course.round);
  });
});

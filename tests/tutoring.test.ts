import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teachingSteps, lessonExamples } from '../server/services/exercise/lessons.js';
import { skills } from '../server/services/exercise/catalog.js';
import { chordNotes, chords, scales } from '../server/services/exercise/music.js';
import { chordQualities, scaleIds, skillIds } from '../shared/schemas/course.js';
import type { SkillId } from '../shared/types/course.js';
import type { ToolName } from '../server/types/agent.types.js';
import { Store } from '../server/db/database.js';
import { AgentService as Game } from '../server/services/agent/agent.service.js';

let store: Store;
let game: Game;
let sessionId: string | undefined;
beforeEach(async () => {
  store = await Store.open(':memory:');
  game = await Game.create(store, true, 'test');
  sessionId = undefined;
});
afterEach(async () => await store.close());
const call = async (name: ToolName, args: Record<string, unknown> = {}) =>
  await game.execute({ callId: randomUUID(), sessionId, name, arguments: args });
async function begin(skillId: SkillId = 'pitch-direction') {
  for (const prior of skills.slice(
    0,
    skills.findIndex((skill) => skill.id === skillId),
  )) {
    await store.db
      .prepare('INSERT OR IGNORE INTO lesson_completions(skill_id,completed_at) VALUES(?,?)')
      .run(prior.id, new Date().toISOString());
  }
  sessionId = (await call('start_session', { mode: 'coach', focus: skillId })).snapshot.session!.id;
  return await call('play_exercise');
}

describe('a tutor before an examiner', () => {
  it('keeps solo practice direct and rejects contradictory guided-mode requests', async () => {
    await expect(call('start_session', { mode: 'solo', teach: true })).rejects.toThrow(
      'Guided introductions use the AI coach',
    );
    sessionId = (await call('start_session', { mode: 'solo' })).snapshot.session!.id;
    const question = await call('play_exercise');
    expect(question.snapshot.session?.phase).toBe('practice');
    expect(question.snapshot.current).not.toBeNull();
    await expect(call('teach_lesson')).rejects.toThrow('Connect the coach');
    expect((await game.snapshot()).current?.id).toBe(question.snapshot.current!.id);
  });

  it('starts a new coached lesson with explanation rather than an unexplained quiz', async () => {
    const result = await begin('intervals-foundation');
    expect(result.snapshot.session?.phase).toBe('teaching');
    expect(result.snapshot.current).toBeNull();
    expect(result.teaching?.stepId).toBe('overview');
    expect(result.teaching?.narration).toContain('distance');
    expect(result.teaching?.narration).not.toContain('Say skip');
    expect(result.teaching!.narration.split(/\s+/).length).toBeLessThanOrEqual(35);
    expect(result.snapshot.totalAnswers).toBe(0);
    expect(result.snapshot).not.toHaveProperty('totalXp');
    expect(result.teaching?.narration).toContain('semitone');
  });
  it('requires complete delivery before automatic advancement, without imposing a quiz score', async () => {
    const initial = await begin();
    const firstId = initial.teaching!.presentationId;
    const before = await call('continue_teaching', { presentationId: firstId });
    expect(before.teaching?.index).toBe(0);
    expect(await game.exercises.teachingDelivered(sessionId!, firstId)).toBe(true);
    const next = await call('continue_teaching', { presentationId: firstId });
    expect(next.teaching?.stepId).toBe('up');
    expect(next.audio?.events).toHaveLength(2);
    expect(next.playbackExerciseId).toBeUndefined();
    expect(next.snapshot.current).toBeNull();
    expect(next.snapshot.totalAnswers).toBe(0);
    expect(next.snapshot).not.toHaveProperty('totalXp');
    await expect(call('continue_teaching', { presentationId: firstId })).rejects.toThrow(
      'introduction changed',
    );
  });
  it('never grades a repeated demo label as an answer', async () => {
    await begin('intervals-foundation');
    const demo = await call('teach_lesson', { stepId: 'minor-third' });
    expect(demo.teaching?.demoLabel).toBe('minor third');
    expect(demo.teaching?.autoContinue).toBe(true);
    await expect(
      call('submit_answer', { exerciseId: randomUUID(), answer: { interval: 3 } }),
    ).rejects.toThrow('not a quiz');
    expect(await store.attempts.recent()).toHaveLength(0);
  });
  it('skips explanation into a fresh question without recording a skip or unlocking a lesson', async () => {
    await begin('intervals-foundation');
    const result = await call('start_practice');
    expect(result.snapshot.session?.phase).toBe('practice');
    expect(result.snapshot.teaching).toBeNull();
    expect(result.snapshot.current?.kind).toBe('interval');
    expect(result.snapshot.current?.status).toBe('unanswered');
    expect(result.snapshot.totalAnswers).toBe(0);
    expect(result.snapshot).not.toHaveProperty('totalXp');
    expect(await store.attempts.recent()).toHaveLength(0);
    expect(await store.progress.introductionSeen('intervals-foundation')).toBe(true);
    expect(
      result.snapshot.course.lessons.find((item) => item.skillId === 'intervals-chromatic')
        ?.unlocked,
    ).toBe(false);
  });
  it('can reteach during practice and resume the exact parked question', async () => {
    await begin('intervals-foundation');
    const practice = await call('start_practice');
    const id = practice.snapshot.current!.id;
    const lesson = await call('teach_lesson', { restart: true });
    expect(lesson.snapshot.current?.id).toBe(id);
    expect(lesson.teaching?.index).toBe(0);
    const resumed = await call('start_practice');
    expect(resumed.snapshot.current?.id).toBe(id);
    expect(resumed.audio).toEqual(practice.audio);
    expect(resumed.snapshot.totalAnswers).toBe(0);
  });
  it('makes legacy skip/replay tools safe in the teaching phase', async () => {
    await begin('intervals-foundation');
    const demo = await call('teach_lesson', { stepId: 'minor-third' });
    await game.exercises.teachingDelivered(sessionId!, demo.teaching!.presentationId);
    const next = await call('continue_teaching', { presentationId: demo.teaching!.presentationId });
    expect(next.teaching?.stepId).toBe('major-third');
    const repeated = await call('replay_exercise');
    expect(repeated.teaching?.stepId).toBe('minor-third');
    expect(repeated.audio).toEqual(demo.audio);
    expect(repeated.teaching?.autoContinue).toBe(false);
    const practice = await call('skip_exercise', { exerciseId: randomUUID() });
    expect(practice.snapshot.session?.phase).toBe('practice');
    expect(practice.snapshot.totalAnswers).toBe(0);
  });
  it('waits at the tutorial invitation until an explicit start_practice tool call', async () => {
    let result = await begin();
    let segments = 0;
    while (result.teaching?.autoContinue) {
      expect(++segments).toBeLessThan(20);
      await game.exercises.teachingDelivered(sessionId!, result.teaching.presentationId);
      result = await call('continue_teaching', { presentationId: result.teaching.presentationId });
    }
    expect(segments).toBe(teachingSteps('pitch-direction', 'piano').length - 1);
    expect(result.teaching).toMatchObject({
      stepId: 'ready-for-practice',
      awaitingPractice: true,
      autoContinue: false,
    });
    expect(result.snapshot.session?.teaching?.autoContinue).toBe(false);
    expect(result.snapshot.current).toBeNull();
    expect(result.snapshot.totalAnswers).toBe(0);
    expect(result.agent.presentation?.context.parts).toContainEqual(
      expect.objectContaining({
        kind: 'teaching',
        awaitingPractice: true,
      }),
    );
    expect(await store.progress.introductionSeen('pitch-direction')).toBe(false);
    const presentationId = result.teaching!.presentationId;
    await game.exercises.teachingDelivered(sessionId!, presentationId);
    for (let repeat = 0; repeat < 2; repeat++) {
      const waiting = await call('continue_teaching', { presentationId });
      expect(waiting.teaching?.presentationId).toBe(presentationId);
      expect(waiting.snapshot.session?.phase).toBe('teaching');
      expect(waiting.snapshot.current).toBeNull();
      expect(waiting.audio).toBeUndefined();
    }
    expect((await call('play_exercise')).snapshot.current).toBeNull();
    result = await call('start_practice');
    expect(result.snapshot.session?.phase).toBe('practice');
    expect(result.snapshot.current?.status).toBe('unanswered');
    expect(result.snapshot.totalAnswers).toBe(0);
    expect(await store.progress.introductionSeen('pitch-direction')).toBe(true);
    await call('end_session');
    sessionId = undefined;
    const restarted = await call('start_session', { mode: 'coach' });
    expect(restarted.snapshot.session?.phase).toBe('practice');
  });
  it('does not automatically start practice from an older saved final teaching step', async () => {
    await begin();
    const invitation = await call('teach_lesson', { stepId: 'ready-for-practice' });
    const session = (await store.sessions.get(sessionId!))!;
    await store.sessions.save({
      ...session,
      teaching: { ...session.teaching!, delivered: true, autoContinue: true },
    });
    expect((await game.snapshot()).teaching).toMatchObject({
      autoContinue: false,
      awaitingPractice: true,
    });
    const waiting = await call('continue_teaching', {
      presentationId: invitation.teaching!.presentationId,
    });
    expect(waiting.snapshot.session?.phase).toBe('teaching');
    expect(waiting.snapshot.current).toBeNull();
    expect(waiting.snapshot.totalAnswers).toBe(0);
    const repeated = await call('teach_lesson', { stepId: 'up' });
    expect(repeated.teaching?.awaitingPractice).toBe(false);
    expect(repeated.snapshot.current).toBeNull();
    expect(repeated.audio).toBeDefined();
  });
  it('preserves the exact step across pause/resume and rejects late delivery after skipping', async () => {
    const result = await begin();
    const presentationId = result.teaching!.presentationId;
    await call('pause_session');
    expect(await game.exercises.teachingDelivered(sessionId!, presentationId)).toBe(false);
    expect((await call('resume_session')).snapshot.teaching?.presentationId).toBe(presentationId);
    await call('start_practice');
    expect(await game.exercises.teachingDelivered(sessionId!, presentationId)).toBe(false);
    await expect(call('continue_teaching', { presentationId })).rejects.toThrow(
      'introduction changed',
    );
  });
});

describe('deterministic instructional music', () => {
  it('teaches just upward and downward motion before inviting pitch-direction practice', () => {
    const steps = teachingSteps('pitch-direction', 'piano');
    expect(steps.map((step) => step.id)).toEqual(['overview', 'up', 'down', 'ready-for-practice']);
    expect(lessonExamples('pitch-direction', 'piano')).toHaveLength(2);
    for (const step of steps.filter((item) => item.audio)) {
      const [first, second] = step.audio!.events;
      expect(first!.midi).not.toBe(second!.midi);
    }
  });
  it.each(skillIds)(
    'provides explanations and correctly bounded labeled demos for %s',
    (skillId) => {
      const steps = teachingSteps(skillId, 'piano');
      expect(steps[0]?.id).toBe('overview');
      expect(steps.at(-1)?.id).toBe('ready-for-practice');
      expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
      expect(lessonExamples(skillId, 'piano').length).toBeGreaterThanOrEqual(2);
      for (const step of steps) {
        expect(step.narration.length).toBeGreaterThan(20);
        if (!step.audio) continue;
        expect(step.demoLabel).toBeTruthy();
        expect(step.audio.instrument).toBe('piano');
        for (const note of step.audio.events) {
          expect(note.midi).toBeGreaterThanOrEqual(36);
          expect(note.midi).toBeLessThanOrEqual(100);
          expect(note.at + note.duration).toBeLessThanOrEqual(step.audio.duration);
        }
      }
    },
  );
  it('compares minor and major thirds from the same root, register, and piano sound', () => {
    const steps = teachingSteps('intervals-foundation', 'piano');
    const minor = steps.find((step) => step.id === 'minor-third')!.audio!;
    const major = steps.find((step) => step.id === 'major-third')!.audio!;
    expect(minor.events.map((event) => event.midi)).toEqual([60, 63, 63, 60]);
    expect(major.events.map((event) => event.midi)).toEqual([60, 64, 64, 60]);
    expect(minor.events.map(({ at, duration }) => ({ at, duration }))).toEqual(
      major.events.map(({ at, duration }) => ({ at, duration })),
    );
    expect(steps.some((step) => step.id === 'compare-thirds')).toBe(false);
    expect(steps.some((step) => step.id === 'direction-is-not-distance')).toBe(false);
  });
  it('derives every named chord and inversion example from the same theory engine as grading', () => {
    for (const skill of [
      'triads',
      'triad-colors',
      'triad-inversions',
      'seventh-chords',
      'seventh-colors',
      'seventh-inversions',
      'added-tones',
      'extensions',
      'altered-dominants',
    ] as const) {
      for (const step of teachingSteps(skill, 'piano')) {
        const quality = chordQualities.find((id) => step.id.startsWith(`${id}-`));
        if (!quality || !step.audio) continue;
        const inversion = Number(step.id.split('-').at(-1));
        expect(step.audio.events.map((note) => note.midi)).toEqual(
          chordNotes(60, quality, inversion),
        );
        expect(step.demoLabel).toContain(chords[quality].name);
      }
    }
  });
  it('uses the correct scale and mode pitch sequences', () => {
    for (const lesson of ['scales', 'modes'] as const)
      for (const step of teachingSteps(lesson, 'piano')) {
        const id = scaleIds.find((candidate) => candidate === step.id);
        if (!id) continue;
        expect(
          step
            .audio!.events.filter((note) => note.role === 'exercise')
            .map((note) => note.midi - 60),
        ).toEqual(scales[id].steps);
      }
  });
});

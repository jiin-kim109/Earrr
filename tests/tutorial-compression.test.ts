import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { teachingSteps } from '../server/services/exercise/lessons.js';
import { normalizeTeachingProgress } from '../server/services/exercise/teaching-progress.js';
import { skills } from '../server/services/exercise/catalog.js';
import { describePlayedExample } from '../server/services/exercise/exercise.service.js';
import type { SkillId } from '../shared/types/course.js';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { agentInstructions } from '../server/services/agent/presentation.js';

describe('concise tutorials with stable saved positions', () => {
  it('keeps overviews concise and preserves every unique core explanation', () => {
    for (const skill of skills) {
      const steps = teachingSteps(skill.id, 'piano');
      expect(steps[0]!.narration.split(/\s+/).length, skill.id).toBeLessThanOrEqual(35);
      expect(steps.at(-1)!.id).toBe('ready-for-practice');
      expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    }
    expect(teachingSteps('intervals-foundation', 'piano')).toHaveLength(7);
    expect(teachingSteps('intervals-chromatic', 'piano').filter((step) => step.audio)).toHaveLength(
      7,
    );
    expect(teachingSteps('triad-colors', 'piano').filter((step) => step.audio)).toHaveLength(4);
    expect(teachingSteps('triad-inversions', 'piano').filter((step) => step.audio)).toHaveLength(4);
    expect(teachingSteps('seventh-colors', 'piano').filter((step) => step.audio)).toHaveLength(3);
    expect(teachingSteps('added-tones', 'piano').some((step) => step.id === 'add2-0')).toBe(false);
  });

  it('shows the actual semitone distance for ascending/descending tutorial pairs', () => {
    for (const [id, semitones] of [
      ['minor-third', 3],
      ['major-third', 4],
      ['perfect-fourth', 5],
      ['perfect-fifth', 7],
      ['octave', 12],
    ] as const) {
      const step = teachingSteps('intervals-foundation', 'piano').find((item) => item.id === id)!;
      const facts = describePlayedExample({ audio: step.audio! }, 'all');
      expect(facts.semitones).toBe(semitones);
      expect(facts.midi).toHaveLength(4);
    }
  });

  it.each([
    ['intervals-foundation', 6, 'octave'],
    ['intervals-foundation', 3, 'perfect-fourth'],
    ['intervals-foundation', 8, 'ready-for-practice'],
    ['intervals-chromatic', 3, 'tritone'],
    ['triad-colors', 2, 'diminished-0'],
    ['triad-inversions', 4, 'minor-1'],
    ['added-tones', 3, 'add9-0'],
  ] satisfies Array<[SkillId, number, string]>)(
    'restores legacy %s position %i as %s',
    (lessonId, index, stepId) => {
      const old = {
        lessonId,
        index,
        presentationId: randomUUID(),
        delivered: true,
        lastDemoIndex: index,
        autoContinue: false,
      };
      const next = normalizeTeachingProgress(old);
      expect(next.stepId).toBe(stepId);
      expect(teachingSteps(lessonId, 'piano')[next.index]!.id).toBe(stepId);
      expect(normalizeTeachingProgress(next)).toEqual(next);
      if (next.presentationId !== old.presentationId) expect(next.delivered).toBe(false);
    },
  );

  it('normalizes active and parked legacy tutorial state without changing the pending question or progress', async () => {
    const store = await Store.open(':memory:');
    try {
      let game = await AgentService.create(store, true, 'test');
      const started = await game.execute({
        callId: randomUUID(),
        name: 'start_session',
        arguments: { mode: 'coach' },
      });
      const session = started.snapshot.session!;
      const legacy = {
        lessonId: 'intervals-foundation' as const,
        index: 6,
        lastDemoIndex: 6,
        presentationId: randomUUID(),
        delivered: true,
        autoContinue: false,
      };
      await store.sessions.save({
        ...session,
        focus: 'intervals-foundation',
        phase: 'teaching',
        teaching: legacy,
      });
      await store.progress.selectLesson('intervals-foundation');
      await store.sessions.saveLessonPosition('intervals-foundation', 'coach', {
        phase: 'teaching',
        teaching: legacy,
        currentExerciseId: null,
        previousExerciseId: null,
      });
      game = await AgentService.create(store, true, 'test');
      const state = await game.snapshot();
      expect(state.teaching?.stepId).toBe('octave');
      expect(state.teaching?.index).toBe(5);
      expect(state.totalAnswers).toBe(0);
      expect(
        (await store.sessions.lessonPosition('intervals-foundation', 'coach'))?.teaching?.stepId,
      ).toBe('octave');
    } finally {
      await store.close();
    }
  });

  it('identifies locked Intervals together distinctly and gives the exercise prerequisite', async () => {
    const store = await Store.open(':memory:');
    try {
      const game = await AgentService.create(store, true, 'test');
      const state = await game.snapshot();
      const prompt = agentInstructions(state);
      expect(prompt).toContain(
        '"id":"intervals-harmonic","name":"Intervals together","unlocked":false',
      );
      expect(prompt).toContain('Never substitute the current lesson');
      await expect(
        game.execute({
          callId: randomUUID(),
          name: 'select_lesson',
          arguments: { skillId: 'intervals-harmonic' },
        }),
      ).rejects.toThrow(
        'Intervals together is locked. Pass Intervals up & down exercises with 8/10',
      );
      expect((await game.snapshot()).course.selectedLesson).toBe(state.course.selectedLesson);
    } finally {
      await store.close();
    }
  });
});

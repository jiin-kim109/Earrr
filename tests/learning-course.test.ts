import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import {
  chapters,
  skills,
  chordPools,
  scalePools,
  functionPools,
  isInversionLesson,
  isSeventhInversion,
} from '../server/services/exercise/catalog.js';
import { createExercise } from '../server/services/exercise/generator.js';
import { roundPlan } from '../server/services/exercise/rounds.js';
import { teachingSteps } from '../server/services/exercise/lessons.js';
import { gradeAnswer } from '../server/services/grading.service.js';
import { defaultSettings } from '../server/repositories/user.repository.js';
import { publicExercise } from '../server/services/exercise/exercise.service.js';
import { missingPositions } from '../server/services/exercise/tasks.js';
import { exportLearning, importLearning } from '../server/services/storage/archive.js';
import { presentationInstructions } from '../server/services/agent/presentation.js';

describe('manageable learning progression', () => {
  it('has small answer sets and teaches functions before guided progressions', () => {
    expect(skills).toHaveLength(29);
    expect(chapters.map((chapter) => chapter.name)).toEqual([
      'Pitch & intervals',
      'Chord colors',
      'Scales & modes',
      'Roots & inversions',
      'Seventh chords',
      'Chord progressions',
      'Seventh inversions',
      'Added tones & extensions',
      'Altered dominants',
    ]);
    expect(skills.filter((skill) => skill.chapter === 1).map((skill) => skill.id)).toEqual([
      'pitch-direction',
      'intervals-foundation',
      'intervals-harmonic',
    ]);
    for (const retired of [
      'reference-pitch',
      'intervals-chromatic',
      'melodies',
      'jazz-progressions',
    ])
      expect(skills.some((skill) => skill.id === retired)).toBe(false);
    for (const skill of skills) {
      const pool = chordPools[skill.id] ?? scalePools[skill.id] ?? functionPools[skill.id];
      if (pool) expect(pool.length, skill.id).toBeLessThanOrEqual(5);
      if (isInversionLesson(skill.id)) {
        const exercise = createExercise({
          id: randomUUID(),
          skillId: skill.id,
          seed: 9,
          now: '',
          settings: defaultSettings,
        });
        expect(exercise.required).toEqual(['inversion']);
        expect(exercise.expected.inversion).toBeLessThan(isSeventhInversion(skill.id) ? 4 : 3);
        expect(exercise.prompt).toContain('bass');
      }
    }
    expect(chordPools['triad-colors']).toEqual(['major', 'minor', 'diminished', 'augmented']);
    expect(chordPools['suspended-chords']).toEqual([
      'major',
      'minor',
      'diminished',
      'augmented',
      'sus4',
    ]);
    expect(scalePools.scales).toEqual(['naturalMinor', 'harmonicMinor', 'melodicMinor']);
    expect(scalePools.modes).toEqual(['lydian', 'mixolydian']);
    expect(scalePools['minor-modes']).toEqual(['dorian', 'phrygian', 'locrian']);
    expect(Object.values(chordPools).flat()).not.toContain('minorMajor7');
    expect(Object.values(scalePools).flat()).not.toEqual(
      expect.arrayContaining(['blues', 'wholeTone']),
    );
    expect(skills.findIndex((skill) => skill.id === 'minor-functions')).toBeLessThan(
      skills.findIndex((skill) => skill.id === 'cadences'),
    );
  });

  it('keeps the major/minor tutorial at five steps while advancing four real examples within its character step', async () => {
    const store = await Store.open(':memory:');
    try {
      for (const skill of skills)
        await store.progress.completeLesson(skill.id, new Date().toISOString());
      const game = await AgentService.create(store, true, 'test');
      const sessionId = (
        await game.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach', focus: 'triads' },
        })
      ).snapshot.session!.id;
      let result = await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'teach_lesson',
        arguments: { stepId: 'character' },
      });
      expect(result.teaching?.total).toBe(5);
      const sounds: number[][] = [];
      for (const symbol of ['CM', 'Cm', 'EM', 'Em']) {
        expect(result.teaching?.index).toBe(3);
        expect(result.teaching?.example?.symbol).toBe(symbol);
        sounds.push(result.audio!.events.map((event) => event.midi));
        expect(
          await game.exercises.teachingDelivered(sessionId, result.teaching!.presentationId),
        ).toBe(true);
        result = await game.execute({
          callId: randomUUID(),
          sessionId,
          name: 'continue_teaching',
          arguments: { presentationId: result.teaching!.presentationId },
        });
      }
      expect(sounds).toEqual([
        [60, 64, 67],
        [60, 63, 67],
        [64, 68, 71],
        [64, 67, 71],
      ]);
      expect(result.teaching?.awaitingPractice).toBe(true);
      expect(result.snapshot.totalAnswers).toBe(0);
      expect(result.snapshot.current).toBeNull();
    } finally {
      await store.close();
    }
  });

  it.each(['cadences', 'progressions'] as const)(
    '%s only tests missing inner functions with both endpoints supplied',
    (skillId) => {
      const answers = new Set<string>();
      for (let round = 1; round < 5; round++) {
        const planned = roundPlan(skillId, round, round);
        expect(planned.every((target) => target.format === 'complete')).toBe(true);
        if (skillId === 'progressions')
          expect(planned.filter((target) => target.gapCount === 2)).toHaveLength(5);
        for (const [seed, target] of planned.entries()) {
          const exercise = createExercise({
            id: randomUUID(),
            skillId,
            seed,
            target,
            now: '',
            settings: defaultSettings,
          });
          const question = publicExercise(exercise).question;
          if (question?.kind !== 'sequence') throw new Error('Missing guided notation.');
          expect(question.labels[0]).not.toBeNull();
          expect(question.labels.at(-1)).not.toBeNull();
          const gaps = missingPositions(exercise);
          expect(gaps.length).toBe(skillId === 'cadences' ? 1 : target.gapCount);
          for (const gap of gaps) {
            expect(question.labels[gap]).toBeNull();
            expect(question.notation?.[gap]).toBeNull();
          }
          const expected = exercise.expected.progression!;
          const reply =
            gaps.length === 1
              ? { degree: expected[gaps[0]!] }
              : { progression: gaps.map((index) => expected[index]!) };
          expect(gradeAnswer(exercise, reply).verdict).toBe('correct');
          expect(gradeAnswer(exercise, { progression: expected }).verdict).toBe('correct');
          answers.add(gaps.map((index) => expected[index]).join());
        }
      }
      expect(answers.size).toBeGreaterThanOrEqual(4);
      expect(teachingSteps('cadences', 'piano')[1]!.id).toBe('progression-2-5-1');
    },
  );

  it('restores old archives without exposing retired lessons or fabricating completion', async () => {
    const old = await Store.open(':memory:');
    const restored = await Store.open(':memory:');
    try {
      await old.progress.completeLesson('pitch-direction', '2026-10-01T00:00:00.000Z');
      const archive = await exportLearning(old);
      archive.tables.course = [{ id: 1, skill_id: 'reference-pitch' }];
      await importLearning(restored, archive);
      const game = await AgentService.create(restored, false, 'test');
      const state = await game.snapshot();
      expect(state.course.selectedLesson).toBe('intervals-harmonic');
      expect(state.course.completedLessons).toBe(1);
      expect(state.totalAnswers).toBe(0);
      expect((await restored.db.prepare('SELECT revision FROM course').get())?.revision).toBe(3);
      await game.restoreCheckpoint();
      expect((await game.snapshot()).course).toEqual(state.course);
    } finally {
      await old.close();
      await restored.close();
    }
  });

  it('scopes all scripted spoken purposes to musical content instead of old conversation or turn-control prose', () => {
    for (const purpose of ['teaching', 'instruction', 'feedback', 'cue'] as const) {
      const prompt = presentationInstructions(purpose)!;
      expect(prompt).toContain('entire current presentation');
      expect(prompt).toContain('handled outside your response');
      expect(prompt).not.toMatch(/then stop|I.ll stop|I will pause/);
    }
  });
});

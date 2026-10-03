import { describe, expect, it } from 'vitest';
import {
  dateKey,
  updateProgress,
  emptyProgress,
  mastery,
} from '../server/services/progress.service.js';
import { gradeAnswer } from '../server/services/grading.service.js';
import {
  arpeggiate,
  createExercise,
  exerciseFingerprint,
} from '../server/services/exercise/generator.js';
import { publicExercise } from '../server/services/exercise/exercise.service.js';
import {
  chordNotes,
  chords,
  midiFrequency,
  parsePitch,
  pitchClass,
} from '../server/services/exercise/music.js';
import { defaultSettings } from '../server/repositories/user.repository.js';
import { skillIds } from '../shared/schemas/course.js';
import type { ChordQuality, SkillId } from '../shared/types/course.js';

const now = '2026-09-19T00:00:00.000Z';
const make = (skillId: SkillId, seed = 12) =>
  createExercise({
    id: '31a11d12-7a03-42de-9825-1de82aeb8dff',
    seed,
    skillId,
    now,
    settings: defaultSettings,
  });

describe('musical ground truth', () => {
  it('uses equal-temperament tuning and enharmonic pitch classes', () => {
    expect(midiFrequency(69)).toBe(440);
    expect(parsePitch('B#')).toBe(0);
    expect(parsePitch('C flat')).toBe(11);
    expect(parsePitch('F♯4')).toBe(6);
    expect(parsePitch('Ebb')).toBe(2);
    expect(parsePitch('Q sharp')).toBeNull();
  });

  it.each(skillIds)('generates valid, reproducible, correctly gradable %s exercises', (skillId) => {
    for (let seed = 0; seed < 80; seed++) {
      const exercise = make(skillId, seed);
      expect(exercise).toEqual(make(skillId, seed));
      expect(exercise.audio.events.length).toBeGreaterThan(0);
      for (const note of exercise.audio.events) {
        expect(Number.isInteger(note.midi)).toBe(true);
        expect(note.midi).toBeGreaterThanOrEqual(36);
        expect(note.midi).toBeLessThanOrEqual(100);
        expect(note.at).toBeGreaterThanOrEqual(0);
        expect(note.at + note.duration).toBeLessThanOrEqual(exercise.audio.duration);
      }
      expect(gradeAnswer(exercise, exercise.expected).verdict).toBe('correct');
      expect(publicExercise(exercise)).not.toHaveProperty('expected');
      expect(publicExercise(exercise)).not.toHaveProperty('reveal');
      expect(publicExercise(exercise)).not.toHaveProperty('audio');
    }
  });

  it('preserves bass identities for every supported inversion', () => {
    for (const quality of [
      'major',
      'minor',
      'major7',
      'minor7',
      'dominant7',
      'halfDiminished7',
    ] as const) {
      for (let inversion = 0; inversion < chords[quality].intervals.length; inversion++) {
        const notes = chordNotes(48, quality, inversion);
        expect(pitchClass(Math.min(...notes))).toBe(chords[quality].intervals[inversion]);
        expect(notes).toEqual([...notes].sort((a, b) => a - b));
      }
    }
  });

  it('only asks for upward or downward pitch motion, never a unison', () => {
    const directions = new Set<string>();
    for (let seed = 0; seed < 300; seed++) {
      const exercise = make('pitch-direction', seed);
      const [first, second] = exercise.audio.events;
      expect(exercise.audio.events).toHaveLength(2);
      expect(first!.midi).not.toBe(second!.midi);
      expect(second!.at).toBeGreaterThan(first!.at + first!.duration);
      const direction = second!.midi > first!.midi ? 'up' : 'down';
      expect(exercise.expected.direction).toBe(direction);
      expect(exercise.prompt).not.toMatch(/same|stay|unison/i);
      expect(gradeAnswer(exercise, { direction: 'same' }).verdict).toBe('incorrect');
      directions.add(direction);
    }
    expect(directions).toEqual(new Set(['up', 'down']));
  });

  it('distinguishes additions from sevenths and specified altered voicings', () => {
    expect(chords.add9.intervals).not.toContain(10);
    expect(chords.dominant9.intervals).toContain(10);
    expect(chords['7b5'].intervals).not.toContain(7);
    expect(chords['7#11'].intervals).toContain(7);
    expect(chords['7#11'].intervals).toContain(18);
    expect(chords['7#5'].intervals).not.toContain(7);
    expect(chords['7b13'].intervals).toContain(7);
  });

  it('treats add2 and add9 as equivalent chord naming, not a trick question', () => {
    const exercise = { ...make('added-tones'), expected: { quality: 'add9' as ChordQuality } };
    expect(gradeAnswer(exercise, { quality: 'add2' }).verdict).toBe('correct');
  });

  it('gives structured partial credit for the foundation of an extended chord', () => {
    const exercise = { ...make('extensions'), expected: { quality: 'major9' as ChordQuality } };
    const grade = gradeAnswer(exercise, { quality: 'major' });
    expect(grade.verdict).toBe('partial');
    expect(grade.score).toBeCloseTo(0.4);
    expect(grade.feedback).toContain('foundation correctly');
  });

  it('asks for missing information without grading or leaking the answer', () => {
    const exercise = make('triad-inversions');
    const grade = gradeAnswer(exercise, { quality: exercise.expected.quality });
    expect(grade.verdict).toBe('incomplete');
    expect(grade.missing).toEqual(['inversion']);
    expect(grade.expectedLabel).toBe('');
    expect(grade).not.toHaveProperty('xp');
  });

  it('clarifies a volunteered wrong root without turning a quality question into an absolute-pitch test', () => {
    const exercise = {
      ...make('triads'),
      expected: { root: 'D', quality: 'minor' as ChordQuality },
    };
    const grade = gradeAnswer(exercise, { root: 'C', quality: 'minor' });
    expect(grade.verdict).toBe('correct');
    expect(grade.feedback).toContain('Root naming was not part');
    expect(grade.feedback).not.toContain('Exactly');
  });

  it('does not test absolute pitch without a reference', () => {
    for (const skill of ['reference-pitch', 'chord-roots'] as const) {
      const exercise = make(skill);
      expect(exercise.audio.events[0]?.role).toBe('reference');
      expect(exercise.audio.events[0]?.midi).toBe(60);
    }
  });

  it('preserves reference notes when breaking a chord into an arpeggio', () => {
    const exercise = make('chord-roots');
    const plan = arpeggiate(exercise.audio);
    expect(plan.events[0]).toEqual(exercise.audio.events[0]);
    const targets = plan.events.filter((note) => note.role === 'exercise');
    expect(new Set(targets.map((note) => note.at)).size).toBe(targets.length);
  });
});

describe('fresh material and adaptive progression', () => {
  it.each(skillIds)(
    'varies %s across roots and registers rather than a fixed answer order',
    (skillId) => {
      const exercises = Array.from({ length: 100 }, (_, seed) => make(skillId, seed));
      expect(new Set(exercises.map((exercise) => exercise.root)).size).toBe(12);
      expect(new Set(exercises.map((exercise) => exercise.register)).size).toBe(2);
      const variants = new Set(exercises.map(exerciseFingerprint)).size;
      if (skillId === 'reference-pitch') expect(variants).toBe(24);
      else expect(variants).toBeGreaterThan(40);
    },
  );

  it('allows consecutive equal qualities, avoiding a predictable major/minor alternation', () => {
    const qualities = Array.from(
      { length: 60 },
      (_, seed) => make('triads', seed).expected.quality,
    );
    expect(qualities.some((quality, index) => index > 0 && quality === qualities[index - 1])).toBe(
      true,
    );
    expect(new Set(qualities)).toEqual(new Set(['major', 'minor']));
  });

  it('generates progressions from harmonic movement instead of a short fixed answer bank', () => {
    for (const skillId of ['progressions', 'jazz-progressions'] as const) {
      const sequences = Array.from({ length: 400 }, (_, seed) =>
        make(skillId, seed).expected.progression!.join(','),
      );
      expect(new Set(sequences).size).toBeGreaterThan(100);
      expect(new Set(sequences.map((sequence) => sequence.split(',')[0])).size).toBeGreaterThan(2);
    }
  });

  it('schedules skipped material for review without counting it as a wrong answer', () => {
    const exercise = make('triads');
    const progress = updateProgress(
      emptyProgress('triads'),
      exercise,
      gradeAnswer(exercise, { quality: 'minor' }),
      new Date(now),
      'UTC',
      true,
    );
    expect(progress.attempts).toBe(0);
    expect(progress.dueAt).not.toBeNull();
  });

  it('requires diverse unassisted practice on multiple days for mastery', () => {
    let progress = emptyProgress('triads');
    for (let seed = 0; seed < 30; seed++) {
      const exercise = make('triads', seed);
      progress = updateProgress(
        progress,
        exercise,
        gradeAnswer(exercise, exercise.expected),
        new Date(now),
        'UTC',
        false,
      );
    }
    expect(mastery(progress)).toBe('Secure');
    const exercise = make('triads', 80);
    progress = updateProgress(
      progress,
      exercise,
      gradeAnswer(exercise, exercise.expected),
      new Date('2026-09-20T00:00:00Z'),
      'UTC',
      false,
    );
    expect(mastery(progress)).toBe('Mastered');
    expect(progress.recentScores).toHaveLength(24);
  });

  it('does not count hinted correctness as unassisted mastery evidence', () => {
    const exercise = { ...make('triads'), hintCount: 1 };
    const progress = updateProgress(
      emptyProgress('triads'),
      exercise,
      gradeAnswer(exercise, exercise.expected),
      new Date(now),
      'UTC',
      false,
    );
    expect(progress.unassistedCorrect).toBe(0);
    expect(progress.roots).toHaveLength(0);
    expect(progress.recentScores).toEqual([0.6]);
  });

  it('uses local calendar dates rather than UTC for daily practice', () => {
    expect(dateKey(new Date(now), 'America/Los_Angeles')).toBe('2026-09-18');
    expect(dateKey(new Date(now), 'Asia/Seoul')).toBe('2026-09-19');
  });
});

import { describe, expect, it } from 'vitest';
import { createExercise } from '../server/services/exercise/generator.js';
import {
  describePlayedExample,
  publicExercise,
} from '../server/services/exercise/exercise.service.js';
import { defaultSettings } from '../server/repositories/user.repository.js';
import type { Exercise } from '../server/types/exercise.types.js';
import { intervalNoteNames, parsePitch, pitchClass } from '../server/services/exercise/music.js';

function interval(notes: Array<[number, number]>): Exercise {
  const exercise = createExercise({
    id: crypto.randomUUID(),
    seed: 1,
    skillId: 'intervals-foundation',
    settings: defaultSettings,
    now: new Date().toISOString(),
  });
  return {
    ...exercise,
    audio: {
      ...exercise.audio,
      events: notes.map(([midi, at]) => ({
        midi,
        at,
        duration: 1,
        velocity: 0.7,
        role: 'exercise',
      })),
    },
  };
}

describe('facts from actual played notes', () => {
  it('describes ascending, descending, and together without guessing note names', () => {
    expect(
      describePlayedExample(
        interval([
          [67, 0],
          [70, 1],
        ]),
      ),
    ).toMatchObject({ notes: ['G4', 'Bb4'], semitones: 3, presentation: 'ascending' });
    expect(
      describePlayedExample(
        interval([
          [67, 0],
          [64, 1],
        ]),
      ),
    ).toMatchObject({ notes: ['G4', 'E4'], semitones: 3, presentation: 'descending' });
    expect(
      describePlayedExample(
        interval([
          [60, 0],
          [72, 0],
        ]),
      ),
    ).toMatchObject({ notes: ['C4', 'C5'], semitones: 12, presentation: 'together' });
  });
  it('reveals only the safe presentation cue for an unanswered interval, not its pitches or size', () => {
    const exercise = interval([
      [67, 0],
      [64, 1],
    ]);
    const visible = publicExercise(exercise);
    expect(visible.cue).toBe('Two notes descending.');
    expect(visible).not.toHaveProperty('reveal');
    expect(visible).not.toHaveProperty('notes');
    expect(visible).not.toHaveProperty('semitones');
    expect(visible).not.toHaveProperty('expected');
  });
  it('does not announce the direction when direction itself is the question', () => {
    const exercise = {
      ...interval([
        [67, 0],
        [64, 1],
      ]),
      kind: 'direction' as const,
      skillId: 'pitch-direction' as const,
    };
    expect(publicExercise(exercise).cue).toBeUndefined();
  });
  it('excludes the reference pitch from the graded target description', () => {
    const exercise = createExercise({
      id: crypto.randomUUID(),
      seed: 4,
      skillId: 'chord-roots',
      settings: defaultSettings,
      now: new Date().toISOString(),
    });
    const example = describePlayedExample(exercise);
    expect(example.notes).toHaveLength(3);
    expect(example.presentation).toBe('together');
  });
  it('uses interval-appropriate spelling rather than calling E to A-flat a major third', () => {
    expect(intervalNoteNames(64, 68)).toEqual(['E4', 'G#4']);
    expect(intervalNoteNames(68, 64)).toEqual(['G#4', 'E4']);
    expect(intervalNoteNames(59, 66)).toEqual(['B3', 'F#4']);
    expect(intervalNoteNames(61, 69)).toEqual(['C#4', 'A4']);
    for (let root = 48; root < 72; root++)
      for (let size = 0; size <= 24; size++) {
        const pair = intervalNoteNames(root, root + size);
        expect(parsePitch(pair[0])).toBe(pitchClass(root));
        expect(parsePitch(pair[1])).toBe(pitchClass(root + size));
      }
  });
});

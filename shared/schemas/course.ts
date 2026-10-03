import { z } from 'zod';

export const skillIds = [
  'pitch-direction',
  'reference-pitch',
  'scale-degrees',
  'intervals-foundation',
  'intervals-harmonic',
  'intervals-chromatic',
  'scales',
  'triads',
  'triad-colors',
  'triad-inversions',
  'chord-roots',
  'seventh-chords',
  'seventh-colors',
  'seventh-inversions',
  'added-tones',
  'extensions',
  'altered-dominants',
  'modes',
  'melodies',
  'progressions',
  'jazz-progressions',
] as const;
export const skillIdSchema = z.enum(skillIds);

export const chordQualities = [
  'major',
  'minor',
  'diminished',
  'augmented',
  'sus2',
  'sus4',
  'major7',
  'minor7',
  'dominant7',
  'halfDiminished7',
  'diminished7',
  'minorMajor7',
  'major6',
  'minor6',
  'add2',
  'add9',
  'minorAdd9',
  'major9',
  'minor9',
  'dominant9',
  'dominant11',
  'minor11',
  'major13',
  'minor13',
  'dominant13',
  '7b9',
  '7#9',
  '7b5',
  '7#5',
  '7#11',
  '7b13',
  '7alt',
] as const;

export const scaleIds = [
  'major',
  'naturalMinor',
  'harmonicMinor',
  'melodicMinor',
  'majorPentatonic',
  'minorPentatonic',
  'blues',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'locrian',
  'wholeTone',
] as const;

export const answerSchema = z
  .object({
    root: z.string().min(1).max(16).optional(),
    quality: z.enum(chordQualities).optional(),
    inversion: z.number().int().min(0).max(3).optional(),
    interval: z.number().int().min(0).max(24).optional(),
    direction: z.enum(['up', 'down', 'same']).optional(),
    degree: z.number().int().min(1).max(7).optional(),
    scale: z.enum(scaleIds).optional(),
    melody: z.array(z.number().int().min(1).max(7)).min(2).max(12).optional(),
    progression: z.array(z.number().int().min(1).max(7)).min(2).max(8).optional(),
  })
  .strict();

export const instrumentSchema = z.enum(['piano', 'guitar']);

import type { ChordQuality, MusicalAnswer, SkillId } from '../../../shared/types/course.js';
import type { Exercise, QuestionDisplay } from '../../types/exercise.types.js';
import { chords, noteName, parsePitch, pitchClass, scales } from './music.js';

export const completionSkills: readonly SkillId[] = [
  'melodies',
  'progressions',
  'jazz-progressions',
];
export const comparisonSkills: readonly SkillId[] = [
  'modes',
  'seventh-colors',
  'added-tones',
  'extensions',
  'altered-dominants',
];

export function chordFoundation(quality: ChordQuality): ChordQuality {
  if (['major6', 'add2', 'add9', 'major7', 'dominant7'].includes(quality)) return 'major';
  if (['minor6', 'minorAdd9', 'minor7', 'minorMajor7'].includes(quality)) return 'minor';
  if (quality === 'halfDiminished7' || quality === 'diminished7') return 'diminished';
  if (quality === 'major9' || quality === 'major13') return 'major7';
  if (quality === 'minor9' || quality === 'minor11' || quality === 'minor13') return 'minor7';
  return 'dominant7';
}

export function functionLabel(degree: number, seventh = false): string {
  const labels = seventh
    ? ['Imaj7', 'ii7', 'iii7', 'IVmaj7', 'V7', 'vi7', 'viiø7']
    : ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
  const label = labels[degree - 1];
  if (!label) throw new Error('The chord function is outside the major key.');
  return label;
}

export function sequenceTask(exercise: Exercise, gapIndex: number) {
  const sequence =
    exercise.kind === 'melody' ? exercise.expected.melody : exercise.expected.progression;
  if (!sequence || sequence[gapIndex] === undefined)
    throw new Error('The missing-note task has no target in its sequence.');
  const subject = exercise.kind === 'melody' ? 'note' : 'chord';
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const given = sequence
    .map((degree, index) => (index === gapIndex ? `missing ${subject}` : words[degree - 1]))
    .join(', ');
  exercise.task = { kind: 'complete', gapIndex };
  exercise.expected = { ...exercise.expected, degree: sequence[gapIndex] };
  exercise.required = ['degree'];
  exercise.prompt = `In ${noteName(exercise.root)} major: ${given}. Listen to the whole ${exercise.kind === 'melody' ? 'phrase' : 'progression'} and name ${subject} ${gapIndex + 1}'s scale degree.`;
  exercise.cue = exercise.prompt;
  const target =
    exercise.kind === 'melody'
      ? `Degree ${sequence[gapIndex]}`
      : functionLabel(sequence[gapIndex]!);
  exercise.label = `${target} (${subject} ${gapIndex + 1})`;
  exercise.hints = [
    `Focus on ${subject} ${gapIndex + 1}; the other positions are already given.`,
    'Listen to the target against the tonic established at the beginning.',
    `The target belongs to ${noteName(exercise.root)} major. Hear its distance from home.`,
  ];
}

export function questionDisplay(exercise: Exercise): QuestionDisplay | undefined {
  const tonic = `${noteName(exercise.root)} major`;
  if (exercise.kind === 'degree')
    return { kind: 'degree', tonic, instruction: 'Find the scale degree' };
  if (exercise.kind === 'melody' || exercise.kind === 'progression') {
    const sequence =
      exercise.kind === 'melody' ? exercise.expected.melody : exercise.expected.progression;
    if (!sequence?.length) throw new Error('The exercise is missing its musical sequence.');
    const gap = exercise.task?.kind === 'complete' ? exercise.task.gapIndex : undefined;
    if (gap !== undefined && (!Number.isInteger(gap) || gap < 0 || gap >= sequence.length))
      throw new Error('The saved question has an invalid missing position.');
    const onsets = [
      ...new Set(
        exercise.audio.events.filter((note) => note.role === 'exercise').map((note) => note.at),
      ),
    ].sort((a, b) => a - b);
    if (onsets.length !== sequence.length)
      throw new Error('The question positions do not match the played sequence.');
    return {
      kind: 'sequence',
      subject: exercise.kind,
      tonic,
      labels: sequence.map((degree, index) =>
        gap === undefined || index === gap
          ? null
          : exercise.kind === 'melody'
            ? String(degree)
            : functionLabel(degree),
      ),
      onsets,
      instruction:
        gap === undefined
          ? exercise.kind === 'melody'
            ? 'Recall the melody'
            : 'Name the chord functions'
          : `Find ${exercise.kind === 'melody' ? 'note' : 'chord'} ${gap + 1}`,
      ...(gap !== undefined ? { targetIndex: gap } : {}),
    };
  }

  if (exercise.task?.kind === 'compare-chords') {
    return {
      kind: 'comparison',
      subject: 'chord',
      reference: `${noteName(exercise.root)}${chords[exercise.task.referenceQuality].suffix}`,
      instruction: 'Name the second chord',
      onsets: comparisonOnsets(exercise),
    };
  }
  if (exercise.task?.kind === 'compare-scale') {
    return {
      kind: 'comparison',
      subject: 'scale',
      reference: `${noteName(exercise.root)} major`,
      instruction: 'Name the second scale',
      onsets: comparisonOnsets(exercise),
    };
  }
  return undefined;
}

function comparisonOnsets(exercise: Exercise): [number, number] {
  const reference = Math.min(
    ...exercise.audio.events.filter((note) => note.role === 'reference').map((note) => note.at),
  );
  const target = Math.min(
    ...exercise.audio.events.filter((note) => note.role === 'exercise').map((note) => note.at),
  );
  if (!Number.isFinite(reference) || !Number.isFinite(target) || reference >= target)
    throw new Error('The comparison is missing its ordered reference and target.');
  return [reference, target];
}

export function normalizeTaskAnswer(exercise: Exercise, answer: MusicalAnswer): MusicalAnswer {
  if (exercise.task?.kind !== 'complete' || answer.degree !== undefined) return answer;
  const values = exercise.kind === 'melody' ? answer.melody : answer.progression;
  const expected =
    exercise.kind === 'melody' ? exercise.expected.melody : exercise.expected.progression;
  if (values?.length === expected?.length && values?.[exercise.task.gapIndex] !== undefined)
    return { ...answer, degree: values[exercise.task.gapIndex] };
  if (exercise.kind === 'progression' && answer.root) {
    const root = parsePitch(answer.root);
    const degree =
      root === null ? -1 : scales.major.steps.indexOf(pitchClass(root - exercise.root));
    if (degree >= 0 && degree < 7) return { ...answer, degree: degree + 1 };
  }
  return answer;
}

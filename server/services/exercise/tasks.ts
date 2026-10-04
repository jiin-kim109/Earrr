import type { ChordQuality, MusicalAnswer, SkillId } from '../../../shared/types/course.js';
import type { Exercise, QuestionDisplay } from '../../types/exercise.types.js';
import { chordSymbol, noteName, parsePitch, pitchClass, scales } from './music.js';

export const completionSkills: readonly SkillId[] = ['melodies', 'jazz-progressions'];
export const comparisonSkills: readonly SkillId[] = [
  'modes',
  'minor-modes',
  'seventh-colors',
  'added-tones',
  'sixth-chords',
  'extensions',
  'elevenths',
  'thirteenths',
  'altered-dominants',
  'altered-fifths',
  'upper-alterations',
];
export const guidedProgressions: readonly SkillId[] = ['cadences', 'progressions'];

export function chordFoundation(quality: ChordQuality): ChordQuality {
  if (['major6', 'add2', 'add9', 'major7', 'dominant7'].includes(quality)) return 'major';
  if (['minor6', 'minorAdd9', 'minor7', 'minorMajor7'].includes(quality)) return 'minor';
  if (quality === 'halfDiminished7' || quality === 'diminished7') return 'diminished';
  if (quality === 'major13') return 'major9';
  if (quality === 'minor11' || quality === 'minor13') return 'minor9';
  if (quality === 'dominant13') return 'dominant9';
  if (quality === 'major9') return 'major7';
  if (quality === 'minor9') return 'minor7';
  return 'dominant7';
}
export function functionLabel(degree: number, seventh = false): string {
  const labels = seventh
    ? ['IM7', 'ii7', 'iii7', 'IVM7', 'V7', 'vi7', 'viiø7']
    : ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
  const label = labels[degree - 1];
  if (!label) throw new Error('The chord function is outside the major key.');
  return label;
}
export function missingPositions(exercise: Exercise): number[] {
  return exercise.task?.kind === 'complete'
    ? (exercise.task.gapIndices ?? [exercise.task.gapIndex])
    : [];
}
export function sequenceTask(exercise: Exercise, positions: number | number[]) {
  const gaps = typeof positions === 'number' ? [positions] : positions;
  const sequence =
    exercise.kind === 'melody' ? exercise.expected.melody : exercise.expected.progression;
  if (
    !sequence ||
    !gaps.length ||
    gaps.some((index) => !Number.isInteger(index) || sequence[index] === undefined)
  )
    throw new Error('The completion task has no valid missing positions.');
  const subject = exercise.kind === 'melody' ? 'note' : 'chord';
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const given = sequence
    .map((degree, index) => (gaps.includes(index) ? `missing ${subject}` : words[degree - 1]))
    .join(', ');
  exercise.task = { kind: 'complete', gapIndex: gaps[0]!, gapIndices: gaps };
  exercise.expected = { ...exercise.expected, degree: sequence[gaps[0]!] };
  exercise.required = gaps.length === 1 ? ['degree'] : ['progression'];
  exercise.prompt = `In ${noteName(exercise.root)} major: ${given}. Name ${gaps.length === 1 ? `the missing ${subject}'s function` : 'the two missing functions, in order'}.`;
  exercise.cue = exercise.prompt;
  exercise.label = gaps
    .map((index) =>
      exercise.kind === 'melody' ? `Degree ${sequence[index]}` : functionLabel(sequence[index]!),
    )
    .join(' – ');
  exercise.hints = [
    `The first and last positions are given. Focus on ${gaps.length === 1 ? 'the missing middle chord' : 'the two middle chords'}.`,
    'Compare each bass note with the tonic reference.',
    'Listen for a chord pulling toward home, or moving away from it.',
  ];
}
export function questionDisplay(exercise: Exercise): QuestionDisplay | undefined {
  const tonic = `${noteName(exercise.root)} major`;
  if (exercise.kind === 'degree') return { kind: 'degree', tonic, instruction: 'Do, mi or sol?' };
  if (exercise.kind === 'function')
    return {
      kind: 'comparison',
      subject: 'chord',
      reference: `${chordSymbol(exercise.root, 'major7')} · I`,
      instruction: 'Which chord function?',
      onsets: comparisonOnsets(exercise),
    };
  if (exercise.kind === 'melody' || exercise.kind === 'progression') {
    const sequence =
      exercise.kind === 'melody' ? exercise.expected.melody : exercise.expected.progression;
    if (!sequence?.length) throw new Error('The exercise is missing its musical sequence.');
    const gaps = missingPositions(exercise);
    if (gaps.some((index) => !Number.isInteger(index) || index < 0 || index >= sequence.length))
      throw new Error('The saved question has an invalid missing position.');
    const onsets = [
      ...new Set(
        exercise.audio.events.filter((note) => note.role === 'exercise').map((note) => note.at),
      ),
    ].sort((a, b) => a - b);
    if (onsets.length !== sequence.length)
      throw new Error('The question positions do not match the sound.');
    return {
      kind: 'sequence',
      subject: exercise.kind,
      tonic,
      onsets,
      labels: sequence.map((degree, index) =>
        !gaps.length || gaps.includes(index)
          ? null
          : exercise.kind === 'melody'
            ? String(degree)
            : functionLabel(degree),
      ),
      instruction: !gaps.length
        ? 'Name the chord functions'
        : gaps.length === 1
          ? 'Find the missing chord'
          : 'Find the two missing chords',
      ...(gaps.length ? { targetIndex: gaps[0], targetIndices: gaps } : {}),
    };
  }
  if (exercise.task?.kind === 'compare-chords')
    return {
      kind: 'comparison',
      subject: 'chord',
      reference: chordSymbol(exercise.root, exercise.task.referenceQuality),
      instruction: 'Name the second chord',
      onsets: comparisonOnsets(exercise),
    };
  if (exercise.task?.kind === 'compare-scale')
    return {
      kind: 'comparison',
      subject: 'scale',
      reference: `${noteName(exercise.root)} ${scales[exercise.task.referenceScale ?? 'major'].name}`,
      instruction: 'Name the second scale',
      onsets: comparisonOnsets(exercise),
    };
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
  const gaps = missingPositions(exercise);
  if (gaps.length > 1) {
    const values = answer.progression;
    return values && values.length === exercise.expected.progression?.length
      ? { ...answer, progression: gaps.map((index) => values[index]!) }
      : answer;
  }
  if (exercise.kind !== 'function' && !gaps.length) return answer;
  if (answer.degree !== undefined) return answer;
  const values = exercise.kind === 'melody' ? answer.melody : answer.progression;
  const sequence =
    exercise.kind === 'melody' ? exercise.expected.melody : exercise.expected.progression;
  if (values?.length === sequence?.length && values?.[gaps[0]!] !== undefined)
    return { ...answer, degree: values[gaps[0]!] };
  if (answer.root) {
    const root = parsePitch(answer.root);
    const degree =
      root === null ? -1 : scales.major.steps.indexOf(pitchClass(root - exercise.root));
    if (degree >= 0 && degree < 7) return { ...answer, degree: degree + 1 };
  }
  return answer;
}

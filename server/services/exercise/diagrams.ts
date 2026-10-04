import { chordQualities, scaleIds } from '../../../shared/schemas/course.js';
import type {
  AudioPlan,
  ChordQuality,
  NoteEvent,
  ScaleId,
  SkillId,
  TeachingStep,
} from '../../../shared/types/course.js';
import type { Exercise, MusicalDiagram } from '../../types/exercise.types.js';
import { chords, chordSymbol, noteName, pitchClass, scales } from './music.js';
import { chordFoundation, functionLabel, missingPositions } from './tasks.js';

const tonalDiagrams: readonly SkillId[] = [
  'scale-degrees',
  'scales',
  'modes',
  'melodies',
  'progressions',
  'jazz-progressions',
  'minor-modes',
  'major-functions',
  'minor-functions',
  'cadences',
];
const degrees: Record<number, string> = {
  0: '1',
  2: '2',
  3: 'b3',
  4: '3',
  5: '4',
  6: 'b5',
  7: '5',
  8: '#5',
  9: '6',
  10: 'b7',
  11: '7',
  13: 'b9',
  14: '9',
  15: '#9',
  17: '11',
  18: '#11',
  20: 'b13',
  21: '13',
};

function spelledNote(midi: number, rootMidi: number, degree: string): string {
  const number = Number(degree.replace(/^[b#]+/, ''));
  if (!Number.isInteger(number) || number < 1) throw new Error('The diagram degree is invalid.');
  const letters = 'CDEFGAB';
  const naturals = [0, 2, 4, 5, 7, 9, 11];
  const letter = (letters.indexOf(noteName(rootMidi)[0]!) + number - 1) % 7;
  const difference = ((pitchClass(midi) - naturals[letter]! + 18) % 12) - 6;
  if (Math.abs(difference) > 2) throw new Error('The diagram note cannot be spelled in this key.');
  const octave = (midi - naturals[letter]! - difference) / 12 - 1;
  return `${letters[letter]}${difference < 0 ? 'b'.repeat(-difference) : '#'.repeat(difference)}${octave}`;
}

function chordTones(notes: NoteEvent[], root: number, quality: ChordQuality) {
  const definition = chords[quality];
  const foundation = chords[chordFoundation(quality)].intervals.map(pitchClass);
  return notes.map(({ midi }) => {
    const interval = definition.intervals.find(
      (value) => pitchClass(value) === pitchClass(midi - root),
    );
    if (interval === undefined)
      throw new Error('The chord diagram does not match the played voicing.');
    const degree = quality === 'diminished7' && interval === 9 ? 'bb7' : degrees[interval];
    if (!degree) throw new Error('The chord diagram is missing a tone label.');
    return {
      midi,
      note: spelledNote(midi, root, degree),
      degree,
      color: !foundation.includes(pitchClass(interval)),
    };
  });
}

function scaleDegree(midi: number, root: number) {
  const degree = scales.major.steps.indexOf(pitchClass(midi - root));
  if (degree < 0 || degree > 6)
    throw new Error('The played note does not belong to the established major key.');
  return degree + 1;
}

function scaleToneLabel(distance: number, scale?: ScaleId): string {
  const labels = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7', '8'];
  if (distance === 6 && (scale === 'lydian' || scale === 'wholeTone')) return '#4';
  if (distance === 8 && scale === 'wholeTone') return '#5';
  const label = labels[distance];
  if (!label) throw new Error('The scale diagram is outside one ascending octave.');
  return label;
}

function diagram(
  skillId: SkillId,
  audio: AudioPlan,
  options: { rootMidi?: number; scale?: ScaleId; targetIndex?: number },
): MusicalDiagram | undefined {
  if (!tonalDiagrams.includes(skillId)) return undefined;
  const notes = audio.events
    .filter((note) => note.role === 'exercise')
    .sort((a, b) => a.at - b.at || a.midi - b.midi);
  if (!notes.length) throw new Error('The musical diagram has no played notes.');
  const references = audio.events.filter((note) => note.role === 'reference');
  const root = options.rootMidi ?? references[0]?.midi;
  if (root === undefined) throw new Error('The musical diagram has no established root.');
  const tonic = `${noteName(root)} major`;
  if (skillId === 'scale-degrees') {
    const target = notes[0]!;
    if (notes.length !== 1) throw new Error('A scale-degree question must have one target note.');
    const degree = scaleDegree(target.midi, root);
    return {
      kind: 'degree',
      tonic,
      degree,
      midi: target.midi,
      note: spelledNote(target.midi, root, String(degree)),
    };
  }
  if (skillId === 'scales' || skillId === 'modes' || skillId === 'minor-modes') {
    return {
      kind: 'scale',
      tonic: `${noteName(root)} tonic`,
      points: notes.map(({ midi }) => {
        const degree = scaleToneLabel(midi - root, options.scale);
        return { midi, label: degree, note: spelledNote(midi, root, degree) };
      }),
      gaps: notes.slice(1).map((note, index) => note.midi - notes[index]!.midi),
    };
  }
  if (skillId === 'melodies') {
    return {
      kind: 'melody',
      tonic,
      points: notes.map(({ midi }) => {
        const degree = scaleDegree(midi, root);
        return { midi, label: String(degree), note: spelledNote(midi, root, String(degree)) };
      }),
      ...(options.targetIndex !== undefined ? { targetIndex: options.targetIndex } : {}),
    };
  }
  const groups = new Map<number, NoteEvent[]>();
  for (const note of notes) {
    const group = groups.get(note.at);
    if (group) group.push(note);
    else groups.set(note.at, [note]);
  }
  return {
    kind: 'progression',
    tonic,
    chords: [...groups.values()].map((group) => {
      const bass = Math.min(...group.map((note) => note.midi));
      const degree = scaleDegree(bass, root);
      const quality = chordQualities.find((id) => {
        const actual = [...new Set(group.map((note) => pitchClass(note.midi - bass)))].sort(
          (a, b) => a - b,
        );
        const expected = [...new Set(chords[id].intervals.map(pitchClass))].sort((a, b) => a - b);
        return actual.join() === expected.join();
      });
      if (!quality) throw new Error('The progression contains an unknown played chord.');
      const tones = chordTones(group, bass, quality);
      const chordRoot = spelledNote(bass, root, String(degree)).replace(/-?\d+$/, '');
      return {
        symbol: `${chordRoot}${chords[quality].suffix}`.replace(/[()]/g, ''),
        function: functionLabel(degree, group.length >= 4),
        midi: tones.map((tone) => tone.midi),
        notes: tones.map((tone) => tone.note),
      };
    }),
    ...(options.targetIndex !== undefined ? { targetIndex: options.targetIndex } : {}),
  };
}

export function exerciseDiagram(exercise: Exercise) {
  const result = diagram(exercise.skillId, exercise.audio, {
    rootMidi: (exercise.register + 1) * 12 + exercise.root,
    scale: exercise.expected.scale,
    ...(exercise.task?.kind === 'complete' ? { targetIndex: exercise.task.gapIndex } : {}),
  });
  const gaps = missingPositions(exercise);
  return result && result.kind === 'progression' && gaps.length
    ? { ...result, targetIndices: gaps }
    : result;
}

export function teachingDiagram(skillId: SkillId, step: TeachingStep) {
  if (!step.audio) return undefined;
  const scale = scaleIds.find((value) => value === step.id);
  return diagram(skillId, step.audio, { scale });
}

export function chordFacts(audio: AudioPlan, root: number, quality: ChordQuality) {
  const notes = audio.events
    .filter((note) => note.role === 'exercise')
    .sort((a, b) => a.at - b.at || a.midi - b.midi);
  const tones = chordTones(notes, root, quality);
  const bass = tones.reduce((lowest, tone) => (tone.midi < lowest.midi ? tone : lowest));
  const inversion =
    pitchClass(bass.midi) !== pitchClass(root) ? `/${bass.note.replace(/-?\d+$/, '')}` : '';
  return {
    symbol: `${chordSymbol(root, quality)}${inversion}`,
    notes: tones.map((tone) => tone.note),
  };
}

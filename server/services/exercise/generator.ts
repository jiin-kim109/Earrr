import { getSkill, intervalLessons, chordPools, scalePools } from './catalog.js';
import { cadence } from './lessons.js';
import {
  chordNotes,
  chords,
  choose,
  intervalNames,
  inversionNames,
  noteName,
  scales,
  seededRandom,
} from './music.js';
import type {
  AudioPlan,
  ChordQuality,
  Instrument,
  NoteEvent,
  ScaleId,
  SkillId,
} from '../../../shared/types/course.js';
import type { Settings } from '../../../shared/types/user.js';
import type { Exercise, ExerciseTarget } from '../../types/exercise.types.js';
import { chordFoundation, comparisonSkills, completionSkills, sequenceTask } from './tasks.js';

function event(
  midi: number,
  at: number,
  duration = 0.8,
  role: NoteEvent['role'] = 'exercise',
  velocity = 0.7,
): NoteEvent {
  return { midi, at, duration, role, velocity };
}
function block(
  notes: number[],
  at: number,
  duration = 1.7,
  role: NoteEvent['role'] = 'exercise',
): NoteEvent[] {
  return notes.map((midi, index) => event(midi, at, duration, role, index === 0 ? 0.75 : 0.62));
}
function audio(events: NoteEvent[], instrument: Instrument): AudioPlan {
  return {
    events,
    instrument,
    duration: Math.max(...events.map((note) => note.at + note.duration)) + 0.3,
  };
}

export function createExercise(options: {
  id: string;
  seed: number;
  skillId: SkillId;
  settings: Settings;
  now: string;
  target?: ExerciseTarget;
}): Exercise {
  const { id, seed, skillId, settings, now } = options;
  const target = options.target ?? {};
  if (target.format === 'complete' && !completionSkills.includes(skillId))
    throw new Error('Completion is not an exercise format for this lesson.');
  if (target.format === 'compare' && !comparisonSkills.includes(skillId))
    throw new Error('Comparison is not an exercise format for this lesson.');
  const random = seededRandom(seed);
  const root = target.root ?? Math.floor(random() * 12);
  const register = choose(random, [3, 4]);
  const rootMidi = 12 * (register + 1) + root;
  const instrument = settings.instrument;
  const exercise: Exercise = {
    id,
    seed,
    skillId,
    root,
    register,
    kind: 'chord',
    prompt: '',
    expected: {},
    required: [],
    label: '',
    explanation: '',
    hints: [],
    audio: { events: [], duration: 0, instrument },
    createdAt: now,
    replayCount: 0,
    hintCount: 0,
    status: 'unanswered',
  };
  const pool = chordPools[skillId];
  if (pool) {
    const quality = target.quality ?? choose(random, pool);
    const definition = chords[quality];
    const inversionTask = skillId === 'triad-inversions' || skillId === 'seventh-inversions';
    const inversion = inversionTask
      ? (target.inversion ?? Math.floor(random() * definition.intervals.length))
      : 0;
    const comparison = target.format === 'compare';
    const open =
      !comparison && getSkill(skillId).difficulty >= 4 && !inversionTask && random() < 0.5;
    const notes = chordNotes(rootMidi, quality, inversion, open);
    const rootTask = skillId === 'chord-roots';
    const suppliedRoot = !['triads', 'seventh-chords', 'chord-roots'].includes(skillId);
    exercise.required = rootTask
      ? ['root', 'quality']
      : inversionTask
        ? ['quality', 'inversion']
        : ['quality'];
    exercise.expected = { root: noteName(root), quality, ...(inversionTask ? { inversion } : {}) };
    exercise.prompt = rootTask
      ? 'First, C4 as a reference. Then identify the root and quality of the chord.'
      : `${suppliedRoot ? `The root is ${noteName(root)}. ` : ''}${inversionTask ? 'Identify the chord quality and inversion.' : 'Identify the chord quality.'}`;
    if (suppliedRoot) exercise.cue = `Root: ${noteName(root)}.`;
    exercise.label = `${noteName(root)} ${definition.name}${inversionTask ? `, ${inversionNames[inversion]}` : ''}`;
    exercise.explanation = definition.color;
    exercise.hints = [
      inversionTask
        ? 'Listen to the lowest note separately from the overall chord color.'
        : 'Separate the foundation of the chord from any added color. You can ask to hear it broken into notes.',
      `Listen for a ${definition.family === 'dominant' ? 'major' : definition.family} foundation${inversionTask ? ', then find which chord tone is in the bass' : ''}.`,
      inversionTask
        ? `The bass is the ${['root', 'third', 'fifth', 'seventh'][inversion]} of the chord.`
        : definition.color,
    ];
    const events = rootTask
      ? [event(60, 0, 0.65, 'reference'), ...block(notes, 1.3)]
      : comparison
        ? [
            ...block(chordNotes(rootMidi, chordFoundation(quality)), 0.2, 1.6, 'reference'),
            ...block(notes, 2.35),
          ]
        : block(notes, 0.2);
    if (comparison) {
      const referenceQuality = chordFoundation(quality);
      exercise.task = { kind: 'compare-chords', referenceQuality };
      exercise.prompt = `First ${noteName(root)} ${chords[referenceQuality].name}, then a changed chord on the same root. Name the second chord's quality.`;
      exercise.cue = exercise.prompt;
    } else if (target.format === 'identify') {
      exercise.cue = `Root ${noteName(root)}. Name this chord's quality.`;
    }
    exercise.audio = audio(events, instrument);
    return exercise;
  }

  switch (skillId) {
    case 'pitch-direction': {
      const direction = target.direction ?? choose(random, ['up', 'down'] as const);
      const distance = choose(random, [1, 2, 3, 4, 5, 7]);
      const second = rootMidi + (direction === 'down' ? -distance : distance);
      Object.assign(exercise, {
        kind: 'direction',
        prompt: 'Does the second note move up or down?',
        expected: { direction },
        required: ['direction'],
        label: `Moving ${direction}`,
        explanation: `The second note is ${distance} semitones ${direction === 'up' ? 'higher' : 'lower'}.`,
        hints: [
          'Hum the first note internally and hold it while you hear the second.',
          'Ignore loudness and timbre. Follow only the height of the sound.',
          'Ask for another listen and imagine a line connecting the two pitches.',
        ],
      });
      exercise.audio = audio([event(rootMidi, 0.1), event(second, 1.15)], instrument);
      break;
    }
    case 'reference-pitch': {
      Object.assign(exercise, {
        kind: 'pitch',
        prompt: 'First, C4 as a reference. Name the note that follows.',
        expected: { root: noteName(root) },
        required: ['root'],
        label: noteName(rootMidi, true),
        explanation: 'The first note was C4. Enharmonic note names receive the same credit.',
        hints: [
          'Use the first note as C, not as something you have to recognize from memory.',
          'Hear the distance from C, then translate that distance into a note name.',
          'You can ask to hear the reference and target again without any penalty.',
        ],
      });
      exercise.audio = audio(
        [event(60, 0.1, 0.8, 'reference'), event(rootMidi, 1.4, 1.1)],
        instrument,
      );
      break;
    }
    case 'scale-degrees': {
      const degree = target.degree ?? 1 + Math.floor(random() * 7);
      Object.assign(exercise, {
        kind: 'degree',
        prompt:
          'After the major-key cadence, which scale degree is the single note? Use 1 to 7 or movable-do solfege.',
        expected: { degree },
        required: ['degree'],
        label: `Scale degree ${degree}`,
        explanation: `The note is ${degree === 1 ? 'the tonic, the point of rest' : `degree ${degree} in ${noteName(root)} major`}.`,
        hints: [
          'The final chord of the introduction establishes home, or do.',
          'Hear whether the target feels at rest or wants to move toward the tonic.',
          `The major-scale solfege syllables are do, re, mi, fa, sol, la, ti.`,
        ],
      });
      exercise.audio = audio(
        [...cadence(rootMidi), event(rootMidi + scales.major.steps[degree - 1]!, 3, 1.2)],
        instrument,
      );
      break;
    }
    case 'intervals-foundation':
    case 'intervals-harmonic':
    case 'intervals-chromatic': {
      const lesson = intervalLessons[skillId];
      const interval = target.interval ?? choose(random, lesson.distances);
      const direction = target.presentation ?? choose(random, lesson.presentations);
      const notes =
        direction === 'descending'
          ? [rootMidi + interval, rootMidi]
          : [rootMidi, rootMidi + interval];
      Object.assign(exercise, {
        kind: 'interval',
        prompt: `Name the interval. The two notes sound ${direction}.`,
        expected: { interval },
        required: ['interval'],
        label: intervalNames[interval],
        explanation: `${intervalNames[interval]} spans ${interval} semitones. The distance is the same in either direction.`,
        hints: [
          'Focus on the space between the notes, not their individual names.',
          interval <= 5
            ? 'This interval fits within a perfect fourth.'
            : interval >= 8
              ? 'This interval is wider than a perfect fifth.'
              : 'This distance is near the middle of an octave.',
          `There are ${interval} semitones between the two notes.`,
        ],
      });
      exercise.audio = audio(
        direction === 'together'
          ? block(notes, 0.2)
          : [event(notes[0]!, 0.1), event(notes[1]!, 1.1, 1)],
        instrument,
      );
      break;
    }
    case 'scales':
    case 'modes': {
      const scale = target.scale ?? choose<ScaleId>(random, scalePools[skillId]);
      const definition = scales[scale];
      Object.assign(exercise, {
        kind: 'scale',
        prompt: `Identify the ${skillId === 'modes' ? 'mode or symmetrical scale' : 'scale'}. Its tonic sounds first.`,
        cue: `Tonic ${noteName(root)}. Name the scale.`,
        expected: { scale },
        required: ['scale'],
        label: `${noteName(root)} ${definition.name}`,
        explanation: definition.clue,
        hints: [
          'Count the different notes and listen for the positions of the half steps.',
          `This scale contains ${definition.steps.length - 1} different pitch classes.`,
          definition.clue,
        ],
      });
      exercise.audio = audio(
        [
          event(rootMidi, 0, 0.7, 'reference'),
          ...definition.steps.map((step, index) =>
            event(rootMidi + step, 1.1 + index * 0.38, 0.34),
          ),
        ],
        instrument,
      );
      if (target.format === 'compare') {
        exercise.task = { kind: 'compare-scale' };
        exercise.prompt = `First ${noteName(root)} major, then a second scale on the same tonic. Name the second scale.`;
        exercise.cue = exercise.prompt;
        exercise.audio = audio(
          [
            ...scales.major.steps.map((step, index) =>
              event(rootMidi + step, 0.1 + index * 0.32, 0.28, 'reference'),
            ),
            ...definition.steps.map((step, index) =>
              event(rootMidi + step, 3.35 + index * 0.38, 0.34),
            ),
          ],
          instrument,
        );
      }
      break;
    }
    case 'melodies': {
      const length = target.length ?? choose(random, [3, 4, 5]);
      const melody = [1 + Math.floor(random() * 7)];
      while (melody.length < length) {
        const previous = melody[melody.length - 1]!;
        melody.push(
          choose(
            random,
            [1, 2, 3, 4, 5, 6, 7].filter(
              (degree) => degree !== previous && Math.abs(degree - previous) <= 3,
            ),
          ),
        );
      }
      Object.assign(exercise, {
        kind: 'melody',
        prompt: `After the major-key cadence, name the ${length} melody notes as scale degrees. Rhythm is not graded.`,
        cue: `In ${noteName(root)} major, recall all ${length} melody notes as scale degrees.`,
        expected: { melody },
        required: ['melody'],
        label: melody.join(' - '),
        explanation: `The melody moves through degrees ${melody.join(', ')} in ${noteName(root)} major.`,
        hints: [
          'Hear the phrase as a shape first. Then find its first note relative to home.',
          `The phrase starts on scale degree ${melody[0]}.`,
          `The first two degrees are ${melody[0]} and ${melody[1]}.`,
        ],
      });
      exercise.audio = audio(
        [
          ...cadence(rootMidi),
          ...melody.map((degree, index) =>
            event(rootMidi + scales.major.steps[degree - 1]!, 3 + index * 0.6, 0.5),
          ),
        ],
        instrument,
      );
      break;
    }
    case 'progressions':
    case 'jazz-progressions': {
      const jazz = skillId === 'jazz-progressions';
      const movement: Record<number, number[]> = {
        1: [2, 3, 4, 5, 6],
        2: [5, 7],
        3: [4, 6],
        4: [1, 2, 5],
        5: [1, 6],
        6: [2, 4, 5],
        7: [1, 3],
      };
      const length = target.length ?? choose(random, [3, 4, 5]);
      const progression = [choose(random, [1, 2, 4, 6])];
      while (progression.length < length)
        progression.push(choose(random, movement[progression[progression.length - 1]!]!));
      const qualities: ChordQuality[] = jazz
        ? ['major7', 'minor7', 'minor7', 'major7', 'dominant7', 'minor7', 'halfDiminished7']
        : ['major', 'minor', 'minor', 'major', 'major', 'minor', 'diminished'];
      const roman = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii'];
      const progressionEvents = progression.flatMap((degree, index) => {
        const chordRoot = rootMidi + scales.major.steps[degree - 1]!;
        return block(
          chordNotes(chordRoot, qualities[degree - 1]!, 0, jazz && random() < 0.5),
          1.5 + index * 1.2,
          1,
        );
      });
      Object.assign(exercise, {
        kind: 'progression',
        prompt: `First, the tonic chord in ${noteName(root)} major. Then identify the ${progression.length} chord functions by scale-degree number or Roman numeral. Individual chord qualities are not graded.`,
        cue: `In ${noteName(root)} major, name all ${length} chord functions after the tonic reference.`,
        expected: { progression },
        required: ['progression'],
        label: progression.map((degree) => roman[degree - 1]).join(' - '),
        explanation: `The root functions are ${progression.join(', ')} in ${noteName(root)} major${jazz ? ', voiced as diatonic seventh chords' : ''}.`,
        hints: [
          'Listen to the bass movement against the tonic chord at the beginning.',
          `The first chord of the question is built on degree ${progression[0]}.`,
          `The final chord is built on degree ${progression[progression.length - 1]}.`,
        ],
      });
      exercise.audio = audio(
        [
          ...block(chordNotes(rootMidi, jazz ? 'major7' : 'major'), 0, 0.9, 'reference'),
          ...progressionEvents,
        ],
        instrument,
      );
      break;
    }
    default:
      throw new Error(`No generator implemented for ${skillId}.`);
  }
  if (target.format === 'complete') {
    const sequence =
      exercise.kind === 'melody' ? exercise.expected.melody : exercise.expected.progression;
    if (!sequence) throw new Error('Completion is supported only for a musical sequence.');
    sequenceTask(exercise, 1 + Math.floor(random() * (sequence.length - 1)));
  }
  return exercise;
}

export function exerciseFingerprint(exercise: Exercise): string {
  return `${exercise.kind}:${exercise.audio.events.map(({ midi, at }) => `${midi}@${at.toFixed(2)}`).join(',')}`;
}

export function arpeggiate(plan: AudioPlan): AudioPlan {
  const reference = plan.events.filter((note) => note.role === 'reference');
  const target = plan.events.filter((note) => note.role === 'exercise');
  const onset = Math.min(...target.map((note) => note.at));
  const events = [
    ...reference,
    ...target.map((note, index) => ({ ...note, at: onset + index * 0.32, duration: 0.9 })),
  ];
  return audio(events, plan.instrument);
}

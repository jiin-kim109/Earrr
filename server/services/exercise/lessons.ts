import {
  chordNotes,
  chords,
  intervalNames,
  intervalNoteNames,
  inversionNames,
  noteName,
  scales,
} from './music.js';
import { intervalLessons } from './catalog.js';
import type {
  LessonExample,
  LessonNotes,
  AudioPlan,
  ChordQuality,
  Instrument,
  NoteEvent,
  ScaleId,
  SkillId,
  TeachingStep,
} from '../../../shared/types/course.js';

export const lessonNotes: Record<SkillId, LessonNotes> = {
  'pitch-direction': {
    introduction: 'Compare two notes. Decide whether the second is higher or lower.',
    listenFor:
      'Follow the height of the sound, not its loudness. Hold the first note in your mind as the second begins.',
    answers: 'Up or down',
  },
  'intervals-foundation': {
    introduction:
      'Recognize five essential intervals. Each question plays two notes, rising or falling at random.',
    listenFor:
      'The starting note, register, and direction change at random. Hold the first note in mind and hear the distance to the second. No simultaneous notes yet.',
    answers: 'Minor third, major third, perfect fourth, perfect fifth, or octave',
  },
  'intervals-harmonic': {
    introduction:
      'Recognize the same five intervals when both notes start together, rather than one after the other.',
    listenFor:
      'Listen inside the combined sound for its lower and upper notes. The root and register change, but every pair is simultaneous.',
    answers: 'Minor third, major third, perfect fourth, perfect fifth, or octave',
  },
  'intervals-chromatic': {
    introduction:
      'Recognize every distance inside an octave, including the closely spaced seconds and sevenths.',
    listenFor:
      'Compare neighboring distances. A semitone difference can change the character of an interval.',
    answers: 'The interval name, such as minor second or major sixth',
  },
  'reference-pitch': {
    introduction:
      'Use the first note, C4, to name the note that follows. This is relative pitch, not a perfect-pitch test.',
    listenFor:
      'Hear the interval from the reference, then translate that distance into a note name. Equivalent sharp and flat names are accepted.',
    answers: 'A note name, such as D, F sharp, or B flat',
  },
  triads: {
    introduction: 'A triad has three chord tones. Here you only need to tell major from minor.',
    listenFor:
      'The third determines the difference. Compare the two examples, then try the same relationship on fresh roots.',
    answers: 'Major or minor. You do not need to name the root.',
  },
  'triad-colors': {
    introduction: 'Add diminished, augmented, and suspended chords to your harmonic vocabulary.',
    listenFor:
      'Separate the shape of the third and fifth. A suspended chord replaces the third with a second or fourth.',
    answers: 'Major, minor, diminished, augmented, sus2, or sus4',
  },
  'triad-inversions': {
    introduction: 'A chord can keep its quality while a different chord tone moves into the bass.',
    listenFor:
      'Identify major or minor first. Then decide whether the lowest note is the root, third, or fifth.',
    answers: 'Quality plus root position, first inversion, or second inversion',
  },
  'chord-roots': {
    introduction:
      'Combine root naming with major/minor recognition. C4 sounds first as a reference.',
    listenFor:
      'Find the root relative to C, then listen to the quality independently. Both parts matter here.',
    answers: 'A root and quality, such as E minor',
  },
  'scale-degrees': {
    introduction:
      'A short cadence establishes a major key. Identify the single note by its position in that key.',
    listenFor:
      'The last chord of the introduction is home. Compare the target with that tonic, rather than guessing its absolute pitch.',
    answers: '1 to 7, or do, re, mi, fa, sol, la, ti',
  },
  scales: {
    introduction:
      'Recognize major, minor, pentatonic, and blues scales by their patterns of steps.',
    listenFor:
      'Count the different notes and notice where half steps appear. The tonic sounds first.',
    answers: 'Major, natural/harmonic/melodic minor, major/minor pentatonic, or blues',
  },
  modes: {
    introduction:
      'Hear the characteristic degrees of each mode. Some questions compare a major scale with a second scale on the same tonic; name the second one.',
    listenFor:
      'Listen for a characteristic degree: Dorian has a natural sixth, Lydian a raised fourth, and Mixolydian a lowered seventh.',
    answers: 'Dorian, Phrygian, Lydian, Mixolydian, Locrian, or whole tone',
  },
  melodies: {
    introduction:
      'Hear a short melody after a cadence. Either recall the whole phrase as scale degrees, or identify one missing degree with the other positions given.',
    listenFor:
      'Hear the overall shape first, then locate its starting note relative to home. Rhythm is not graded.',
    answers: 'A sequence such as 1, 3, 2 or do, mi, re',
  },
  'seventh-chords': {
    introduction:
      'Add a fourth voice to a triad. Distinguish major, minor, and dominant seventh chords.',
    listenFor:
      'Identify the triad, then the seventh. A major triad with a minor seventh is dominant, not major seventh.',
    answers: 'Major seventh, minor seventh, or dominant seventh',
  },
  'seventh-colors': {
    introduction:
      'Distinguish seventh-chord colors. Some questions first play a named foundation, then a changed chord on the same root. Identify the second chord; others play just one.',
    listenFor:
      'Hear the fifth and seventh separately. Half-diminished and fully diminished chords differ in their seventh.',
    answers: 'Major7, minor7, dominant7, half-diminished7, diminished7, or minor-major7',
  },
  'seventh-inversions': {
    introduction: 'Recognize seventh-chord quality and which of its four tones is in the bass.',
    listenFor:
      'The seventh in the bass creates third inversion. Separate that bass relationship from the chord quality.',
    answers: 'Quality and root position, first, second, or third inversion',
  },
  progressions: {
    introduction:
      'After a tonic reference, follow three to five chord functions. Some questions give you all but one function; others ask for the whole sequence.',
    listenFor:
      'Track the roots relative to home. Identify the sequence after the reference chord, not the reference itself.',
    answers: 'Degree numbers or Roman numerals, such as 1, 4, 5, 1',
  },
  'jazz-progressions': {
    introduction:
      'Follow diatonic seventh-chord movement. Identify the missing function in a given sequence, or recall the whole progression after its tonic reference.',
    listenFor:
      'Use the bass and the pull of guide tones to hear function. Upper voicings can change without changing the root movement.',
    answers: 'Degree numbers or Roman numerals, such as ii, V, I',
  },
  'added-tones': {
    introduction:
      'Hear sixths and added ninths without assuming a seventh. Some questions compare a named triad with the colored chord; identify the second chord.',
    listenFor:
      'Identify the triad underneath the added note. Add2 and add9 are equivalent names for grading.',
    answers: 'Major6, minor6, add2/add9, or minor add9',
  },
  extensions: {
    introduction:
      'Hear ninths, elevenths, and thirteenths. Some questions compare a named seventh chord with its extended version; name the second chord. Others test it on its own.',
    listenFor:
      'Identify the foundation and the highest added color. These teaching voicings keep the important tones audible.',
    answers: 'Major/minor/dominant ninth or thirteenth; minor or dominant eleventh',
  },
  'altered-dominants': {
    introduction:
      'Identify the specific alteration in a dominant chord. Some questions compare a plain dominant seventh with the altered version; others play the altered chord alone.',
    listenFor:
      'Distinguish altered fifths from upper tensions. Sharp-eleventh and flat-thirteenth examples retain the natural fifth.',
    answers: '7b9, 7#9, 7b5, 7#5, 7#11, 7b13, or 7alt',
  },
};

export function lessonExamples(skillId: SkillId, instrument: Instrument): LessonExample[] {
  return teachingSteps(skillId, instrument).flatMap((step) =>
    step.audio
      ? [
          {
            stepId: step.id,
            label: step.demoLabel ?? step.title,
            explanation: step.narration,
            audio: step.audio,
          },
        ]
      : [],
  );
}

function note(
  midi: number,
  at: number,
  duration = 0.7,
  role: NoteEvent['role'] = 'exercise',
): NoteEvent {
  return { midi, at, duration, role, velocity: 0.7 };
}
function block(midis: number[], at = 0.2, duration = 1.6, role: NoteEvent['role'] = 'exercise') {
  return midis.map((midi) => note(midi, at, duration, role));
}
function plan(events: NoteEvent[], instrument: Instrument): AudioPlan {
  return {
    events,
    instrument,
    duration: Math.max(...events.map((item) => item.at + item.duration)) + 0.35,
  };
}
export function cadence(root: number): NoteEvent[] {
  return [0, 5, 7, 0].flatMap((offset, index) =>
    chordNotes(root + offset, 'major').map((midi, voice) => ({
      midi,
      at: index * 0.6,
      duration: 0.5,
      role: 'reference' as const,
      velocity: voice === 0 ? 0.75 : 0.62,
    })),
  );
}
function melodicPair(semitones: number, at = 0.15) {
  return [note(60, at), note(60 + semitones, at + 1)];
}

export function teachingSteps(skillId: SkillId, instrument: Instrument): TeachingStep[] {
  const notes = lessonNotes[skillId];
  const steps: TeachingStep[] = [
    {
      id: 'overview',
      title: 'Let us learn the sound',
      narration: notes.introduction,
    },
  ];
  const demo = (id: string, title: string, narration: string, events: NoteEvent[]) =>
    steps.push({ id, title, demoLabel: title, narration, audio: plan(events, instrument) });
  const chord = (quality: ChordQuality, introduction?: string, inversion = 0) => {
    const definition = chords[quality];
    const position = ['triad-inversions', 'seventh-inversions'].includes(skillId);
    const title = `C ${definition.name}${position ? `, ${inversionNames[inversion]}` : ''}`;
    demo(
      `${quality}-${inversion}`,
      title,
      `${introduction ?? definition.color} Listen to ${title}.`,
      block(chordNotes(60, quality, inversion)),
    );
  };

  switch (skillId) {
    case 'pitch-direction':
      demo(
        'up',
        'Moving up',
        'These notes move up. The second is higher, regardless of its loudness.',
        melodicPair(4),
      );
      demo(
        'down',
        'Moving down',
        'Now they move down. Follow the pitch falling from the first note to the second.',
        [note(64, 0.15), note(60, 1.15)],
      );
      break;
    case 'intervals-foundation':
    case 'intervals-harmonic':
    case 'intervals-chromatic': {
      const { distances } = intervalLessons[skillId];
      const harmonic = skillId === 'intervals-harmonic';
      const melodic = skillId === 'intervals-foundation';
      steps[0]!.narration = harmonic
        ? 'Hear the five familiar intervals with both notes together. Listen for the lower and upper pitch inside the combined sound. These examples use C4.'
        : melodic
          ? 'An interval is the distance between two notes. One semitone is an adjacent piano key. Each C4 example rises, then falls; its interval name stays the same.'
          : 'Add seconds, the tritone, sixths and sevenths to the intervals you already know. C4 examples play separately, then together; practice includes all twelve distances.';
      const newDistances =
        skillId === 'intervals-chromatic'
          ? distances.filter(
              (distance) =>
                !intervalLessons['intervals-foundation'].distances.some(
                  (known) => known === distance,
                ),
            )
          : distances;
      for (const distance of newDistances) {
        const name = intervalNames[distance]!;
        const pitches = intervalNoteNames(60, 60 + distance);
        const events = harmonic
          ? block([60, 60 + distance])
          : melodic
            ? [...melodicPair(distance), note(60 + distance, 2.55), note(60, 3.55)]
            : [...melodicPair(distance), ...block([60, 60 + distance], 2.4, 1.25)];
        demo(
          name.replaceAll(' ', '-'),
          name,
          `A ${name} spans ${distance} ${distance === 1 ? 'semitone' : 'semitones'}: ${pitches.join(' to ')}.${distance === 12 ? ' Same note name, one octave apart.' : ''}`,
          events,
        );
      }
      break;
    }
    case 'reference-pitch':
      demo(
        'reference-d',
        'C reference, then D',
        'Listen to C followed by D, two semitones higher. Hear the interval first, then translate it into the target note name.',
        [note(60, 0.1, 0.7, 'reference'), note(62, 1.4)],
      );
      demo(
        'reference-b',
        'C reference, then B',
        'Here the target is B below C. It is one semitone down. The register may change in practice; the reference remains C.',
        [note(60, 0.1, 0.7, 'reference'), note(59, 1.4)],
      );
      break;
    case 'triads':
      chord(
        'major',
        'A triad has a root, a third, and a fifth. A major third above the root gives this chord its major quality.',
      );
      chord(
        'minor',
        'Keep the same root and fifth, but lower the third by one semitone. That changes the quality to minor.',
      );
      break;
    case 'triad-colors':
      for (const quality of ['diminished', 'augmented', 'sus2', 'sus4'] as const) chord(quality);
      break;
    case 'triad-inversions':
      for (const quality of ['major', 'minor'] as const)
        for (const inversion of quality === 'major' ? [0, 1, 2] : [1]) {
          chord(
            quality,
            `The quality is still ${quality}. The ${['root', 'third', 'fifth'][inversion]} is now the lowest chord tone, which makes this ${inversionNames[inversion]}.`,
            inversion,
          );
        }
      break;
    case 'chord-roots':
      for (const [root, quality] of [
        [62, 'minor'],
        [63, 'major'],
      ] as const) {
        const title = `${noteName(root)} ${quality}`;
        demo(
          `root-${root}`,
          title,
          `First, the C reference. The chord that follows is ${title}. Name both the root relative to C and the major or minor quality.`,
          [note(60, 0.1, 0.7, 'reference'), ...block(chordNotes(root, quality), 1.4)],
        );
      }
      break;
    case 'scale-degrees':
      for (let degree = 1; degree <= 7; degree++) {
        const syllable = ['do', 're', 'mi', 'fa', 'sol', 'la', 'ti'][degree - 1];
        demo(
          `degree-${degree}`,
          `Degree ${degree}: ${syllable}`,
          `The cadence establishes C major. The single note afterward is degree ${degree}, ${syllable}. ${degree === 1 ? 'This is the tonic, our point of rest.' : 'Compare it with the sense of home established by the final chord.'}`,
          [...cadence(60), note(60 + scales.major.steps[degree - 1]!, 3, 1.1)],
        );
      }
      break;
    case 'scales':
    case 'modes': {
      const pool: ScaleId[] =
        skillId === 'scales'
          ? [
              'major',
              'naturalMinor',
              'harmonicMinor',
              'melodicMinor',
              'majorPentatonic',
              'minorPentatonic',
              'blues',
            ]
          : ['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'wholeTone'];
      for (const id of pool) {
        const definition = scales[id];
        demo(
          id,
          definition.name,
          `${definition.clue} Here is the ${definition.name} scale, starting on C.`,
          [
            note(60, 0.1, 0.6, 'reference'),
            ...definition.steps.map((step, index) => note(60 + step, 1.1 + index * 0.4, 0.35)),
          ],
        );
      }
      break;
    }
    case 'melodies':
      for (const melody of [
        [1, 2, 3],
        [1, 3, 5],
        [1, 3, 2],
      ]) {
        demo(
          `melody-${melody.join('-')}`,
          `Degrees ${melody.join(', ')}`,
          `After the cadence, the melody is ${melody.join(', ')}. ${melody[1] === 2 ? 'It moves upward by neighboring scale steps.' : melody[2] === 5 ? 'It skips through the tonic triad.' : 'It rises to the third degree, then returns to the second.'} Hear the shape before naming each note.`,
          [
            ...cadence(60),
            ...melody.map((degree, index) =>
              note(60 + scales.major.steps[degree - 1]!, 3 + index * 0.6, 0.5),
            ),
          ],
        );
      }
      break;
    case 'seventh-chords':
      for (const quality of ['major7', 'minor7', 'dominant7'] as const) chord(quality);
      break;
    case 'seventh-colors':
      for (const quality of ['halfDiminished7', 'diminished7', 'minorMajor7'] as const)
        chord(quality);
      break;
    case 'seventh-inversions':
      for (let inversion = 0; inversion < 4; inversion++)
        chord(
          'dominant7',
          `This is the same C dominant seventh chord, with its ${['root', 'third', 'fifth', 'seventh'][inversion]} in the bass. That is ${inversionNames[inversion]}.`,
          inversion,
        );
      break;
    case 'added-tones':
      for (const quality of ['major6', 'minor6', 'add9', 'minorAdd9'] as const)
        chord(
          quality,
          quality === 'add9'
            ? 'A major triad with an added ninth, and no seventh. Add2 names the same added-note color in a closer voicing.'
            : undefined,
        );
      break;
    case 'extensions':
      for (const quality of [
        'major9',
        'minor9',
        'dominant9',
        'dominant11',
        'minor11',
        'major13',
        'minor13',
        'dominant13',
      ] as const)
        chord(quality);
      break;
    case 'altered-dominants':
      chord(
        'dominant7',
        'First, remember the unaltered dominant seventh foundation. We will change its fifth or add altered upper tones.',
      );
      for (const quality of ['7b9', '7#9', '7b5', '7#5', '7#11', '7b13', '7alt'] as const)
        chord(quality);
      break;
    case 'progressions':
    case 'jazz-progressions': {
      const jazz = skillId === 'jazz-progressions';
      const qualities: ChordQuality[] = jazz
        ? ['major7', 'minor7', 'minor7', 'major7', 'dominant7', 'minor7', 'halfDiminished7']
        : ['major', 'minor', 'minor', 'major', 'major', 'minor', 'diminished'];
      const sequences = jazz
        ? [
            [2, 5, 1],
            [1, 6, 2, 5],
          ]
        : [
            [1, 4, 5, 1],
            [1, 6, 4, 5],
          ];
      for (const sequence of sequences) {
        demo(
          `progression-${sequence.join('-')}`,
          `Functions ${sequence.join(', ')}`,
          `The first chord is just the tonic reference. After it, the chord functions are ${sequence.join(', ')}. Listen to the roots moving relative to home${jazz ? ', through the colors of seventh chords' : ''}. Do not include the reference in your answer.`,
          [
            ...block(chordNotes(48, jazz ? 'major7' : 'major'), 0.1, 0.8, 'reference'),
            ...sequence.flatMap((degree, index) =>
              block(
                chordNotes(48 + scales.major.steps[degree - 1]!, qualities[degree - 1]!),
                1.5 + index * 1.3,
                1.1,
              ),
            ),
          ],
        );
      }
      break;
    }
  }
  steps.push({
    id: 'ready-for-practice',
    title: 'Ready to practice?',
    narration: 'Ready to start the exercises?',
  });
  return steps;
}

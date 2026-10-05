import {
  chordNotes,
  chordSymbol,
  chords,
  intervalNames,
  intervalNoteNames,
  inversionNames,
  noteName,
  scales,
} from './music.js';
import {
  chordPools,
  functionPools,
  intervalLessons,
  isInversionLesson,
  isSeventhInversion,
  scalePools,
} from './catalog.js';
import type {
  LessonExample,
  LessonNotes,
  AudioPlan,
  ChordQuality,
  Instrument,
  NoteEvent,
  SkillId,
  TeachingStep,
} from '../../../shared/types/course.js';

const notes = (introduction: string, listenFor: string, answers: string): LessonNotes => ({
  introduction,
  listenFor,
  answers,
});
export const lessonNotes: Record<SkillId, LessonNotes> = {
  'pitch-direction': notes(
    'Compare two notes. Decide whether the second is higher or lower.',
    'Follow the height of the sound, not its loudness. Hold the first note in your mind as the second begins.',
    'Up or down',
  ),
  'intervals-foundation': notes(
    'Recognize four essential intervals. Each question plays two notes, rising or falling at random.',
    'The starting note, register, and direction change at random. Hold the first note in mind and hear the distance to the second. No simultaneous notes yet.',
    'Minor third, major third, perfect fifth, or octave',
  ),
  'intervals-harmonic': notes(
    'Recognize the same four intervals when both notes start together, rather than one after the other.',
    'Listen inside the combined sound for its lower and upper notes. The root and register change, but every pair is simultaneous.',
    'Minor third, major third, perfect fifth, or octave',
  ),
  'intervals-chromatic': notes(
    'Retired chromatic interval lesson.',
    'Review saved examples only.',
    'Interval name',
  ),
  'reference-pitch': notes(
    'Retired reference-pitch lesson.',
    'Reference-based root naming is introduced later.',
    'Note name',
  ),
  melodies: notes('Retired melodic recall lesson.', 'Review saved examples only.', 'Scale degrees'),
  'jazz-progressions': notes(
    'Retired separate jazz-progression lesson.',
    'Seventh-chord progressions now share the guided progression chapter.',
    'Chord functions',
  ),
  triads: notes(
    'A triad has three chord tones. Here you only need to tell major from minor.',
    'The third determines the difference. Compare the two examples, then try the same relationship on fresh roots.',
    'Major or minor. You do not need to name the root.',
  ),
  'triad-colors': notes(
    'You know major and minor. Now add diminished and augmented, two ways to change the fifth. Practice uses these four qualities.',
    'A lowered fifth contracts the chord; a raised fifth gives it a wider, unsettled color.',
    'Major, minor, diminished, or augmented',
  ),
  'suspended-chords': notes(
    'A sus4 chord replaces the third with the fourth. Hear that suspended color among major, minor, diminished and augmented.',
    'The fourth replaces the third rather than being added above it.',
    'Major, minor, diminished, augmented, or sus4',
  ),
  'scale-degrees': notes(
    'A cadence establishes home, or do. Find one of three anchors: do, mi or sol, the first, third and fifth degrees of the major scale.',
    'Hold the final tonic chord in mind while you compare the target note.',
    'Do, mi, or sol: 1, 3, or 5',
  ),
  scales: notes(
    'Compare natural, harmonic and ascending melodic minor. They share a minor third; listen especially to the sixth and seventh notes.',
    'Natural minor keeps both low. Harmonic minor raises the seventh; ascending melodic minor raises both.',
    'Natural minor, harmonic minor, or ascending melodic minor',
  ),
  modes: notes(
    'Both modes have a major third. Lydian raises the fourth; Mixolydian lowers the seventh. Hear one changed note rather than memorizing a completely new scale.',
    'Compare the characteristic tone with a major scale on the same tonic.',
    'Lydian or Mixolydian',
  ),
  'minor-modes': notes(
    'Three modes have a minor third. Dorian has a natural sixth, Phrygian a low second, and Locrian also lowers the fifth. Learn their characteristic sounds separately.',
    'Use the familiar natural minor scale as a reference.',
    'Dorian, Phrygian, or Locrian',
  ),
  'chord-roots': notes(
    'The root names the chord. Hear C4 first, then a root-position chord. Find its lowest note and major or minor quality. Roots here are C, D, E, F and G.',
    'The reference is not part of your answer. All target roots are in the same octave above C4.',
    'A root and quality, such as EM or Em',
  ),
  'triad-inversions': notes(
    'Keep a major chord, but change its lowest note. Identify root position, first inversion or second inversion. The quality is supplied.',
    'Root, third and fifth can each be the lowest note without changing major quality.',
    'Root position, first inversion, or second inversion',
  ),
  'minor-inversions': notes(
    'Use the same three bass positions with a minor triad. Listen for the root, minor third or fifth as its lowest note; the quality is supplied.',
    'Separate the lowest note from the chord above it.',
    'Root position, first inversion, or second inversion',
  ),
  'seventh-chords': notes(
    'Add a fourth tone to a triad. Distinguish major seventh, minor seventh and dominant seventh by their third and seventh.',
    'M7 has a major seventh; m7 has a minor third and seventh; 7 combines a major third with a minor seventh.',
    'M7, m7, or 7',
  ),
  'seventh-colors': notes(
    'Start with minor seventh. Lower its fifth for half-diminished, then lower the seventh too for fully diminished. Practice distinguishes these three colors.',
    'm7b5 and dim7 share the lowered fifth but have different sevenths.',
    'm7, m7b5, or dim7',
  ),
  'major-functions': notes(
    'Roman numerals name chord roots within a key: I is one, IV four, V five. Hear home, a move away, then the pull back, after a tonic reference.',
    'Find the chord root relative to home before judging its color.',
    'I, IV, or V',
  ),
  'minor-functions': notes(
    'Lowercase numerals indicate minor quality: ii is two, iii three, vi six. Hear their minor seventh chords against a tonic reference, comparing the bass with home.',
    'Their bass distance from home distinguishes these three minor seventh chords.',
    'ii, iii, or vi',
  ),
  cadences: notes(
    'Begin with ii–V–I: preparation, tension, home. Then hear other short paths using familiar functions. The first and last are given; identify only the middle chord.',
    'Use both the bass movement and the pull toward the given ending.',
    'One missing function: ii, IV, V, or vi',
  ),
  progressions: notes(
    'Listen to four familiar seventh-chord functions. The starting and ending chords are given. Identify only the one or two missing middle functions.',
    'Keep the endpoints in mind and listen to the middle bass notes in order.',
    'Only the missing functions, such as ii or ii, V',
  ),
  'seventh-inversions': notes(
    'Keep a dominant seventh quality. Identify whether its root, third, fifth or seventh is the lowest note. The root and quality are supplied.',
    'The seventh in the bass gives third inversion.',
    'Root position, first, second, or third inversion',
  ),
  'seventh-color-inversions': notes(
    'Use all four bass positions with major and minor seventh chords. The quality is given, so only the lowest chord tone determines your answer.',
    'A seventh in the bass is third inversion in either quality.',
    'Root position, first, second, or third inversion',
  ),
  'added-tones': notes(
    'Add a ninth to a major or minor triad, without a seventh. Compare Cadd9 and Cmadd9; the third still identifies the family.',
    'An added ninth does not imply a seventh.',
    'add9 or minor add9; add2 is accepted as the same quality',
  ),
  'sixth-chords': notes(
    'Add a sixth instead of a seventh to major and minor triads. Hear the difference between C6 and Cm6 through their third.',
    'The sixth adds color without the close seventh-to-root tension.',
    'Major sixth or minor sixth',
  ),
  extensions: notes(
    'A ninth chord includes a seventh, unlike add9. Distinguish major ninth, minor ninth and dominant ninth by the familiar foundation under the added note.',
    'Hear the seventh quality beneath the ninth.',
    'M9, m9, or 9',
  ),
  elevenths: notes(
    'Begin with a minor ninth, then add the eleventh. Compare Cm9 and Cm11; listen for the new upper fourth rather than a completely new chord.',
    'The eleventh is a fourth above the root in the next octave.',
    'Minor ninth or minor eleventh',
  ),
  thirteenths: notes(
    'A thirteenth adds an upper sixth to a ninth chord. Distinguish major, minor and dominant foundations; these voicings omit the eleventh.',
    'Hear the familiar seventh quality underneath the upper sixth.',
    'M13, m13, or 13',
  ),
  'altered-dominants': notes(
    'Keep a dominant seventh foundation. Hear its added ninth lowered or raised by one semitone: flat nine or sharp nine.',
    'The altered ninth is above the unchanged major third and minor seventh.',
    '7b9 or 7#9',
  ),
  'altered-fifths': notes(
    'Keep a dominant seventh and change its fifth. Compare a lowered fifth with a raised fifth; no natural fifth remains in either voicing.',
    'The altered note replaces the fifth rather than adding a separate upper color.',
    '7b5 or 7#5',
  ),
  'upper-alterations': notes(
    'These dominant chords retain the natural fifth. Hear a sharp eleventh or flat thirteenth above it, rather than confusing them with altered fifths.',
    'The natural fifth remains underneath the alteration.',
    '7#11 or 7b13',
  ),
};

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
const melodicPair = (semitones: number, at = 0.15) => [note(60, at), note(60 + semitones, at + 1)];

export function teachingSteps(skillId: SkillId, instrument: Instrument): TeachingStep[] {
  const steps: TeachingStep[] = [
    {
      id: 'overview',
      title: 'Let us learn the sound',
      narration: lessonNotes[skillId].introduction,
    },
  ];
  const demo = (id: string, title: string, narration: string, events: NoteEvent[]) =>
    steps.push({ id, title, demoLabel: title, narration, audio: plan(events, instrument) });
  const chord = (quality: ChordQuality, introduction?: string, inversion = 0) => {
    const definition = chords[quality];
    const position = isInversionLesson(skillId);
    const title = `C ${definition.name}${position ? `, ${inversionNames[inversion]}` : ''}`;
    demo(
      `${quality}-${inversion}`,
      title,
      `${introduction ?? definition.color} Hear ${title}.`,
      block(chordNotes(60, quality, inversion)),
    );
  };

  if (skillId === 'pitch-direction') {
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
  } else if (
    skillId === 'intervals-foundation' ||
    skillId === 'intervals-harmonic' ||
    skillId === 'intervals-chromatic'
  ) {
    const harmonic = skillId === 'intervals-harmonic';
    const melodic = skillId === 'intervals-foundation';
    steps[0]!.narration = harmonic
      ? 'Hear the four familiar intervals with both notes together. Listen for the lower and upper pitch inside the combined sound. These examples use C4.'
      : melodic
        ? 'An interval is the distance between two notes. One semitone is an adjacent piano key. Each C4 example rises, then falls; its interval name stays the same.'
        : 'Review the chromatic interval examples.';
    for (const distance of intervalLessons[skillId].distances) {
      const name = intervalNames[distance]!;
      const pitches = intervalNoteNames(60, 60 + distance);
      demo(
        name.replaceAll(' ', '-'),
        name,
        `A ${name} spans ${distance} ${distance === 1 ? 'semitone' : 'semitones'}: ${pitches.join(' to ')}.${distance === 12 ? ' Same note name, one octave apart.' : ''}`,
        harmonic
          ? block([60, 60 + distance])
          : melodic
            ? [...melodicPair(distance), note(60 + distance, 2.55), note(60, 3.55)]
            : [...melodicPair(distance), ...block([60, 60 + distance], 2.4, 1.25)],
      );
    }
  } else if (skillId === 'triads') {
    chord(
      'major',
      'A triad has a root, a third, and a fifth. A major third above the root gives this chord its major quality.',
    );
    chord(
      'minor',
      'Keep the same root and fifth, but lower the third by one semitone. That changes the quality to minor.',
    );
    const examples = [
      {
        root: 60,
        quality: 'major' as const,
        narration:
          'C major often feels open and bright. Hear the wider major third within the chord.',
      },
      {
        root: 60,
        quality: 'minor' as const,
        narration:
          'C minor can feel softer or more pensive. Only the third moved down; the root and fifth stayed.',
      },
      {
        root: 64,
        quality: 'major' as const,
        narration:
          'Now E major. The whole chord is higher, but the same bright, open relationship remains.',
      },
      {
        root: 64,
        quality: 'minor' as const,
        narration:
          'E minor keeps that root and lowers its third. Mood is a useful clue, not an absolute rule.',
      },
    ].map((example) => ({
      ...example,
      title: chordSymbol(example.root, example.quality),
      audio: plan(block(chordNotes(example.root, example.quality)), instrument),
    }));
    steps.push({
      id: 'character',
      title: 'Major & minor character',
      narration: examples[0]!.narration,
      demoLabel: examples[0]!.title,
      audio: examples[0]!.audio,
      examples,
    });
  } else if (skillId === 'chord-roots') {
    for (const [root, quality, explanation] of [
      [
        60,
        'major',
        'C4 is the reference, then C major. The lowest chord tone matches C: its root.',
      ],
      [
        64,
        'minor',
        'C4 is the reference, then E minor. The bass is a major third above C, so the root is E; the chord itself has a minor third.',
      ],
      [
        67,
        'major',
        'C4 is the reference, then G major. Hear a fifth from C to the bass G, then identify the major quality.',
      ],
    ] as const)
      demo(`root-${root}`, chordSymbol(root, quality), explanation, [
        note(60, 0.1, 0.7, 'reference'),
        ...block(chordNotes(root, quality), 1.4),
      ]);
  } else if (skillId === 'scale-degrees') {
    for (const [degree, syllable, clue] of [
      [1, 'do', 'This is home, the note on which the cadence settles.'],
      [3, 'mi', 'This major third above home gives the tonic triad its major color.'],
      [5, 'sol', 'This is the fifth above home, a stable upper anchor.'],
    ] as const)
      demo(
        `degree-${degree}`,
        `${degree}: ${syllable}`,
        `${clue} Hear the cadence, then ${syllable}.`,
        [...cadence(60), note(60 + scales.major.steps[degree - 1]!, 3, 1.1)],
      );
  } else if (scalePools[skillId]) {
    for (const id of scalePools[skillId]!) {
      const definition = scales[id];
      demo(id, definition.name, `${definition.clue} Hear ${definition.name}, starting on C.`, [
        note(60, 0.1, 0.6, 'reference'),
        ...definition.steps.map((step, index) => note(60 + step, 1.1 + index * 0.4, 0.35)),
      ]);
    }
  } else if (functionPools[skillId]) {
    const qualities: ChordQuality[] = [
      'major7',
      'minor7',
      'minor7',
      'major7',
      'dominant7',
      'minor7',
    ];
    for (const degree of functionPools[skillId]!) {
      const root = 60 + scales.major.steps[degree - 1]!;
      const quality = qualities[degree - 1]!;
      demo(
        `function-${degree}`,
        `Function ${degree}: ${chordSymbol(root, quality)}`,
        `First C major seventh, our home. Then ${noteName(root)} ${chords[quality].name}, built on degree ${degree} in C major.`,
        [
          ...block(chordNotes(60, 'major7'), 0.1, 0.9, 'reference'),
          ...block(chordNotes(root, quality), 1.5),
        ],
      );
    }
  } else if (
    skillId === 'cadences' ||
    skillId === 'progressions' ||
    skillId === 'jazz-progressions'
  ) {
    const qualities: ChordQuality[] = [
      'major7',
      'minor7',
      'minor7',
      'major7',
      'dominant7',
      'minor7',
    ];
    const sequences =
      skillId === 'cadences'
        ? [
            [2, 5, 1],
            [1, 4, 5],
          ]
        : [
            [1, 6, 2, 5],
            [1, 4, 5, 1],
          ];
    for (const sequence of sequences)
      demo(
        `progression-${sequence.join('-')}`,
        sequence.map((degree) => ['I', 'ii', 'iii', 'IV', 'V', 'vi'][degree - 1]).join(' – '),
        sequence.join() === '2,5,1'
          ? 'Hear ii–V–I: D minor seventh prepares G dominant seventh, which resolves to C major seventh. This is preparation, tension, then home.'
          : `After the tonic reference, the functions are ${sequence.join(', ')}. Follow the bass between the starting and ending chords.`,
        [
          ...block(chordNotes(48, 'major7'), 0.1, 0.8, 'reference'),
          ...sequence.flatMap((degree, index) =>
            block(
              chordNotes(48 + scales.major.steps[degree - 1]!, qualities[degree - 1]!),
              1.5 + index * 1.3,
              1.1,
            ),
          ),
        ],
      );
  } else if (isInversionLesson(skillId)) {
    const positions = isSeventhInversion(skillId) ? 4 : 3;
    for (let inversion = 0; inversion < positions; inversion++) {
      const pool = chordPools[skillId]!;
      const quality = pool[inversion % pool.length]!;
      chord(
        quality,
        `The ${['root', 'third', 'fifth', 'seventh'][inversion]} is the lowest note. This is ${inversionNames[inversion]}.`,
        inversion,
      );
    }
  } else if (chordPools[skillId]) {
    const demos: readonly ChordQuality[] =
      skillId === 'triad-colors'
        ? ['diminished', 'augmented']
        : skillId === 'suspended-chords'
          ? ['major', 'sus4']
          : chordPools[skillId]!;
    for (const quality of demos) chord(quality);
  }
  steps.push({
    id: 'ready-for-practice',
    title: 'Ready to practice?',
    narration: 'Ready to start the exercises?',
  });
  return steps;
}

export function lessonExamples(skillId: SkillId, instrument: Instrument): LessonExample[] {
  return teachingSteps(skillId, instrument).flatMap((step) =>
    step.examples
      ? step.examples.map((example) => ({
          stepId: step.id,
          label: example.title,
          explanation: example.narration,
          audio: example.audio,
        }))
      : step.audio
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

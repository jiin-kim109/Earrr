import type { ChordQuality, ScaleId } from '../../../shared/types/course.js';

interface ChordDefinition {
  name: string;
  suffix: string;
  intervals: readonly number[];
  family: 'major' | 'minor' | 'diminished' | 'augmented' | 'suspended' | 'dominant';
  color: string;
}

export const chords: Record<ChordQuality, ChordDefinition> = {
  major: {
    name: 'major',
    suffix: 'M',
    intervals: [0, 4, 7],
    family: 'major',
    color: 'A major third and a perfect fifth.',
  },
  minor: {
    name: 'minor',
    suffix: 'm',
    intervals: [0, 3, 7],
    family: 'minor',
    color: 'A minor third and a perfect fifth.',
  },
  diminished: {
    name: 'diminished',
    suffix: 'dim',
    intervals: [0, 3, 6],
    family: 'diminished',
    color: 'Two stacked minor thirds form a diminished fifth.',
  },
  augmented: {
    name: 'augmented',
    suffix: 'aug',
    intervals: [0, 4, 8],
    family: 'augmented',
    color: 'Two stacked major thirds form an augmented fifth.',
  },
  sus2: {
    name: 'suspended second',
    suffix: 'sus2',
    intervals: [0, 2, 7],
    family: 'suspended',
    color: 'The second replaces the third.',
  },
  sus4: {
    name: 'suspended fourth',
    suffix: 'sus4',
    intervals: [0, 5, 7],
    family: 'suspended',
    color: 'The fourth replaces the third.',
  },
  major7: {
    name: 'major seventh',
    suffix: 'M7',
    intervals: [0, 4, 7, 11],
    family: 'major',
    color: 'A major triad with a major seventh, one semitone below the octave.',
  },
  minor7: {
    name: 'minor seventh',
    suffix: 'm7',
    intervals: [0, 3, 7, 10],
    family: 'minor',
    color: 'A minor triad with a minor seventh.',
  },
  dominant7: {
    name: 'dominant seventh',
    suffix: '7',
    intervals: [0, 4, 7, 10],
    family: 'dominant',
    color: 'A major third and minor seventh create the dominant tritone.',
  },
  halfDiminished7: {
    name: 'half-diminished seventh',
    suffix: 'm7b5',
    intervals: [0, 3, 6, 10],
    family: 'diminished',
    color: 'A diminished triad with a minor seventh.',
  },
  diminished7: {
    name: 'diminished seventh',
    suffix: 'dim7',
    intervals: [0, 3, 6, 9],
    family: 'diminished',
    color: 'Three stacked minor thirds. The stated root resolves its symmetry.',
  },
  minorMajor7: {
    name: 'minor major seventh',
    suffix: 'm(maj7)',
    intervals: [0, 3, 7, 11],
    family: 'minor',
    color: 'A minor triad with a major seventh.',
  },
  major6: {
    name: 'major sixth',
    suffix: '6',
    intervals: [0, 4, 7, 9],
    family: 'major',
    color: 'A major triad plus the sixth, without a seventh.',
  },
  minor6: {
    name: 'minor sixth',
    suffix: 'm6',
    intervals: [0, 3, 7, 9],
    family: 'minor',
    color: 'A minor triad plus a major sixth.',
  },
  add2: {
    name: 'major add 2',
    suffix: 'add2',
    intervals: [0, 2, 4, 7],
    family: 'major',
    color:
      'A major triad with an added second and no seventh. Add2/add9 are accepted as equivalent chord names.',
  },
  add9: {
    name: 'major add 9',
    suffix: 'add9',
    intervals: [0, 4, 7, 14],
    family: 'major',
    color:
      'A major triad with an added ninth and no seventh. Add2/add9 are accepted as equivalent chord names.',
  },
  minorAdd9: {
    name: 'minor add 9',
    suffix: 'm(add9)',
    intervals: [0, 3, 7, 14],
    family: 'minor',
    color: 'A minor triad with an added ninth and no seventh.',
  },
  major9: {
    name: 'major ninth',
    suffix: 'M9',
    intervals: [0, 4, 7, 11, 14],
    family: 'major',
    color: 'A major seventh chord with a natural ninth.',
  },
  minor9: {
    name: 'minor ninth',
    suffix: 'm9',
    intervals: [0, 3, 7, 10, 14],
    family: 'minor',
    color: 'A minor seventh chord with a natural ninth.',
  },
  dominant9: {
    name: 'dominant ninth',
    suffix: '9',
    intervals: [0, 4, 7, 10, 14],
    family: 'dominant',
    color: 'A dominant seventh chord with a natural ninth.',
  },
  dominant11: {
    name: 'dominant eleventh',
    suffix: '11',
    intervals: [0, 4, 7, 10, 14, 17],
    family: 'dominant',
    color: 'This full teaching voicing includes the third, minor seventh, ninth, and eleventh.',
  },
  minor11: {
    name: 'minor eleventh',
    suffix: 'm11',
    intervals: [0, 3, 7, 10, 14, 17],
    family: 'minor',
    color: 'A minor ninth chord with a natural eleventh.',
  },
  major13: {
    name: 'major thirteenth',
    suffix: 'M13',
    intervals: [0, 4, 7, 11, 14, 21],
    family: 'major',
    color: 'Major seventh, ninth, and thirteenth; the eleventh is deliberately omitted.',
  },
  minor13: {
    name: 'minor thirteenth',
    suffix: 'm13',
    intervals: [0, 3, 7, 10, 14, 21],
    family: 'minor',
    color: 'Minor seventh, natural ninth, and major thirteenth; no eleventh in this voicing.',
  },
  dominant13: {
    name: 'dominant thirteenth',
    suffix: '13',
    intervals: [0, 4, 7, 10, 14, 21],
    family: 'dominant',
    color: 'A dominant ninth foundation with a thirteenth; no eleventh in this voicing.',
  },
  '7b9': {
    name: 'dominant seven flat nine',
    suffix: '7(b9)',
    intervals: [0, 4, 7, 10, 13],
    family: 'dominant',
    color: 'A dominant seventh with a ninth flattened to 13 semitones above the root.',
  },
  '7#9': {
    name: 'dominant seven sharp nine',
    suffix: '7(#9)',
    intervals: [0, 4, 7, 10, 15],
    family: 'dominant',
    color: "The raised ninth sits alongside the chord's major third.",
  },
  '7b5': {
    name: 'dominant seven flat five',
    suffix: '7(b5)',
    intervals: [0, 4, 6, 10],
    family: 'dominant',
    color: 'The perfect fifth is replaced with a diminished fifth.',
  },
  '7#5': {
    name: 'dominant seven sharp five',
    suffix: '7(#5)',
    intervals: [0, 4, 8, 10],
    family: 'dominant',
    color: 'The perfect fifth is replaced with an augmented fifth.',
  },
  '7#11': {
    name: 'dominant seven sharp eleven',
    suffix: '7(#11)',
    intervals: [0, 4, 7, 10, 18],
    family: 'dominant',
    color: 'A raised eleventh above a dominant seventh; the natural fifth remains audible.',
  },
  '7b13': {
    name: 'dominant seven flat thirteen',
    suffix: '7(b13)',
    intervals: [0, 4, 7, 10, 20],
    family: 'dominant',
    color: 'A lowered thirteenth above a dominant seventh; the natural fifth remains.',
  },
  '7alt': {
    name: 'altered dominant',
    suffix: '7alt',
    intervals: [0, 4, 8, 10, 13, 15],
    family: 'dominant',
    color: 'This altered voicing combines a sharp fifth with flat and sharp ninths.',
  },
};

export const scales: Record<ScaleId, { name: string; steps: readonly number[]; clue: string }> = {
  major: {
    name: 'major',
    steps: [0, 2, 4, 5, 7, 9, 11, 12],
    clue: 'Half steps lie between degrees 3-4 and 7-8.',
  },
  naturalMinor: {
    name: 'natural minor',
    steps: [0, 2, 3, 5, 7, 8, 10, 12],
    clue: 'A minor third, minor sixth, and minor seventh.',
  },
  harmonicMinor: {
    name: 'harmonic minor',
    steps: [0, 2, 3, 5, 7, 8, 11, 12],
    clue: 'Listen for the augmented second between degrees 6 and 7.',
  },
  melodicMinor: {
    name: 'melodic minor, ascending',
    steps: [0, 2, 3, 5, 7, 9, 11, 12],
    clue: 'A minor third with raised sixth and seventh degrees.',
  },
  majorPentatonic: {
    name: 'major pentatonic',
    steps: [0, 2, 4, 7, 9, 12],
    clue: 'Five tones; there are no half steps.',
  },
  minorPentatonic: {
    name: 'minor pentatonic',
    steps: [0, 3, 5, 7, 10, 12],
    clue: 'Five tones beginning with a minor third.',
  },
  blues: {
    name: 'minor blues',
    steps: [0, 3, 5, 6, 7, 10, 12],
    clue: 'Listen for the chromatic motion through the flat fifth.',
  },
  dorian: {
    name: 'Dorian',
    steps: [0, 2, 3, 5, 7, 9, 10, 12],
    clue: 'A minor sound with a natural sixth.',
  },
  phrygian: {
    name: 'Phrygian',
    steps: [0, 1, 3, 5, 7, 8, 10, 12],
    clue: 'The first step is only a semitone.',
  },
  lydian: {
    name: 'Lydian',
    steps: [0, 2, 4, 6, 7, 9, 11, 12],
    clue: 'A major sound with a raised fourth.',
  },
  mixolydian: {
    name: 'Mixolydian',
    steps: [0, 2, 4, 5, 7, 9, 10, 12],
    clue: 'A major sound with a lowered seventh.',
  },
  locrian: {
    name: 'Locrian',
    steps: [0, 1, 3, 5, 6, 8, 10, 12],
    clue: 'The lowered fifth distinguishes this from Phrygian.',
  },
  wholeTone: {
    name: 'whole tone',
    steps: [0, 2, 4, 6, 8, 10, 12],
    clue: 'Every adjacent distance is a whole step.',
  },
};

export const intervalNames = [
  'unison',
  'minor second',
  'major second',
  'minor third',
  'major third',
  'perfect fourth',
  'tritone',
  'perfect fifth',
  'minor sixth',
  'major sixth',
  'minor seventh',
  'major seventh',
  'octave',
] as const;
export const inversionNames = [
  'root position',
  'first inversion',
  'second inversion',
  'third inversion',
] as const;
export const pitchNames = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
] as const;

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}
export function noteName(midi: number, octave = false): string {
  return `${pitchNames[pitchClass(midi)]}${octave ? Math.floor(midi / 12) - 1 : ''}`;
}
export function chordSymbol(root: number, quality: ChordQuality) {
  return `${noteName(root)}${chords[quality].suffix}`.replace(/[()]/g, '');
}
export function midiFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function intervalNoteNames(first: number, second: number): [string, string] {
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  const distance = high - low;
  const natural = [0, 2, 4, 5, 7, 9, 11];
  const letters = 'CDEFGAB';
  const steps = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];
  const octave = Math.floor(low / 12) - 1;
  const names = [
    'C',
    'C#',
    'Db',
    'D',
    'D#',
    'Eb',
    'E',
    'F',
    'F#',
    'Gb',
    'G',
    'G#',
    'Ab',
    'A',
    'A#',
    'Bb',
    'B',
  ];
  let best: { pair: [string, string]; cost: number } | undefined;
  for (const name of names.filter((candidate) => parsePitch(candidate) === pitchClass(low))) {
    for (const step of distance % 12 === 6 ? [3, 4] : [steps[distance % 12]!]) {
      const position = letters.indexOf(name[0]!) + step + Math.floor(distance / 12) * 7;
      const upperOctave = octave + Math.floor(position / 7);
      const accidental = high - (12 * (upperOctave + 1) + natural[position % 7]!);
      const cost =
        name.length - 1 + Math.abs(accidental) + (name === pitchNames[pitchClass(low)] ? 0 : 0.01);
      if (!best || cost < best.cost) {
        const upper = `${letters[position % 7]}${accidental < 0 ? 'b'.repeat(-accidental) : '#'.repeat(accidental)}${upperOctave}`;
        best = { pair: [`${name}${octave}`, upper], cost };
      }
    }
  }
  if (!best) throw new Error('Cannot spell the played interval.');
  return first <= second ? best.pair : [best.pair[1], best.pair[0]];
}

export function parsePitch(value: string): number | null {
  const clean = value
    .trim()
    .replaceAll('♯', '#')
    .replaceAll('♭', 'b')
    .replace(/sharp/gi, '#')
    .replace(/flat/gi, 'b')
    .replaceAll(' ', '');
  const match = /^([a-g])([#b]{0,2})(?:-?\d)?$/i.exec(clean);
  if (!match) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]!.toUpperCase()];
  if (base === undefined) return null;
  const alteration = [...match[2]!].reduce((sum, item) => sum + (item === '#' ? 1 : -1), 0);
  return pitchClass(base + alteration);
}

export function chordNotes(
  root: number,
  quality: ChordQuality,
  inversion = 0,
  open = false,
): number[] {
  const intervals = chords[quality].intervals;
  if (!Number.isInteger(inversion) || inversion < 0 || inversion >= Math.min(4, intervals.length))
    throw new Error('Invalid chord inversion.');
  const notes = intervals.map((interval) => root + interval);
  for (let index = 0; index < inversion; index++) {
    const note = notes.shift()!;
    let raised = note + 12;
    while (raised <= notes[notes.length - 1]!) raised += 12;
    notes.push(raised);
  }
  if (open && notes.length >= 3) {
    notes[1] = notes[1]! + 12;
    notes.sort((a, b) => a - b);
  }
  return notes;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function choose<T>(random: () => number, items: readonly T[]): T {
  if (!items.length) throw new Error('Cannot choose from an empty collection.');
  return items[Math.floor(random() * items.length)]!;
}

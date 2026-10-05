import type { Skill, SkillId, ChordQuality, ScaleId } from '../../../shared/types/course.js';

export const welcome = {
  number: 0,
  name: 'Welcome',
  subtitle: 'Meet your ear-training tutor',
  label: 'Welcome',
} as const;

export const chapters = [
  {
    number: 1,
    name: 'Pitch & intervals',
    subtitle: 'Direction and essential distances',
    label: 'Foundations',
  },
  {
    number: 2,
    name: 'Chord colors',
    subtitle: 'Major, minor and their closest contrasts',
    label: 'Chord quality',
  },
  {
    number: 3,
    name: 'Scales & modes',
    subtitle: 'Tonal anchors and small scale families',
    label: 'Tonal hearing',
  },
  {
    number: 4,
    name: 'Roots & inversions',
    subtitle: 'Find the root, then hear the bass position',
    label: 'Chord positions',
  },
  {
    number: 5,
    name: 'Seventh chords',
    subtitle: 'Hear the fourth chord tone',
    label: 'Seventh colors',
  },
  {
    number: 6,
    name: 'Chord progressions',
    subtitle: 'Learn each function before connecting them',
    label: 'Harmonic movement',
  },
  {
    number: 7,
    name: 'Seventh inversions',
    subtitle: 'Four bass positions, one quality at a time',
    label: 'Seventh positions',
  },
  {
    number: 8,
    name: 'Added tones & extensions',
    subtitle: 'One new upper color at a time',
    label: 'Upper colors',
  },
  {
    number: 9,
    name: 'Altered dominants',
    subtitle: 'Ninths, fifths and upper alterations',
    label: 'Altered colors',
  },
] as const;

function lesson(
  id: SkillId,
  name: string,
  chapter: number,
  difficulty: number,
  description: string,
  objective = description,
): Skill {
  return {
    id,
    name,
    shortName: name,
    chapter,
    difficulty,
    description,
    objective,
    prerequisites: [],
    symbol: '',
  };
}

export const skills: Skill[] = [
  lesson(
    'pitch-direction',
    'Pitch direction',
    1,
    1,
    'Find the motion between two notes.',
    'Hear upward or downward motion across changing registers.',
  ),
  lesson(
    'intervals-foundation',
    'Intervals up & down',
    1,
    2,
    'Thirds, fourths, fifths, and octaves.',
    'Recognize rising or falling intervals across random roots and registers.',
  ),
  lesson(
    'intervals-harmonic',
    'Intervals together',
    1,
    2,
    'The same five distances, with both notes sounding together.',
    'Recognize harmonic intervals across random roots and registers.',
  ),
  lesson('triads', 'Major & minor', 2, 1, 'Hear the third that gives a triad its character.'),
  lesson(
    'triad-colors',
    'Diminished & augmented',
    2,
    2,
    'Add two altered-fifth colors to major and minor.',
  ),
  lesson(
    'suspended-chords',
    'Suspended fourths',
    2,
    2,
    'Hear sus4 among five familiar chord qualities.',
  ),
  lesson(
    'scale-degrees',
    'Tonal anchors',
    3,
    2,
    'Find do, mi and sol against a major-key cadence.',
  ),
  lesson('scales', 'Minor scales', 3, 3, 'Natural, harmonic and ascending melodic minor.'),
  lesson('modes', 'Major-family modes', 3, 3, 'Contrast Lydian and Mixolydian with a major scale.'),
  lesson(
    'minor-modes',
    'Minor-family modes',
    3,
    3,
    'Dorian, Phrygian and Locrian, one characteristic tone at a time.',
  ),
  lesson(
    'chord-roots',
    'Roots & quality',
    4,
    3,
    'Use C4 to name a root and its major or minor quality.',
  ),
  lesson(
    'triad-inversions',
    'Major triad positions',
    4,
    3,
    'Root, third or fifth in the bass of a major triad.',
  ),
  lesson(
    'minor-inversions',
    'Minor triad positions',
    4,
    3,
    'Apply the same three bass positions to minor triads.',
  ),
  lesson(
    'seventh-chords',
    'Major, minor & dominant',
    5,
    3,
    'Hear M7, m7 and 7 as three distinct colors.',
  ),
  lesson('seventh-colors', 'Diminished sevenths', 5, 3, 'Contrast m7, m7b5 and dim7.'),
  lesson(
    'major-functions',
    'Home, lift & return',
    6,
    3,
    'Recognize I, IV and V seventh chords in a key.',
  ),
  lesson(
    'minor-functions',
    'The minor functions',
    6,
    3,
    'Recognize ii, iii and vi after a tonic reference.',
  ),
  lesson(
    'cadences',
    'ii–V–I & first cadences',
    6,
    3,
    'Hear a three-chord path with its middle function missing.',
  ),
  lesson(
    'progressions',
    'Complete the progression',
    6,
    4,
    'Starting and ending chords are given; fill one or two middle functions.',
  ),
  lesson(
    'seventh-inversions',
    'Dominant seventh positions',
    7,
    4,
    'Find the bass position with the dominant quality supplied.',
  ),
  lesson(
    'seventh-color-inversions',
    'Major & minor seventh positions',
    7,
    4,
    'Find four bass positions with the chord quality supplied.',
  ),
  lesson('added-tones', 'Added ninths', 8, 3, 'Cadd9 and Cm(add9), without a seventh.'),
  lesson('sixth-chords', 'Sixth chords', 8, 3, 'C6 and Cm6 as a different added-note color.'),
  lesson('extensions', 'Ninth chords', 8, 4, 'CM9, Cm9 and C9 build on familiar sevenths.'),
  lesson(
    'elevenths',
    'Minor elevenths',
    8,
    4,
    'Hear the added eleventh by comparing Cm9 and Cm11.',
  ),
  lesson(
    'thirteenths',
    'Thirteenth chords',
    8,
    4,
    'CM13, Cm13 and C13, with the eleventh omitted.',
  ),
  lesson('altered-dominants', 'Altered ninths', 9, 4, 'Distinguish C7b9 from C7#9.'),
  lesson('altered-fifths', 'Altered fifths', 9, 4, 'Distinguish C7b5 from C7#5.'),
  lesson(
    'upper-alterations',
    'Upper alterations',
    9,
    5,
    'C7#11 and C7b13 retain the natural fifth.',
  ),
].map((skill, index) => ({
  ...skill,
  symbol: String(index + 1).padStart(2, '0'),
}));

export function getSkill(id: SkillId): Skill {
  const skill = skills.find((item) => item.id === id);
  if (!skill) throw new Error(`Unknown active lesson: ${id}`);
  return skill;
}

export const essentialIntervals = [3, 4, 5, 7, 12] as const;
export const intervalLessons = {
  'intervals-foundation': {
    distances: essentialIntervals,
    presentations: ['ascending', 'descending'],
  },
  'intervals-harmonic': { distances: essentialIntervals, presentations: ['together'] },
  'intervals-chromatic': {
    distances: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    presentations: ['ascending', 'descending', 'together'],
  },
} as const;

export const chordPools: Partial<Record<SkillId, readonly ChordQuality[]>> = {
  triads: ['major', 'minor'],
  'triad-colors': ['major', 'minor', 'diminished', 'augmented'],
  'suspended-chords': ['major', 'minor', 'diminished', 'augmented', 'sus4'],
  'chord-roots': ['major', 'minor'],
  'triad-inversions': ['major'],
  'minor-inversions': ['minor'],
  'seventh-chords': ['major7', 'minor7', 'dominant7'],
  'seventh-colors': ['minor7', 'halfDiminished7', 'diminished7'],
  'seventh-inversions': ['dominant7'],
  'seventh-color-inversions': ['major7', 'minor7'],
  'added-tones': ['add9', 'minorAdd9'],
  'sixth-chords': ['major6', 'minor6'],
  extensions: ['major9', 'minor9', 'dominant9'],
  elevenths: ['minor9', 'minor11'],
  thirteenths: ['major13', 'minor13', 'dominant13'],
  'altered-dominants': ['7b9', '7#9'],
  'altered-fifths': ['7b5', '7#5'],
  'upper-alterations': ['7#11', '7b13'],
};
export const scalePools: Partial<Record<SkillId, readonly ScaleId[]>> = {
  scales: ['naturalMinor', 'harmonicMinor', 'melodicMinor'],
  modes: ['lydian', 'mixolydian'],
  'minor-modes': ['dorian', 'phrygian', 'locrian'],
};
export const functionPools: Partial<Record<SkillId, readonly number[]>> = {
  'major-functions': [1, 4, 5],
  'minor-functions': [2, 3, 6],
};
export const isInversionLesson = (id: SkillId) =>
  [
    'triad-inversions',
    'minor-inversions',
    'seventh-inversions',
    'seventh-color-inversions',
  ].includes(id);
export const isSeventhInversion = (id: SkillId) =>
  id === 'seventh-inversions' || id === 'seventh-color-inversions';

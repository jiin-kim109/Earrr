import { randomUUID } from 'node:crypto';
import type {
  MusicalAnswer,
  AnswerField,
  ChordQuality,
  ExerciseKind,
  ScaleId,
} from '../../shared/types/course.js';
import type { Store } from '../db/database.js';
import type { Exercise } from '../types/exercise.types.js';
import type { Attempt, Grade, GradeDetail } from '../types/grading.types.js';
import type { Session } from '../types/session.types.js';
import { emptyProgress, updateProgress } from './progress.service.js';
import type { ProgressService } from './progress.service.js';
import { chords, intervalNames, inversionNames, parsePitch, scales } from './exercise/music.js';
import { missingPositions, normalizeTaskAnswer } from './exercise/tasks.js';

export class GradingService {
  constructor(
    private readonly store: Store,
    private readonly progress: ProgressService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(
    session: Session,
    exercise: Exercise,
    answer: MusicalAnswer | null,
    grade: Grade,
    skipped: boolean,
  ) {
    const now = this.now();
    const settings = await this.store.user.getSettings();
    const attempt: Attempt = {
      id: randomUUID(),
      exerciseId: exercise.id,
      sessionId: session.id,
      skillId: exercise.skillId,
      answer,
      grade,
      assisted: exercise.hintCount > 0,
      skipped,
      createdAt: now.toISOString(),
    };
    await this.store.attempts.save(attempt, settings.timezone);
    const progress =
      (await this.store.progress.getAll()).find((item) => item.skillId === exercise.skillId) ??
      emptyProgress(exercise.skillId);
    await this.store.progress.save(
      updateProgress(progress, exercise, grade, now, settings.timezone, skipped),
    );
    await this.store.exercises.save(
      { ...exercise, status: skipped ? 'skipped' : 'answered' },
      session.id,
    );

    const result = await this.progress.recordRound(attempt, exercise);
    await this.store.sessions.save({
      ...session,
      answered: session.answered + Number(!skipped),
      correct: session.correct + Number(!skipped && grade.verdict === 'correct'),
      awaitingRoundChoice: Boolean(result.roundResult) || session.awaitingRoundChoice,
    });
    return result;
  }
}

function canonicalQuality(quality: ChordQuality): ChordQuality {
  return quality === 'add2' ? 'add9' : quality;
}
function baseFamily(quality: ChordQuality): string {
  const family = chords[quality].family;
  return family === 'dominant' ? 'major' : family;
}

function describe(field: AnswerField, value: MusicalAnswer[AnswerField]): string {
  if (value === undefined) return 'Not supplied';
  if (Array.isArray(value)) return value.join(' - ');
  if (field === 'quality') return chords[value as ChordQuality].name;
  if (field === 'interval' && typeof value === 'number')
    return intervalNames[value] ?? `${value} semitones`;
  if (field === 'inversion' && typeof value === 'number')
    return inversionNames[value] ?? String(value);
  if (field === 'scale') return scales[value as keyof typeof scales].name;
  return String(value);
}

export function gradeAnswer(exercise: Exercise, answer: MusicalAnswer): Grade {
  answer = normalizeTaskAnswer(exercise, answer);
  const gaps = missingPositions(exercise);
  const expectedAnswer =
    gaps.length > 1
      ? {
          ...exercise.expected,
          progression: gaps.map((index) => exercise.expected.progression![index]!),
        }
      : exercise.expected;
  const missing = exercise.required.filter(
    (field) =>
      answer[field] === undefined || (field === 'root' && parsePitch(answer.root!) === null),
  );
  if (missing.length) {
    return {
      verdict: 'incomplete',
      score: 0,
      expectedLabel: '',
      details: [],
      missing,
      feedback: `No answer has been scored yet. Please also identify the ${missing.map((field) => (field === 'quality' ? 'chord quality' : field)).join(' and ')}.`,
    };
  }
  const details: GradeDetail[] = [];
  const scores: number[] = [];
  for (const field of exercise.required) {
    const expected = expectedAnswer[field]!;
    const received = answer[field]!;
    let score = 0;
    if (field === 'root')
      score = Number(parsePitch(String(expected)) === parsePitch(String(received)));
    else if (field === 'quality' && exercise.expected.quality && answer.quality) {
      score =
        canonicalQuality(exercise.expected.quality) === canonicalQuality(answer.quality)
          ? 1
          : baseFamily(exercise.expected.quality) === baseFamily(answer.quality)
            ? 0.4
            : 0;
    } else if (Array.isArray(expected) && Array.isArray(received)) {
      score =
        expected.reduce((sum, item, index) => sum + Number(item === received[index]), 0) /
        Math.max(expected.length, received.length);
    } else score = Number(expected === received);
    scores.push(score);
    details.push({
      dimension: field,
      expected: describe(field, expected),
      received: describe(field, received),
      correct: score === 1,
    });
  }
  const score = scores.reduce((sum, item) => sum + item, 0) / scores.length;
  const verdict = score === 1 ? 'correct' : score > 0 ? 'partial' : 'incorrect';
  const qualityPartial =
    exercise.expected.quality &&
    answer.quality &&
    canonicalQuality(exercise.expected.quality) !== canonicalQuality(answer.quality) &&
    baseFamily(exercise.expected.quality) === baseFamily(answer.quality);
  const matched = details.filter((detail) => detail.correct).map((detail) => detail.dimension);
  const extraRootDiffers =
    !exercise.required.includes('root') &&
    answer.root !== undefined &&
    exercise.expected.root !== undefined &&
    parsePitch(answer.root) !== parsePitch(exercise.expected.root);
  const lead =
    verdict === 'correct'
      ? extraRootDiffers
        ? 'You heard the requested chord qualities correctly. Root naming was not part of this question.'
        : 'Exactly.'
      : qualityPartial
        ? `You heard the ${baseFamily(exercise.expected.quality!)} foundation correctly.`
        : matched.length
          ? `You got the ${matched.join(' and ')} right.`
          : verdict === 'partial'
            ? 'You caught part of the sequence.'
            : 'Not quite.';
  return {
    verdict,
    score,
    details,
    missing: [],
    expectedLabel: exercise.label,
    feedback: `${lead} ${verdict === 'correct' ? 'That is' : 'This is'} ${exercise.label}. ${exercise.explanation}`,
  };
}

export function skippedGrade(exercise: Exercise): Grade {
  return {
    verdict: 'incorrect',
    score: 0,
    feedback: `This was ${exercise.label}. ${exercise.explanation}`,
    expectedLabel: exercise.label,
    details: [],
    missing: [],
  };
}

const aliases: Record<string, ChordQuality> = {
  major: 'major',
  maj: 'major',
  minor: 'minor',
  min: 'minor',
  m: 'minor',
  diminished: 'diminished',
  dim: 'diminished',
  augmented: 'augmented',
  aug: 'augmented',
  sus2: 'sus2',
  sus4: 'sus4',
  sus: 'sus4',
  suspended: 'sus4',
  maj7: 'major7',
  m7: 'minor7',
  min7: 'minor7',
  '7': 'dominant7',
  dim7: 'diminished7',
  m7b5: 'halfDiminished7',
  halfdiminished: 'halfDiminished7',
  mmaj7: 'minorMajor7',
  minmaj7: 'minorMajor7',
  '6': 'major6',
  m6: 'minor6',
  add2: 'add2',
  add9: 'add9',
  madd9: 'minorAdd9',
  minoradd9: 'minorAdd9',
  maj9: 'major9',
  m9: 'minor9',
  '9': 'dominant9',
  '11': 'dominant11',
  m11: 'minor11',
  maj13: 'major13',
  m13: 'minor13',
  '13': 'dominant13',
  '7b9': '7b9',
  '7#9': '7#9',
  '7b5': '7b5',
  '7#5': '7#5',
  '7#11': '7#11',
  '7b13': '7b13',
  '7alt': '7alt',
};
const clean = (text: string) => text.toLowerCase().replace(/[\s()_-]/g, '');

export function parseSoloAnswer(
  text: string,
  exercise: { kind: ExerciseKind; task?: Exercise['task'] },
): MusicalAnswer | null {
  const raw = text
    .trim()
    .replace(/[?.!]$/, '')
    .replaceAll('♯', '#')
    .replaceAll('♭', 'b');
  const lower = raw.toLowerCase();
  if (exercise.kind === 'direction') {
    if (['up', 'higher', 'ascending'].includes(lower)) return { direction: 'up' };
    if (['down', 'lower', 'descending'].includes(lower)) return { direction: 'down' };
    if (['same', 'unison', 'same pitch'].includes(lower)) return { direction: 'same' };
    return null;
  }
  if (exercise.kind === 'pitch')
    return /^[A-G](?:[#b]| sharp| flat)?\d?$/i.test(raw) ? { root: raw } : null;
  if (
    exercise.kind === 'degree' ||
    exercise.kind === 'function' ||
    exercise.kind === 'melody' ||
    exercise.kind === 'progression'
  ) {
    if ((exercise.kind === 'progression' || exercise.kind === 'function') && /^[A-G]/i.test(raw)) {
      const chord = parseSoloAnswer(raw, { kind: 'chord' });
      if (chord?.root) return chord;
    }
    const degrees: Record<string, number> = {
      do: 1,
      re: 2,
      mi: 3,
      fa: 4,
      sol: 5,
      so: 5,
      la: 6,
      ti: 7,
      si: 7,
      i: 1,
      ii: 2,
      iii: 3,
      iv: 4,
      v: 5,
      vi: 6,
      vii: 7,
    };
    const parts = lower.split(/[\s,;>\u2013\u2014-]+/).filter(Boolean);
    const numbers = parts.map((item) => {
      const numeral =
        exercise.kind === 'progression' || exercise.kind === 'function'
          ? /^(vii|iii|vi|iv|ii|v|i)(?:maj7|7|[°oø]7?)?$/.exec(item)?.[1]
          : undefined;
      return /^\d$/.test(item) ? Number(item) : degrees[numeral ?? item];
    });
    if (!numbers.length || numbers.some((value) => value === undefined || value < 1 || value > 7))
      return null;
    const valid = numbers.filter((value): value is number => value !== undefined);
    return exercise.kind === 'degree' ||
      exercise.kind === 'function' ||
      (exercise.task?.kind === 'complete' && valid.length === 1)
      ? valid.length === 1
        ? { degree: valid[0]! }
        : null
      : exercise.kind === 'melody'
        ? { melody: valid }
        : { progression: valid };
  }
  if (exercise.kind === 'interval') {
    const names: Record<string, number> = {
      m2: 1,
      M2: 2,
      m3: 3,
      M3: 4,
      P4: 5,
      A4: 6,
      d5: 6,
      P5: 7,
      m6: 8,
      M6: 9,
      m7: 10,
      M7: 11,
      P8: 12,
    };
    if (raw in names) return { interval: names[raw]! };
    const normalized = lower
      .replace(/2nd/g, 'second')
      .replace(/3rd/g, 'third')
      .replace(/4th/g, 'fourth')
      .replace(/5th/g, 'fifth')
      .replace(/6th/g, 'sixth')
      .replace(/7th/g, 'seventh')
      .replace(/8th/g, 'octave');
    const interval = intervalNames.findIndex((name) => name === normalized);
    return interval >= 0 ? { interval } : null;
  }
  if (exercise.kind === 'scale') {
    const scaleAliases: Record<string, ScaleId> = {
      minor: 'naturalMinor',
      aeolian: 'naturalMinor',
      ionian: 'major',
    };
    const scale =
      scaleAliases[clean(raw)] ??
      Object.entries(scales).find(
        ([key, definition]) => clean(key) === clean(raw) || clean(definition.name) === clean(raw),
      )?.[0];
    return scale ? { scale: scale as ScaleId } : null;
  }
  const rootMatch =
    /^([A-G](?:#|b)?)(?=\s|$|m|M|a|d|s|\d|\/)/.exec(raw) ??
    /^([a-g](?:#|b)?)(?=\s|$|m|M|add\d|dim|aug|sus[24]|\d|\/)/.exec(raw);
  const root = rootMatch ? rootMatch[1]![0]!.toUpperCase() + rootMatch[1]!.slice(1) : undefined;
  let suffix = root ? raw.slice(root.length).trim() : raw;
  const slash = /\/([A-G](?:#|b){0,2})$/i.exec(suffix);
  if (slash) suffix = suffix.slice(0, slash.index).trim();
  const inversionMatch =
    /\b(root position|first inversion|1st inversion|second inversion|2nd inversion|third inversion|3rd inversion)\b/i.exec(
      suffix,
    );
  let inversion: number | undefined;
  if (inversionMatch) {
    inversion = /^(first|1st)/i.test(inversionMatch[0])
      ? 1
      : /^(second|2nd)/i.test(inversionMatch[0])
        ? 2
        : /^(third|3rd)/i.test(inversionMatch[0])
          ? 3
          : 0;
    suffix = suffix
      .replace(inversionMatch[0], '')
      .replace(/[,\s]+$/, '')
      .trim();
  }
  if (suffix === 'M') suffix = 'major';
  if (/^M\d/.test(suffix)) suffix = suffix.replace(/^M/, 'maj');
  const key = clean(suffix);
  const quality =
    aliases[key] ??
    Object.entries(chords).find(
      ([id, definition]) => clean(id) === key || clean(definition.name) === key,
    )?.[0];
  if (!quality && !root && inversion !== undefined) return { inversion };
  if (!quality && !(root && !suffix)) return null;
  if (slash && root) {
    const bass = parsePitch(slash[1]!);
    const rootPitch = parsePitch(root);
    if (bass === null || rootPitch === null) return null;
    const intervals = chords[(quality ?? 'major') as ChordQuality].intervals;
    inversion = intervals.findIndex((interval) => (rootPitch + interval) % 12 === bass);
    if (inversion < 0 || inversion > 3) return null;
  }
  return {
    ...(root ? { root } : {}),
    quality: (quality ?? 'major') as ChordQuality,
    ...(inversion !== undefined ? { inversion } : {}),
  };
}

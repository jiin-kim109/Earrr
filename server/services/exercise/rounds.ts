import type { SkillId, CheckpointRule } from '../../../shared/types/course.js';
import type { ExerciseTarget } from '../../types/exercise.types.js';
import { chordPools, essentialIntervals, intervalLessons, scalePools } from './catalog.js';
import { seededRandom } from './music.js';

export const roundRule: CheckpointRule = { questions: 10, correct: 8 };

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function balanced<T>(pool: readonly T[], round: number): T[] {
  if (!pool.length) throw new Error('A round needs at least one question type.');
  return Array.from({ length: 10 }, (_, index) => pool[((round - 1) * 10 + index) % pool.length]!);
}

export function roundPlan(skillId: SkillId, round: number, seed: number): ExerciseTarget[] {
  const random = seededRandom(seed);
  let targets: ExerciseTarget[];
  const qualities = chordPools[skillId];
  if (skillId === 'intervals-foundation') {
    targets = essentialIntervals.flatMap((interval) => [
      { interval, presentation: 'ascending' as const },
      { interval, presentation: 'descending' as const },
    ]);
  } else if (skillId === 'triad-colors') {
    targets = (
      [
        'major',
        'minor',
        'diminished',
        'diminished',
        'augmented',
        'augmented',
        'sus2',
        'sus2',
        'sus4',
        'sus4',
      ] as const
    ).map((quality) => ({ quality }));
  } else if (qualities) {
    if (skillId === 'triad-inversions' || skillId === 'seventh-inversions') {
      const positions = skillId === 'triad-inversions' ? 3 : 4;
      const combinations = Array.from({ length: positions }, (_, offset) =>
        qualities.map((quality, index) => ({ quality, inversion: (offset + index) % positions })),
      ).flat();
      targets = balanced(combinations, round);
    } else {
      targets = balanced(qualities, round).map((quality) => ({ quality }));
    }
  } else {
    switch (skillId) {
      case 'pitch-direction':
        targets = balanced(['up', 'down'] as const, round).map((direction) => ({ direction }));
        break;
      case 'reference-pitch':
        targets = balanced(
          Array.from({ length: 12 }, (_, root) => root),
          round,
        ).map((root) => ({ root }));
        break;
      case 'scale-degrees':
        targets = balanced([1, 2, 3, 4, 5, 6, 7], round).map((degree) => ({ degree }));
        break;
      case 'intervals-harmonic':
        targets = balanced(essentialIntervals, round).map((interval) => ({
          interval,
          presentation: 'together',
        }));
        break;
      case 'intervals-chromatic': {
        const presentations = shuffle(
          [
            'ascending',
            'ascending',
            'ascending',
            'ascending',
            'descending',
            'descending',
            'descending',
            'together',
            'together',
            'together',
          ] as const,
          random,
        );
        targets = balanced(intervalLessons['intervals-chromatic'].distances, round).map(
          (interval, index) => ({ interval, presentation: presentations[index]! }),
        );
        break;
      }
      case 'scales':
      case 'modes':
        targets = balanced(scalePools[skillId], round).map((scale) => ({ scale }));
        break;
      case 'melodies':
      case 'progressions':
      case 'jazz-progressions':
        targets = [3, 3, 3, 3, 4, 4, 4, 5, 5, 5].map((length) => ({ length }));
        break;
      default:
        throw new Error(`No round composition exists for ${skillId}.`);
    }
  }
  if (targets.length !== 10) throw new Error('Every practice round must contain ten questions.');
  return shuffle(targets, random);
}

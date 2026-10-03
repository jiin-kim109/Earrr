import { randomUUID } from 'node:crypto';
import type { SkillId } from '../../../shared/types/course.js';
import type { TeachingProgress } from '../../types/exercise.types.js';
import { intervalLessons } from './catalog.js';
import { intervalNames } from './music.js';
import { teachingSteps } from './lessons.js';

function legacyIds(lessonId: SkillId, current: string[]): string[] {
  let demos: string[];
  switch (lessonId) {
    case 'intervals-foundation':
    case 'intervals-harmonic':
    case 'intervals-chromatic':
      demos = intervalLessons[lessonId].distances.flatMap((distance) => {
        const id = intervalNames[distance]!.replaceAll(' ', '-');
        return distance === 4 ? [id, 'compare-thirds'] : [id];
      });
      if (lessonId !== 'intervals-harmonic') demos.push('direction-is-not-distance');
      break;
    case 'reference-pitch':
      demos = ['reference-c', 'reference-d', 'reference-b'];
      break;
    case 'triads':
      demos = ['major-0', 'minor-0', 'compare-triads'];
      break;
    case 'triad-colors':
      demos = ['major-0', 'minor-0', 'diminished-0', 'augmented-0', 'sus2-0', 'sus4-0'];
      break;
    case 'triad-inversions':
      demos = ['major-0', 'major-1', 'major-2', 'minor-0', 'minor-1', 'minor-2'];
      break;
    case 'chord-roots':
      demos = ['root-60', 'root-62', 'root-63'];
      break;
    case 'seventh-colors':
      demos = [
        'major7-0',
        'minor7-0',
        'dominant7-0',
        'halfDiminished7-0',
        'diminished7-0',
        'minorMajor7-0',
      ];
      break;
    case 'added-tones':
      demos = ['major6-0', 'minor6-0', 'add2-0', 'add9-0', 'minorAdd9-0'];
      break;
    default:
      return current;
  }
  return ['overview', ...demos, 'ready-for-practice'];
}

export function normalizeTeachingProgress(progress: TeachingProgress): TeachingProgress {
  if (progress.section === 'welcome') return progress;
  const steps = teachingSteps(progress.lessonId, 'piano');
  const ids = steps.map((step) => step.id);
  const previous = legacyIds(progress.lessonId, ids);
  const oldId = progress.stepId ?? previous[progress.index];
  if (!oldId) throw new Error('The saved tutorial position has no matching step.');
  const oldIndex = previous.indexOf(oldId);
  const stepId = ids.includes(oldId)
    ? oldId
    : oldIndex >= 0
      ? previous.slice(oldIndex + 1).find((id) => ids.includes(id))
      : undefined;
  if (!stepId) throw new Error('The saved tutorial step cannot be restored.');
  const index = ids.indexOf(stepId);
  const lastId =
    progress.lastDemoStepId ??
    (progress.lastDemoIndex === null ? null : previous[progress.lastDemoIndex]);
  const audioIds = steps.filter((step) => step.audio).map((step) => step.id);
  const lastDemoStepId =
    lastId && audioIds.includes(lastId)
      ? lastId
      : lastId && previous.includes(lastId)
        ? (previous
            .slice(0, previous.indexOf(lastId) + 1)
            .reverse()
            .find((id) => audioIds.includes(id)) ?? null)
        : null;
  const replaced = oldId !== stepId;
  return {
    ...progress,
    stepId,
    index,
    lastDemoStepId,
    lastDemoIndex: lastDemoStepId ? ids.indexOf(lastDemoStepId) : null,
    ...(replaced
      ? { presentationId: randomUUID(), delivered: false, autoContinue: index < steps.length - 1 }
      : {}),
  };
}

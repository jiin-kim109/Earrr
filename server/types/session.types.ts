import type { SkillId } from '../../shared/types/course.js';
import type { TeachingProgress } from './exercise.types.js';

export interface LessonPosition {
  phase: 'teaching' | 'practice';
  teaching: TeachingProgress | null;
  currentExerciseId: string | null;
  previousExerciseId: string | null;
  playedTutorialSteps?: string[];
}

export interface Session {
  id: string;
  mode: 'coach' | 'solo';
  status: 'active' | 'paused' | 'ended';
  focus: SkillId | 'adaptive';
  startedAt: string;
  endedAt: string | null;
  currentExerciseId: string | null;
  previousExerciseId: string | null;
  answered: number;
  correct: number;
  listened: number;
  awaitingRoundChoice?: boolean;
  phase?: 'teaching' | 'practice';
  teaching?: TeachingProgress | null;
  playedTutorialSteps?: string[];
}

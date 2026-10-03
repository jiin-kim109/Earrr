import type { SkillId } from '../../shared/types/course.js';
import type { ExerciseTarget } from './exercise.types.js';

export interface SkillProgress {
  skillId: SkillId;
  attempts: number;
  correct: number;
  scoreTotal: number;
  recentScores: number[];
  unassistedCorrect: number;
  roots: number[];
  registers: number[];
  practiceDays: string[];
  lastPracticedAt: string | null;
  dueAt: string | null;
}

export interface RoundAnswer {
  attemptId: string;
  outcome: 'correct' | 'incorrect';
}

export interface RoundResult {
  id: string;
  number: number;
  skillId: SkillId;
  correct: number;
  questions: number;
  answered: number;
  requiredCorrect: number;
  passed: boolean;
  answers: RoundAnswer[];
  completedAt: string;
}

export type RoundSummary = Omit<RoundResult, 'answers'> & { answers?: RoundAnswer[] };

export interface PracticeRound {
  id: string;
  number: number;
  skillId: SkillId;
  remaining: Array<{ id: string; target: ExerciseTarget }>;
  answers: RoundAnswer[];
  previous: RoundSummary | null;
  awaitingChoice: boolean;
}

export interface RoundProgress {
  id: string | null;
  number: number;
  correct: number;
  answers: RoundAnswer[];
  previous: RoundSummary | null;
}

export interface LessonProgress {
  skillId: SkillId;
  status: 'not_started' | 'in_progress' | 'completed';
  completedAt: string | null;
  answered: number;
  unlocked: boolean;
}

export interface CourseState {
  welcomeSeen: boolean;
  selectedLesson: SkillId;
  completedLessons: number;
  lessons: LessonProgress[];
  nextLesson: SkillId | null;
  round: RoundProgress;
}

export interface DailyActivity {
  date: string;
  answers: number;
  correct: number;
}

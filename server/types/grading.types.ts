import type { AnswerField, MusicalAnswer, SkillId } from '../../shared/types/course.js';
import type { PlayedExample } from './exercise.types.js';

export interface GradeDetail {
  dimension: string;
  expected: string;
  received: string;
  correct: boolean;
}

export interface Grade {
  verdict: 'correct' | 'partial' | 'incorrect' | 'incomplete';
  score: number;
  feedback: string;
  expectedLabel: string;
  details: GradeDetail[];
  missing: AnswerField[];
}

export interface Attempt {
  id: string;
  exerciseId: string;
  sessionId: string;
  skillId: SkillId;
  answer: MusicalAnswer | null;
  grade: Grade;
  assisted: boolean;
  skipped: boolean;
  createdAt: string;
}

export interface ExerciseFeedback {
  attemptId: string | null;
  exerciseId: string;
  grade: Grade;
  skipped: boolean;
  example?: PlayedExample;
}

export type AnswerReview = ExerciseFeedback & { attemptId: string; example: PlayedExample };

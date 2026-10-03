import { z } from 'zod';
import type { Transcript } from '../../shared/types/user.js';
import type { ExerciseFeedback } from './grading.types.js';
import type { PublicExercise, TeachingView } from './exercise.types.js';
import type { CourseState } from './progress.types.js';
import type { Session } from './session.types.js';

export const transcriptSchema: z.ZodType<Transcript> = z
  .object({
    id: z.string().min(1).max(160),
    sessionId: z.string().uuid(),
    role: z.enum(['user', 'assistant', 'system']),
    text: z.string().min(1),
    createdAt: z.iso
      .datetime({ offset: true })
      .transform((createdAt) => new Date(createdAt).toISOString()),
    delivery: z.enum(['spoken', 'interrupted']).optional(),
    feedbackId: z.string().uuid().optional(),
  })
  .strict();

export const learningEventTypes = [
  'tool.completed',
  'session.restored',
  'teaching.delivered',
  'audio.played',
  'settings.changed',
] as const;

export interface ConversationEvent {
  id: string;
  sequence?: number;
  sessionId: string;
  type: (typeof learningEventTypes)[number];
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface SessionCheckpoint {
  sequence: number;
  eventSequence: number;
  createdAt: string;
  state: {
    session: Session;
    current: PublicExercise | null;
    feedback: ExerciseFeedback | null;
    teaching: TeachingView | null;
    course: CourseState;
  };
}

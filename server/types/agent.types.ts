import { z } from 'zod';
import { answerSchema, skillIdSchema } from '../../shared/schemas/course.js';
import type { ActionEffect, ReplyPurpose } from './action.types.js';
import type { SkillId, AnswerField } from '../../shared/types/course.js';
import type { Settings, Transcript } from '../../shared/types/user.js';
import type { Attempt, ExerciseFeedback, Grade, AnswerReview } from './grading.types.js';
import type { PublicExercise, PlayedExample, TeachingView } from './exercise.types.js';
import type { CourseState, DailyActivity, SkillProgress, RoundSummary } from './progress.types.js';
import type { Session } from './session.types.js';

export const toolNames = [
  'start_session',
  'show_welcome',
  'play_exercise',
  'replay_exercise',
  'submit_answer',
  'give_hint',
  'skip_exercise',
  'pause_session',
  'resume_session',
  'end_session',
  'inspect_progress',
  'adjust_session',
  'select_lesson',
  'review_answer',
  'teach_lesson',
  'continue_teaching',
  'start_practice',
  'start_round',
] as const;

export type ToolName = (typeof toolNames)[number];

export const toolRequestSchema = z
  .object({
    callId: z.string().min(1).max(160),
    name: z.enum(toolNames),
    arguments: z.record(z.string(), z.unknown()),
    sessionId: z.string().uuid().optional(),
  })
  .strict();

export type ToolRequest = z.infer<typeof toolRequestSchema>;

export const toolArguments = {
  start_session: z
    .object({
      focus: z.union([z.literal('adaptive'), skillIdSchema]).optional(),
      mode: z.enum(['coach', 'solo']).optional(),
      teach: z.boolean().optional(),
      welcome: z.boolean().optional(),
    })
    .strict(),
  show_welcome: z.object({}).strict(),
  play_exercise: z
    .object({
      skillId: skillIdSchema.optional(),
    })
    .strict(),
  replay_exercise: z
    .object({
      target: z.enum(['current', 'previous']).optional(),
      arpeggiate: z.boolean().optional(),
      exerciseId: z.string().uuid().optional(),
    })
    .strict(),
  submit_answer: z
    .object({
      exerciseId: z.string().uuid(),
      answer: answerSchema,
    })
    .strict(),
  give_hint: z.object({ exerciseId: z.string().uuid() }).strict(),
  skip_exercise: z.object({ exerciseId: z.string().uuid() }).strict(),
  pause_session: z.object({}).strict(),
  resume_session: z.object({}).strict(),
  end_session: z.object({}).strict(),
  inspect_progress: z.object({}).strict(),
  review_answer: z.object({}).strict(),
  teach_lesson: z
    .object({
      restart: z.boolean().optional(),
      stepId: z.string().min(1).max(80).optional(),
      discardRoundId: z.string().uuid().nullable().optional(),
    })
    .strict(),
  continue_teaching: z.object({ presentationId: z.string().uuid() }).strict(),
  start_practice: z.object({}).strict(),
  start_round: z.object({}).strict(),
  adjust_session: z.object({ focus: skillIdSchema }).strict(),
  select_lesson: z.object({ skillId: skillIdSchema }).strict(),
} satisfies Record<ToolName, z.ZodType>;

export type ToolArguments = {
  [Name in ToolName]: z.infer<(typeof toolArguments)[Name]>;
};

export interface ActionOutcome extends Omit<ActionEffect, 'notice'> {
  message: string;
}

export interface ToolResult extends ActionOutcome {
  reply: ReplyPurpose;
  snapshot: Snapshot;
  agent: {
    context: AgentToolContext;
    presentation?: Presentation;
    update: string;
  };
}

export interface Snapshot {
  checkpoint: number | null;
  transcript: Transcript[];
  teaching: TeachingView | null;
  feedback: ExerciseFeedback | null;
  course: CourseState;
  settings: Settings;
  session: Session | null;
  current: PublicExercise | null;
  progress: SkillProgress[];
  recentAttempts: Array<Attempt & { label: string }>;
  recentSessions: Session[];
  activity: DailyActivity[];
  totalAnswers: number;
  streak: number;
  recommendation: { skillId: SkillId; reason: string };
  configured: boolean;
  deployment: string;
  agent: {
    toolNames: ToolName[];
    connectionPrompt: string;
  };
}

interface CompactGrade {
  verdict: Grade['verdict'];
  expectedAnswer: string;
  missing: AnswerField[];
  details: Grade['details'];
  played?: PlayedExample;
}

export type PresentationPart =
  | ({ kind: 'feedback' } & CompactGrade)
  | { kind: 'instruction'; text?: string }
  | {
      kind: 'teaching';
      title: string;
      explanation: string;
      demoLabel: string | null;
      awaitingPractice: boolean;
      section?: 'welcome';
    }
  | { kind: 'checkpoint'; nextLesson: SkillId | null }
  | {
      kind: 'round_result';
      passed: boolean;
      correct: number;
      questions: number;
      requiredCorrect: number;
      answered: number;
    }
  | { kind: 'next_question' | 'listening_cue'; cue?: string };

export interface Presentation {
  purpose: Exclude<ReplyPurpose, 'none'>;
  context: { parts: PresentationPart[] };
  instructions?: string;
}

export interface AgentToolContext {
  ok: boolean;
  reply: ReplyPurpose;
  message?: string;
  nextQuestion?: boolean;
  grade?: CompactGrade;
  gradedExerciseId?: string;
  hint?: string;
  hasAudio: boolean;
  playbackExerciseId?: string;
  endConversation?: boolean;
  lessonCompleted?: boolean;
  roundResult?: RoundSummary;
  review?: AnswerReview;
  session: Session | null;
  current: (Omit<PublicExercise, 'prompt'> & { prompt?: string }) | null;
  teaching: TeachingView | null;
  course: CourseState;
  lessonChoices: Array<{
    id: SkillId;
    name: string;
    unlocked: boolean;
    prerequisite: string | null;
    requiredCorrect: number;
    questions: number;
  }>;
  totals: { answers: number };
}

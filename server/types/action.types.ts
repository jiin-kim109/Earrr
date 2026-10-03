import type { AudioPlan } from '../../shared/types/course.js';
import type { Grade, AnswerReview } from './grading.types.js';
import type { Session } from './session.types.js';
import type { TeachingView } from './exercise.types.js';
import type { RoundResult } from './progress.types.js';

export type ReplyPurpose = 'none' | 'instruction' | 'cue' | 'feedback' | 'teaching' | 'message';

export type ActionNotice =
  | { kind: 'round_choice'; passed: boolean }
  | { kind: 'existing_session'; status: Session['status'] }
  | { kind: 'replayed'; previous: boolean; arpeggiated: boolean }
  | { kind: 'resolved_question'; label: string; explanation: string }
  | { kind: 'session_ended'; answered: number; correct: number }
  | {
      kind:
        | 'session_started'
        | 'progress'
        | 'saved_answer'
        | 'no_saved_answer'
        | 'unanswered_question'
        | 'fresh_example'
        | 'already_scored'
        | 'answer_graded'
        | 'hint'
        | 'already_resolved'
        | 'skipped'
        | 'teaching'
        | 'session_paused'
        | 'session_resumed'
        | 'lesson_selected'
        | 'next_prepared';
    };

export interface ActionEffect {
  ok: boolean;
  notice: ActionNotice;
  reply?: ReplyPurpose;
  nextQuestion?: boolean;
  teaching?: TeachingView;
  audio?: AudioPlan;
  playbackExerciseId?: string;
  grade?: Grade;
  gradedExerciseId?: string;
  hint?: string;
  error?: string;
  endConversation?: boolean;
  lessonCompleted?: boolean;
  roundResult?: RoundResult;
  review?: AnswerReview;
}

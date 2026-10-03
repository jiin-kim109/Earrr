import type {
  AnswerField,
  AudioPlan,
  ExerciseKind,
  MusicalAnswer,
  SkillId,
  ChordQuality,
  ScaleId,
} from '../../shared/types/course.js';

export interface Exercise {
  id: string;
  seed: number;
  skillId: SkillId;
  kind: ExerciseKind;
  root: number;
  register: number;
  prompt: string;
  cue?: string;
  expected: MusicalAnswer;
  required: AnswerField[];
  label: string;
  explanation: string;
  hints: string[];
  audio: AudioPlan;
  createdAt: string;
  replayCount: number;
  hintCount: number;
  status: 'unanswered' | 'answered' | 'skipped';
  roundId?: string;
  roundTargetId?: string;
}

export interface ExerciseTarget {
  direction?: 'up' | 'down';
  root?: number;
  interval?: number;
  presentation?: 'ascending' | 'descending' | 'together';
  quality?: ChordQuality;
  inversion?: number;
  degree?: number;
  scale?: ScaleId;
  length?: number;
}

export interface PublicExercise {
  id: string;
  skillId: SkillId;
  kind: ExerciseKind;
  prompt: string;
  cue?: string;
  required: AnswerField[];
  status: Exercise['status'];
  replayCount: number;
  hintCount: number;
  reveal?: {
    label: string;
    explanation: string;
    notes: string[];
  };
}

export interface PlayedExample {
  notes: string[];
  midi: number[];
  presentation: 'single' | 'ascending' | 'descending' | 'together' | 'repeated' | 'sequence';
  semitones?: number;
}

export interface TeachingProgress {
  section?: 'welcome';
  lessonId: SkillId;
  index: number;
  stepId?: string;
  presentationId: string;
  delivered: boolean;
  lastDemoIndex: number | null;
  lastDemoStepId?: string | null;
  autoContinue: boolean;
}

export interface TeachingView {
  section?: 'welcome';
  playedSteps?: string[];
  lessonId: SkillId;
  presentationId: string;
  stepId: string;
  index: number;
  total: number;
  title: string;
  narration: string;
  demoLabel: string | null;
  example: PlayedExample | null;
  delivered: boolean;
  autoContinue: boolean;
  awaitingPractice: boolean;
  lastDemoId: string | null;
  steps: Array<{ id: string; title: string }>;
}

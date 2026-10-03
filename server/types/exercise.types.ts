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
  task?:
    | { kind: 'complete'; gapIndex: number }
    | { kind: 'compare-chords'; referenceQuality: ChordQuality }
    | { kind: 'compare-scale' };
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
  format?: 'identify' | 'complete' | 'compare';
}

export type QuestionDisplay =
  | {
      kind: 'sequence';
      subject: 'melody' | 'progression';
      tonic: string;
      instruction: string;
      labels: Array<string | null>;
      onsets: number[];
      targetIndex?: number;
    }
  | {
      kind: 'comparison';
      subject: 'chord' | 'scale';
      reference: string;
      instruction: string;
      onsets: [number, number];
    }
  | { kind: 'degree'; tonic: string; instruction: string };

export interface DiagramTone {
  midi: number;
  note: string;
  degree: string;
  color: boolean;
}

export type MusicalDiagram =
  | { kind: 'chord'; root: string; symbol: string; tones: DiagramTone[] }
  | { kind: 'degree'; tonic: string; degree: number; note: string; midi: number }
  | {
      kind: 'melody' | 'scale';
      tonic: string;
      points: Array<{ midi: number; note: string; label: string }>;
      gaps?: number[];
      targetIndex?: number;
    }
  | {
      kind: 'progression';
      tonic: string;
      chords: Array<{ symbol: string; function: string; midi: number[]; notes: string[] }>;
      targetIndex?: number;
    };

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
  question?: QuestionDisplay;
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
  diagram?: MusicalDiagram;
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

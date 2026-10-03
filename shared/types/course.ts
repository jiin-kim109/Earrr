import type { z } from 'zod';
import type {
  answerSchema,
  chordQualities,
  instrumentSchema,
  scaleIds,
  skillIdSchema,
} from '../schemas/course.js';

export type SkillId = z.infer<typeof skillIdSchema>;
export type CourseSectionId = SkillId | 'welcome';
export type ChordQuality = (typeof chordQualities)[number];
export type ScaleId = (typeof scaleIds)[number];
export type MusicalAnswer = z.infer<typeof answerSchema>;
export type AnswerField = keyof MusicalAnswer;
export type Instrument = z.infer<typeof instrumentSchema>;
export type ExerciseKind =
  | 'direction'
  | 'pitch'
  | 'degree'
  | 'interval'
  | 'chord'
  | 'scale'
  | 'melody'
  | 'progression';

export interface NoteEvent {
  midi: number;
  at: number;
  duration: number;
  velocity: number;
  role: 'reference' | 'exercise';
}

export interface AudioPlan {
  events: NoteEvent[];
  duration: number;
  instrument: Instrument;
}

export interface TeachingStep {
  id: string;
  title: string;
  narration: string;
  demoLabel?: string;
  audio?: AudioPlan;
}

export interface Skill {
  id: SkillId;
  name: string;
  shortName: string;
  chapter: number;
  description: string;
  objective: string;
  prerequisites: SkillId[];
  difficulty: number;
  symbol: string;
}

export interface Chapter {
  number: number;
  name: string;
  subtitle: string;
  label: string;
}

export interface LessonNotes {
  introduction: string;
  listenFor: string;
  answers: string;
}

export interface CheckpointRule {
  questions: number;
  correct: number;
}

export interface CurriculumLesson extends Skill {
  notes: LessonNotes;
  checkpoint: CheckpointRule;
  checkpointDescription: string;
}

export interface Curriculum {
  welcome: Chapter;
  chapters: readonly Chapter[];
  lessons: CurriculumLesson[];
}

export interface LessonExample {
  stepId: string;
  label: string;
  explanation: string;
  audio: AudioPlan;
}

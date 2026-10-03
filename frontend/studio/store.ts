import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Curriculum } from '../../shared/types/course.js';
import type { Snapshot } from '../../server/types/agent.types.js';
import type { ExerciseFeedback } from '../../server/types/grading.types.js';
import type { RoundResult } from '../../server/types/progress.types.js';
import type { Transcript } from '../coach/types.js';
import type { Session } from '../../server/types/session.types.js';
import type { Phase } from '../coach/conversation.js';

export type AudioNoticeSurface = 'setup' | 'lesson';
export interface AudioNoticeState {
  message: string;
  kind: 'error' | 'notice';
}

export interface StudioState {
  snapshot: Snapshot | null;
  curriculum: Curriculum | null;
  loading: boolean;
  busy: boolean;
  entering: boolean;
  restartingRound: boolean;
  connection: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  phase: Phase;
  musicPlayback: { exerciseId?: string; replay: boolean } | null;
  hasMicrophone: boolean;
  micBusy: boolean;
  microphoneDevice: string;
  speakerDevice: string;
  devices: MediaDeviceInfo[];
  previewingMicrophone: boolean;
  error: string | null;
  notice: string | null;
  audioNotices: Record<AudioNoticeSurface, AudioNoticeState | null>;
  voiceBlocked: boolean;
  microphoneError: string | null;
  messages: Transcript[];
  answerReveal: (ExerciseFeedback & { roundResult?: RoundResult }) | null;
  lastSession: Session | null;
  setupOpen: boolean;
  setupComplete: boolean;
}

export const createStudioStore = () =>
  createStore<StudioState>(() => ({
    snapshot: null,
    curriculum: null,
    loading: true,
    busy: false,
    entering: false,
    restartingRound: false,
    connection: 'disconnected',
    phase: 'ready',
    musicPlayback: null,
    hasMicrophone: false,
    micBusy: false,
    microphoneDevice: 'none',
    speakerDevice: '',
    devices: [],
    previewingMicrophone: false,
    error: null,
    notice: null,
    audioNotices: { setup: null, lesson: null },
    voiceBlocked: false,
    microphoneError: null,
    messages: [],
    answerReveal: null,
    lastSession: null,
    setupOpen: true,
    setupComplete: false,
  }));

export const studioStore = createStudioStore();

export function useStudio(): StudioState;
export function useStudio<T>(selector: (state: StudioState) => T): T;
export function useStudio(selector?: (state: StudioState) => unknown) {
  return useStore(studioStore, selector ?? ((state) => state));
}

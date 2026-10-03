import type { z } from 'zod';
import type { settingsSchema, guestSaveSchema } from '../schemas/user.js';

export type Settings = z.infer<typeof settingsSchema>;

export interface Transcript {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  delivery?: 'spoken' | 'interrupted';
  feedbackId?: string;
}

export interface UserProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface PublicAuthConfig {
  enabled: boolean;
  url: string;
  publishableKey: string;
  googleEnabled: boolean;
  guestStorage: boolean;
}

export type GuestSave = z.infer<typeof guestSaveSchema>;

export interface ApiEnvelope<T> {
  data: T;
  guestSave?: GuestSave;
  learningStarted: boolean;
}

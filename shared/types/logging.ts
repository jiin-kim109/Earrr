import type { z } from 'zod';
import type { logEventSchema } from '../schemas/logging.js';

export type LogEvent = z.infer<typeof logEventSchema>;
export type LogMessage = Record<string, unknown>;
export type LogLevel = LogEvent['level'];
export interface LogOptions {
  level?: LogLevel;
  sessionId?: string | null;
  requestId?: string | null;
}

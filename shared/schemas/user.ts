import { z } from 'zod';
import { instrumentSchema } from './course.js';

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const settingsSchema = z
  .object({
    instrument: instrumentSchema,
    volume: z.number().min(0).max(1),
    voice: z.enum(['sage', 'ash', 'coral', 'verse']),
    timezone: z.string().max(80).refine(isTimeZone, 'Choose a valid time zone.'),
  })
  .strict();

export const guestSaveSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    checkpoint: z.string().min(1).max(8_000_000),
    learningStarted: z.boolean(),
  })
  .strict();

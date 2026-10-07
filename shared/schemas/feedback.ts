import { z } from 'zod';

export const feedbackSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    message: z.string().trim().min(1).max(4000),
    replyEmail: z.email().max(254).nullable(),
  })
  .strict();

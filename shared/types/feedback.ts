import type { z } from 'zod';
import type { feedbackSchema } from '../schemas/feedback.js';

export type FeedbackSubmission = z.infer<typeof feedbackSchema>;

import type { FeedbackSubmission } from '../../shared/types/feedback.js';
import { credentials } from '../storage/access.js';
import { Log } from '../lib/log.js';

export function submitFeedback(input: FeedbackSubmission): Promise<boolean> {
  const owner = credentials();
  return fetch('/api/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-earrr-client': '1',
      ...Log.headers(),
      ...owner.headers,
    },
    body: JSON.stringify(input),
    keepalive: true,
    signal: AbortSignal.timeout(5000),
  }).then(
    (response) => {
      const saved = response.status === 204;
      if (!saved) console.warn(`[feedback] Submission rejected (${response.status}).`);
      return saved;
    },
    (error: unknown) => {
      console.warn(
        `[feedback] Submission failed (${error instanceof Error ? error.name : 'UnknownError'}).`,
      );
      return false;
    },
  );
}

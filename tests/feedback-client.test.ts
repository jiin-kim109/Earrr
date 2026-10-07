import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { submitFeedback } from '../frontend/feedback/submit.js';
import type { FeedbackSubmission } from '../shared/types/feedback.js';

const controls = vi.hoisted(() => ({
  credentials: vi.fn(() => ({
    identity: 'guest:fixture',
    headers: { 'x-earrr-guest': 'fixture-capability' },
  })),
}));
vi.mock('../frontend/storage/access.js', () => ({ credentials: controls.credentials }));
vi.mock('../frontend/lib/log.js', () => ({
  Log: { headers: () => ({ 'x-earrr-request-id': 'fixture-request' }) },
}));
const submission: FeedbackSubmission = {
  rating: 4,
  message: 'A short piece of feedback.',
  replyEmail: null,
};
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('best-effort feedback delivery', () => {
  it('sends one bounded keepalive request under the identity captured at submission time', async () => {
    await expect(submitFeedback(submission)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/feedback');
    expect(new Headers(options?.headers).get('x-earrr-guest')).toBe('fixture-capability');
    expect(new Headers(options?.headers).get('x-earrr-client')).toBe('1');
    expect(options?.keepalive).toBe(true);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(options?.body))).toEqual(submission);
  });

  it.each([200, 202, 400, 401, 503])(
    'warns on HTTP %s without retrying, throwing into training, or logging private contents',
    async (status) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
      await expect(
        submitFeedback({ ...submission, replyEmail: 'reply@example.com' }),
      ).resolves.toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(`[feedback] Submission rejected (${status}).`);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('reply@example.com');
      expect(JSON.stringify(warning.mock.calls)).not.toContain(submission.message);
    },
  );

  it('warns once on a failed network request without queues or success claims', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValue(new TypeError('Network unavailable.'));
    await expect(submitFeedback(submission)).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[feedback] Submission failed (TypeError).');
  });
});

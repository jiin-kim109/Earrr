import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { Snapshot, ToolResult } from '../server/types/agent.types.js';
import type { ApiEnvelope, GuestSave } from '../shared/types/user.js';
import { intervalNames } from '../server/services/exercise/music.js';
import { verifyVoice } from './verify-voice.js';
import { verifyRounds } from './verify-rounds.js';
import { prepareIntervalLesson } from '../tests/interval-fixture.js';
import { audioEvidenceScript } from '../tests/browser-audio.js';
import { readCurrentMessages } from '../tests/browser-conversation.js';
import {
  expectDirectPlayback,
  expectOneSpokenReply,
  realtimeTraceScript,
  turnMarker,
} from '../tests/browser-realtime.js';

const port = 3102;
const origin = `http://127.0.0.1:${port}`;
const scopedGuest = process.argv.includes('--scoped-guest');
if (scopedGuest && !process.argv.includes('--voice-only'))
  throw new Error('--scoped-guest currently requires --voice-only.');
const server = spawn(process.execPath, [resolve('dist', 'server', 'main.js')], {
  env: {
    ...process.env,
    PORT: String(port),
    DATABASE_PATH: ':memory:',
    DATABASE_URL: '',
    ...(!scopedGuest ? { SUPABASE_URL: '', EARRR_LEGACY_STORAGE: '1' } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk: Buffer) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk: Buffer) => {
  serverOutput += chunk.toString();
});
let browser: Browser | null = null;
let guestToken: string | undefined;

async function guestAccess(save?: GuestSave) {
  const response = await fetch(`${origin}/api/workspaces/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-earrr-client': '1' },
    body: JSON.stringify(save ? { save } : {}),
  });
  if (!response.ok) throw new Error('The isolated native guest workspace could not be restored.');
  const result = (await response.json()) as ApiEnvelope<{ guestToken: string }>;
  guestToken = result.data.guestToken;
}

const snapshot = async (): Promise<Snapshot> => {
  if (scopedGuest && !guestToken) await guestAccess();
  const response = await fetch(`${origin}/api/state`, {
    headers: guestToken ? { 'x-earrr-guest': guestToken } : {},
  });
  if (!response.ok) throw new Error(`Local live-verification server returned ${response.status}.`);
  const result: Snapshot | ApiEnvelope<Snapshot> = await response.json();
  return 'data' in result ? result.data : result;
};

async function ready() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Live-verification server stopped: ${serverOutput}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Live-verification server did not start: ${lastError instanceof Error ? lastError.message : serverOutput}`,
  );
}

async function send(page: Page, text: string) {
  await page.locator('#coach-message').fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

async function assertOrderedFeedback(page: Page, state: Snapshot) {
  const text = (await readCurrentMessages(page)).at(-1)?.text ?? '';
  const nextAt = text.search(/\bnext\b/i);
  const feedbackAt = text.search(/correct|incorrect|not quite/i);
  expect(feedbackAt, 'A verdict precedes the transition').toBeGreaterThanOrEqual(0);
  expect(nextAt).toBeGreaterThan(feedbackAt);
  const feedback = text.slice(0, nextAt);
  for (const note of state.feedback!.example!.notes) {
    const match = /^([A-G])(b|#)?/.exec(note)!;
    const accidental =
      match[2] === 'b'
        ? '(?:[-\\s]*(?:flat|b|♭))'
        : match[2] === '#'
          ? '(?:[-\\s]*(?:sharp|#|♯))'
          : '';
    expect(feedback, `Feedback names the actual note ${note}`).toMatch(
      new RegExp(`\\b${match[1]}${accidental}(?=\\d|\\s|[.,;:!?)]|$)`, 'i'),
    );
  }
  const cue = state.current?.cue ?? '';
  const mode = cue.includes('ascending')
    ? /ascending|upward|rising/i
    : cue.includes('descending')
      ? /descending|downward|falling/i
      : /together|simultaneous|same time/i;
  expect(text.slice(nextAt), 'The next example mode follows its transition').toMatch(mode);
  console.log(`PASS ordered spoken feedback: ${text}`);
}

async function waitFor(
  page: Page,
  check: (state: Snapshot) => boolean,
  label: string,
  timeout = 70_000,
) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await snapshot();
    if (check(state)) {
      console.log(`PASS ${label}`);
      return state;
    }
    const alert = await page
      .getByRole('alert')
      .textContent({ timeout: 200 })
      .catch(() => null);
    if (alert) throw new Error(`${label}: ${alert}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const messages = await readCurrentMessages(page);
  throw new Error(
    `${label}: timed out. Current conversation: ${JSON.stringify(messages.slice(-6))}`,
  );
}

try {
  await ready();
  const initial = await snapshot();
  if (!initial.configured)
    throw new Error(
      'Live verification needs the Azure configuration in .env. No remote request was made.',
    );
  const harmonic = process.argv.includes('--harmonic');
  const intervals = harmonic || process.argv.includes('--intervals');
  if (intervals)
    await prepareIntervalLesson(origin, harmonic ? 'intervals-harmonic' : 'intervals-foundation');
  const baselineAnswers = (await snapshot()).totalAnswers;
  const selectedLesson = harmonic
    ? 'intervals-harmonic'
    : intervals
      ? 'intervals-foundation'
      : 'pitch-direction';
  if (process.argv.includes('--rounds')) {
    await verifyRounds(origin, snapshot);
  } else if (!process.argv.includes('--voice-only')) {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript({ content: audioEvidenceScript + realtimeTraceScript });
    const errors: string[] = [];
    const heardIntervals = new Map<string, number>();
    const demonstrations = new Map<string, number[]>();
    const requestedTools: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/agent/tools'))
        requestedTools.push(String(request.postDataJSON()?.name));
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (
        (response.url().endsWith('/api/agent/tools') || response.url().endsWith('/api/tools')) &&
        response.ok()
      ) {
        void response
          .json()
          .then((result: ToolResult) => {
            if (result.audio && result.playbackExerciseId && result.audio.events.length === 2) {
              heardIntervals.set(
                result.playbackExerciseId,
                Math.abs(result.audio.events[1]!.midi - result.audio.events[0]!.midi),
              );
            }
            if (result.teaching && result.audio)
              demonstrations.set(
                result.teaching.stepId,
                result.audio.events.map((event) => event.midi),
              );
          })
          .catch((error: unknown) =>
            errors.push(error instanceof Error ? error.message : 'Could not read test audio plan.'),
          );
      }
    });
    await page.goto(origin);
    if (process.argv.includes('--guitar')) {
      await page.getByRole('button', { name: /^Change instrument:/ }).click();
      await page.getByRole('menuitem', { name: 'Guitar', exact: true }).click();
      await waitFor(
        page,
        (state) => state.settings.instrument === 'guitar',
        'Guitar selected before one-click entry',
      );
    }
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await waitFor(
      page,
      (state) => state.session?.phase === 'teaching',
      'New lesson begins with unscored teaching',
    );
    if ((await snapshot()).teaching?.section === 'welcome') {
      await expectOneSpokenReply(page, 0, 'Welcome before the musical lesson');
      expect((await snapshot()).totalAnswers).toBe(baselineAnswers);
      await send(page, "Yes, let's start ear training.");
      await waitFor(
        page,
        (state) => state.session?.phase === 'teaching' && state.teaching?.section !== 'welcome',
        'Natural agreement starts the musical tutorial',
      );
    }
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'speaking',
      { timeout: 45_000 },
    );
    await expect(page.getByTestId('lesson-mode')).toHaveText('Tutorial');
    await expect(page.getByRole('button', { name: 'Skip tutorial', exact: true })).toHaveAttribute(
      'data-variant',
      'ghost',
    );
    if (intervals && !harmonic && !process.argv.includes('--teach')) {
      let marker = await turnMarker(page);
      const currentLesson = (await snapshot()).course.selectedLesson;
      await send(page, 'I mean the Intervals together lesson. Please move me to that lesson.');
      await expectOneSpokenReply(
        page,
        marker,
        'Locked named lesson gives its exercise prerequisite',
      );
      const blocked = await snapshot();
      expect(blocked.course.selectedLesson).toBe(currentLesson);
      expect(blocked.session?.phase).toBe('teaching');
      const response = (await readCurrentMessages(page)).at(-1)!.text;
      expect(response).toMatch(/locked|unlock|pass/i);
      expect(response).toMatch(/8\s*(?:\/|out of)\s*10|eight.*ten/i);
      expect(response).not.toMatch(/already in|which.*(?:intro|practice)/i);
      marker = await turnMarker(page);
      await page
        .getByRole('navigation', { name: 'Tutorial steps', exact: true })
        .locator('button[data-step-id="minor-third"]')
        .click();
      await waitFor(
        page,
        (state) => state.teaching?.stepId === 'major-third',
        'A selected tutorial step automatically continues after native speech and music',
      );
      expect((await snapshot()).totalAnswers).toBe(baselineAnswers);
      expect((await snapshot()).teaching?.example?.semitones).toBe(4);
    }
    if (process.argv.includes('--teach')) {
      if (!intervals || harmonic)
        throw new Error('The teaching comparison check requires --intervals without --harmonic.');
      await waitFor(
        page,
        (state) => state.teaching?.lastDemoId === 'major-third',
        'Tutor automatically explains and demonstrates both thirds',
        150_000,
      );
      expect(demonstrations.get('minor-third')).toEqual([60, 63, 63, 60]);
      expect(demonstrations.get('major-third')).toEqual([60, 64, 64, 60]);
      const teachingMarker = await turnMarker(page);
      await send(
        page,
        'Before we continue, what exactly is a semitone? Please explain without moving on.',
      );
      await expectOneSpokenReply(page, teachingMarker, 'Teaching follow-up');
      expect((await snapshot()).session?.phase).toBe('teaching');
      expect((await snapshot()).totalAnswers).toBe(baselineAnswers);
      demonstrations.delete('minor-third');
      await send(page, 'Please demonstrate the minor third again.');
      await waitFor(
        page,
        (state) => state.teaching?.stepId === 'minor-third' && state.teaching.autoContinue === true,
        'Switch to a different named teaching example',
      );
      await waitFor(
        page,
        (state) => state.teaching?.stepId === 'major-third',
        'Requested demo continues to the next explanation after playback',
      );
      // A repeated named demo may use labeled teaching or the silent replay tool.
      expect(demonstrations.get('minor-third')).toEqual([60, 63, 63, 60]);
      expect((await snapshot()).current).toBeNull();
      await page.screenshot({ path: 'test-results\\tutoring-desktop.png', fullPage: true });
      await send(page, 'Please continue the tutorial.');
      await waitFor(
        page,
        (state) => Boolean(state.teaching?.awaitingPractice && state.teaching.delivered),
        'Tutorial finishes with an invitation rather than automatically starting a question',
        180_000,
      );
      expect((await snapshot()).current).toBeNull();
      expect((await snapshot()).teaching?.autoContinue).toBe(false);
      const clarification = await turnMarker(page);
      await send(
        page,
        'Before we start, remind me what a semitone is. Please do not start exercises yet.',
      );
      await expectOneSpokenReply(page, clarification, 'Clarification at the tutorial handoff');
      expect((await snapshot()).session?.phase).toBe('teaching');
      expect((await snapshot()).current).toBeNull();
      expect((await snapshot()).totalAnswers).toBe(baselineAnswers);
    }
    let marker = await turnMarker(page);
    const toolMarker = requestedTools.length;
    await send(
      page,
      process.argv.includes('--teach') ? "Okay, I'm ready for the exercises now." : 'Skip',
    );
    const first = await waitFor(
      page,
      (state) => state.current?.skillId === selectedLesson,
      'Azure session stays in the selected lesson',
    );
    expect(first.session?.phase).toBe('practice');
    expect(requestedTools.slice(toolMarker)).toContain('start_practice');
    await expect(page.getByTestId('lesson-mode')).toHaveText('Exercise');
    expect(first.totalAnswers).toBe(baselineAnswers);
    const id = first.current!.id;
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'playing',
      { timeout: 30_000 },
    );
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 15_000 },
    );
    await expectOneSpokenReply(page, marker, 'Skip introduction into the first question');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').voicePeak), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0.005);
    expect(
      await page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').voiceFrames),
    ).toBeGreaterThan(10);
    const voice = await page.locator('#earrr-coach-audio').evaluate((element) =>
      element instanceof HTMLAudioElement
        ? {
            muted: element.muted,
            volume: element.volume,
            paused: element.paused,
            time: element.currentTime,
          }
        : null,
    );
    expect(voice).toMatchObject({ muted: false, volume: 0.8 });
    console.log(
      'PASS non-silent speech reaches the actual unmuted HTML audio player, not just captions',
    );
    console.log('PASS spoken prompt completes before deterministic musical playback');

    marker = await turnMarker(page);
    await send(page, "Wait, I didn't hear that. Could you play that one again?");
    await waitFor(
      page,
      (state) => state.current?.id === id && state.current.replayCount > 0,
      'Natural-language contextual replay preserves the exercise',
    );
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 30_000 },
    );
    await expectDirectPlayback(page, marker, 'replay_exercise', 'Replay request');

    marker = await turnMarker(page);
    const wrongInterval = heardIntervals.get(id) === 4 ? 3 : 4;
    await send(
      page,
      intervals
        ? `I think that is a ${intervalNames[wrongInterval]}.`
        : 'I think the second note went up, right?',
    );
    const scored = await waitFor(
      page,
      (state) => state.totalAnswers === baselineAnswers + 1,
      'Natural-language answer reaches deterministic scoring',
    );
    if (intervals) expect(scored.recentAttempts[0]?.grade.verdict).toBe('incorrect');
    else expect(scored.recentAttempts[0]?.answer?.direction).toBe('up');
    await expect(page.getByTestId('piano-diagram')).toHaveAttribute('data-example-id', id);
    await expect(page.getByTestId('grade-feedback')).not.toContainText(
      /Correct|Not quite|Partly correct/i,
    );
    const next = await waitFor(
      page,
      (state) => Boolean(state.current && state.current.id !== id),
      'Coach continues with a fresh question',
    );
    let nextId = next.current!.id;
    expect(next.current?.skillId).toBe(selectedLesson);
    await expectOneSpokenReply(page, marker, 'Answer, grading, and next question');
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 30_000 },
    );
    const answeredTranscript = await readCurrentMessages(page);
    const feedback = (await snapshot()).feedback!;
    expect(answeredTranscript.at(-1)?.role).toBe('assistant');
    expect(answeredTranscript.at(-1)?.text.length).toBeGreaterThan(10);
    expect(answeredTranscript.at(-1)?.text).toMatch(/\bnext\b/i);
    expect(answeredTranscript.at(-1)?.text).not.toMatch(/you can say|minor third, major third/i);
    expect(answeredTranscript.at(-1)?.text).not.toMatch(
      /(?:provide|send|need).*?(?:note names|MIDI|recording|playback description)/i,
    );
    if (intervals) await assertOrderedFeedback(page, await snapshot());
    expect(feedback.exerciseId).toBe(id);
    await expect(page.getByTestId('piano-diagram')).toHaveCount(0);
    console.log('PASS deterministic result shared with a naturally worded realtime reply');

    if (intervals) {
      const correctInterval = heardIntervals.get(nextId);
      if (correctInterval === undefined)
        throw new Error('The interval test did not capture its audio oracle.');
      marker = await turnMarker(page);
      await send(page, `That is a ${intervalNames[correctInterval]}.`);
      const correct = await waitFor(
        page,
        (state) => state.totalAnswers === baselineAnswers + 2,
        'Correct interval answer scored',
      );
      expect(correct.feedback?.grade.verdict).toBe('correct');
      await expectOneSpokenReply(page, marker, 'Correct interval feedback');
      await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
        'data-phase',
        'listening',
        { timeout: 30_000 },
      );
      const after = await snapshot();
      const dialogue = await readCurrentMessages(page);
      expect(dialogue.at(-1)?.role).toBe('assistant');
      expect(after.feedback?.grade.verdict).toBe('correct');
      expect(dialogue.at(-1)?.text).toMatch(/\bnext\b/i);
      expect(dialogue.at(-1)?.text).not.toMatch(/you can say|minor third, major third/i);
      await assertOrderedFeedback(page, after);
      nextId = after.current!.id;
      console.log('PASS correct and incorrect interval results remain deterministic');

      marker = await turnMarker(page);
      const answersBeforeReview = after.totalAnswers;
      await send(page, 'Was my previous answer correct? Please repeat the result.');
      await expectOneSpokenReply(page, marker, 'Review saved correctness');
      const reviewed = await snapshot();
      expect(reviewed.totalAnswers).toBe(answersBeforeReview);
      expect((await readCurrentMessages(page)).at(-1)?.role).toBe('assistant');
      console.log('PASS asking about correctness reads the saved grade without rescoring');
    }

    marker = await turnMarker(page);
    const beforeExplanation = await snapshot();
    await send(
      page,
      'What does a semitone mean in general? Please explain, without changing the current question.',
    );
    await expectOneSpokenReply(page, marker, 'Natural explanation after silent tool selection');
    const explained = await snapshot();
    expect(explained.current?.id).toBe(beforeExplanation.current?.id);
    expect(explained.totalAnswers).toBe(beforeExplanation.totalAnswers);
    expect((await readCurrentMessages(page)).at(-1)?.text).toMatch(
      /semitone|half.step|adjacent|neighbou?r/i,
    );

    marker = await turnMarker(page);
    await send(page, "I'm not sure. Could you give me a small clue?");
    await waitFor(
      page,
      (state) =>
        state.current?.id === nextId &&
        state.current.hintCount > 0 &&
        state.totalAnswers === baselineAnswers + (intervals ? 2 : 1),
      'Uncertainty gets a hint rather than a wrong-answer penalty',
    );
    await expectOneSpokenReply(page, marker, 'Hint request');
    await page.reload();
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 50_000 });
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'playing',
      { timeout: 30_000 },
    );
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 15_000 },
    );
    await expectDirectPlayback(page, 0, 'play_exercise', 'Reconnect the saved example');
    expect((await snapshot()).current?.id).toBe(nextId);
    console.log('PASS a fresh Azure connection restores the unanswered exercise after page reload');
    marker = await turnMarker(page);
    await send(page, 'I need a break. Hold on for a while.');
    await waitFor(page, (state) => state.session?.status === 'paused', 'Conversational pause');
    await expectOneSpokenReply(page, marker, 'Pause request');
    marker = await turnMarker(page);
    await send(page, "Okay, let's carry on.");
    await waitFor(
      page,
      (state) => state.session?.status === 'active' && state.current?.id === nextId,
      'Conversational resume preserves the unanswered question',
    );
    await expectDirectPlayback(page, marker, 'resume_session', 'Resume request');
    marker = await turnMarker(page);
    await send(page, "I'm done for today. Let's stop.");
    await waitFor(
      page,
      (state) => state.session === null,
      'Conversational ending saves the session',
    );
    await expectOneSpokenReply(page, marker, 'Session ending');
    await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
    expect((await snapshot()).session).toBeNull();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Start training', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await expect(page.locator('[data-message-role="user"]')).not.toHaveCount(0);
    expect((await snapshot()).totalAnswers).toBe(baselineAnswers + (intervals ? 2 : 1));
    expect(errors).toEqual([]);
    const checkpointResponse = await fetch(
      `${origin}/api/sessions/${scored.session!.id}/checkpoint`,
    );
    const checkpoint = await checkpointResponse.json();
    expect(checkpoint.state.session.id).toBe(scored.session!.id);
    expect(checkpoint.state).not.toHaveProperty('messages');
    console.log(
      'Live single-connection voice, tools, checkpoints, and durable grading passed. Test progress was in memory only.',
    );
    await browser.close();
    browser = null;
  }
  if (!process.argv.includes('--text-only') && !process.argv.includes('--rounds'))
    await verifyVoice(
      origin,
      snapshot,
      scopedGuest
        ? async (page) => {
            await expect(
              page.getByRole('button', { name: 'Start training', exact: true }),
            ).toBeVisible();
            await expect(page.getByRole('button', { name: /^Change instrument:/ })).toBeEnabled();
            const save = await page.evaluate(
              () =>
                new Promise<GuestSave>((done, fail) => {
                  const opening = indexedDB.open('earrr-learning', 1);
                  opening.onerror = () => fail(new Error('Native guest progress is unavailable.'));
                  opening.onsuccess = () => {
                    const db = opening.result;
                    const request = db.transaction('guest').objectStore('guest').get('save');
                    request.onsuccess = () => {
                      db.close();
                      request.result
                        ? done(request.result)
                        : fail(new Error('Native guest progress has not been saved.'));
                    };
                    request.onerror = () => {
                      db.close();
                      fail(new Error('Native guest progress could not be read.'));
                    };
                  };
                }),
            );
            await guestAccess(save);
          }
        : undefined,
    );
} catch (error) {
  try {
    const state = await snapshot();
    const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [];
    console.error(
      'Live diagnostics:',
      JSON.stringify({
        current: state.current,
        session: state.session,
        conversation: pages[0] ? (await readCurrentMessages(pages[0])).slice(-8) : [],
        protocol: pages[0]
          ? await pages[0].evaluate(() => Reflect.get(window, 'earrrProtocolTrace'))
          : undefined,
      }),
    );
  } catch (diagnosticError) {
    console.error(
      'Live diagnostics unavailable:',
      diagnosticError instanceof Error ? diagnosticError.message : 'Unknown diagnostic error',
    );
  }
  throw error;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

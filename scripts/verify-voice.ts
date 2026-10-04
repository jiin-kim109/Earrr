import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { Snapshot } from '../server/types/agent.types.js';
import { audioEvidenceScript } from '../tests/browser-audio.js';
import { readCurrentMessages } from '../tests/browser-conversation.js';
import {
  expectDirectPlayback,
  expectOneSpokenReply,
  realtimeTraceScript,
  turnMarker,
} from '../tests/browser-realtime.js';

declare global {
  interface Window {
    earrrMessageMounts: Record<string, { count: number; animation: string }>;
    earrrVoiceFixture: {
      say: (base64: string) => Promise<void>;
      released: () => boolean;
      previewReleased: () => boolean;
    };
  }
}

export async function verifyVoice(
  origin: string,
  snapshot: () => Promise<Snapshot>,
  beforeJoin?: (page: Page) => Promise<void>,
) {
  const generated = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-File', resolve('scripts', 'make-voice-fixtures.ps1')],
    { encoding: 'utf8' },
  );
  if (generated.status !== 0)
    throw new Error(`Synthetic voice generation failed: ${generated.stderr || generated.stdout}`);
  mkdirSync(resolve('test-results'), { recursive: true });
  const profile = mkdtempSync(resolve('test-results', 'live-browser-'));
  // Attach without Playwright's default forced-focus emulation or timer overrides.
  const native = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--mute-audio',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let browser: Browser | null = null;
  try {
    const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('The isolated Chromium verification browser did not start.')),
        25_000,
      );
      native.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      native.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Verification browser exited with code ${code}.`));
      });
      native.stderr.on('data', (chunk: Buffer) => {
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timeout);
          resolveEndpoint(match[1]!);
        }
      });
    });
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = browser.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.newPage());
    let connections = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/realtime/connect')) connections++;
    });
    await page.addInitScript({
      content:
        audioEvidenceScript +
        realtimeTraceScript +
        `(() => {
      window.earrrMessageMounts = {};
      new MutationObserver((changes) => {
        for (const change of changes) for (const node of change.addedNodes) {
          if (!(node instanceof Element)) continue;
          const selector = '[data-message-role="user"][data-message-id]';
          const messages = [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)];
          for (const message of messages) {
            const id = message.getAttribute('data-message-id');
            window.earrrMessageMounts[id] = {
              count: (window.earrrMessageMounts[id]?.count ?? 0) + 1,
              animation: getComputedStyle(message).animationName,
            };
          }
        }
      }).observe(document, { childList: true, subtree: true });
      const audio = new AudioContext({ sampleRate: 24_000 });
      const destination = audio.createMediaStreamDestination();
      const issued = [];
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
        configurable: true,
        value: async () => [{ kind:'audioinput', deviceId:'virtual', label:'Test microphone', groupId:'test', toJSON(){ return {}; } }]
      });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => { await audio.resume(); const stream=destination.stream.clone(); issued.push(...stream.getTracks()); return stream; },
      });
      window.earrrVoiceFixture = {
        say: async (base64) => {
          await audio.resume();
          const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
          const buffer = await audio.decodeAudioData(bytes.buffer);
          const source = audio.createBufferSource();
          source.buffer = buffer;
          source.connect(destination);
          await new Promise((finished) => {
            source.onended = () => { source.disconnect(); finished(); };
            source.start();
          });
        },
        released: () => issued.length > 0 && issued.every((track) => track.readyState === 'ended'),
        previewReleased: () => issued.length > 0 && issued[0].readyState === 'ended',
      };
    })();`,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin);
    await beforeJoin?.(page);
    expect(await page.evaluate(() => typeof window.earrrVoiceFixture?.say)).toBe('function');
    await page.getByRole('radio', { name: 'Test microphone', exact: true }).click();
    await expect(page.getByTestId('microphone-meter')).toHaveAttribute('data-active', 'true');
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.earrrVoiceFixture.previewReleased()))
      .toBe(true);
    console.log('PASS prejoin microphone preview is released before connecting');
    const baseline = (await snapshot()).totalAnswers;

    const wait = async (predicate: (state: Snapshot) => boolean, label: string) => {
      const started = Date.now();
      while (Date.now() - started < 65_000) {
        const state = await snapshot();
        if (predicate(state)) {
          console.log(`PASS ${label}`);
          return state;
        }
        if (await page.getByRole('alert').count())
          throw new Error(`${label}: ${await page.getByRole('alert').textContent()}`);
        await new Promise((done) => setTimeout(done, 400));
      }
      throw new Error(
        `${label} timed out. Current conversation: ${JSON.stringify((await readCurrentMessages(page)).slice(-5))}`,
      );
    };
    const speak = async (file: string) => {
      const encoded = readFileSync(resolve('test-results', file)).toString('base64');
      await page.evaluate((data) => window.earrrVoiceFixture.say(data), encoded);
    };

    await wait((state) => state.session?.mode === 'coach', 'Microphone-mode Azure session');
    await expect(page.getByTestId('microphone-indicator')).toHaveAttribute('data-active', 'true', {
      timeout: 45_000,
    });
    let firstMarker = 0;
    if ((await snapshot()).session?.phase === 'teaching') {
      await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
        'data-phase',
        'speaking',
        { timeout: 45_000 },
      );
      firstMarker = await turnMarker(page);
      const spokenSkip = speak('voice-skip-intro.wav');
      await expect
        .poll(async () =>
          Number(await page.getByTestId('microphone-indicator').getAttribute('data-level')),
        )
        .toBeGreaterThan(0.05);
      await spokenSkip;
      await wait(
        (state) => state.session?.phase === 'practice' && Boolean(state.current),
        'A spoken skip leaves teaching without scoring a demo',
      );
      expect((await snapshot()).totalAnswers).toBe(baseline);
    }
    const first = await wait(
      (state) => Boolean(state.current && state.session?.phase === 'practice'),
      'Practice follows the introduction',
    );
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 40_000 },
    );
    await expectOneSpokenReply(page, firstMarker, 'Voice-mode initial practice prompt');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').voicePeak))
      .toBeGreaterThan(0.005);
    console.log('PASS coach voice has measured non-silent audio at the playback element');
    const id = first.current!.id;

    await page.getByRole('button', { name: 'Microphone settings', exact: true }).click();
    await page.getByRole('radio', { name: 'None', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.earrrVoiceFixture.released())).toBe(true);
    let mixedMarker = await turnMarker(page);
    await page.locator('#coach-message').fill('Please play that again.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await wait(
      (state) => state.current?.id === id && state.current.replayCount > 0,
      'Typing works after microphone capture is released',
    );
    await expectDirectPlayback(
      page,
      mixedMarker,
      'replay_exercise',
      'Keyboard replay in the same voice session',
    );
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Microphone settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Test microphone', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Turn microphone off', exact: true }),
    ).toBeEnabled();
    await page.keyboard.press('Escape');
    expect((await snapshot()).session?.id).toBe(first.session!.id);
    expect(connections).toBe(1);
    console.log('PASS microphone off/on and keyboard input reuse one realtime connection');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#coach-message').fill('An unfinished thought');
    await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
    await expect(page.getByRole('log', { name: 'Practice conversation' })).toBeVisible();
    await expect(page.getByTestId('microphone-indicator')).toHaveAttribute('data-active', 'true');
    await page.getByRole('button', { name: 'Minimize conversation', exact: true }).click();
    await expect(page.locator('#coach-message')).toHaveValue('An unfinished thought');
    expect((await snapshot()).current?.id).toBe(id);
    expect(connections).toBe(1);
    await page.locator('#coach-message').fill('');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(
      page.getByRole('log', { name: 'Practice conversation', exact: true }),
    ).toBeVisible();
    const existingMessages = new Set(
      (await readCurrentMessages(page)).map((message) => message.id),
    );
    await page.evaluate(() => {
      window.earrrMessageMounts = {};
    });

    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState), { timeout: 5_000 })
      .toBe('hidden');
    console.log('PASS practice tab is truly hidden, with normal browser background behavior');

    let marker = await turnMarker(page);
    await speak('voice-replay.wav');
    await wait(
      (state) => state.current?.id === id && state.current.replayCount > 1,
      'Spoken contextual replay in a hidden tab',
    );
    await wait(
      (state) => Boolean(state.session && state.session.listened >= 3),
      'Deterministic audio starts while the tab remains hidden',
    );
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 30_000 },
    );
    await expectDirectPlayback(page, marker, 'replay_exercise', 'Spoken replay');
    marker = await turnMarker(page);
    await speak('voice-answer.wav');
    const graded = await wait(
      (state) => state.totalAnswers === baseline + 1,
      'Spoken answer reaches deterministic grading in the background',
    );
    expect(graded.recentAttempts[0]?.answer?.direction).toBe('up');
    let next = await wait(
      (state) => Boolean(state.current && state.current.id !== id),
      'Fresh exercise follows a spoken answer',
    );
    expect(next.current?.skillId).toBe(first.current?.skillId);
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 30_000 },
    );
    await expectOneSpokenReply(page, marker, 'Spoken answer and next question');
    const transcript = await readCurrentMessages(page);
    const replyIndex = transcript.map((item) => item.role).lastIndexOf('assistant');
    const userIndex = transcript.map((item) => item.role).lastIndexOf('user');
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeLessThan(replyIndex);
    expect(transcript.slice(userIndex + 1).every((item) => item.role === 'assistant')).toBe(true);
    const feedback = (await snapshot()).feedback!;
    expect(feedback.grade).toEqual(graded.recentAttempts[0]!.grade);
    console.log('PASS voice answer reaches deterministic grading with native spoken feedback');
    const mounts = Object.entries(await page.evaluate(() => window.earrrMessageMounts))
      .filter(([id]) => !existingMessages.has(id))
      .map(([, message]) => message);
    expect(mounts.length).toBeGreaterThanOrEqual(2);
    expect(mounts.every((message) => message.count === 1 && message.animation !== 'none')).toBe(
      true,
    );
    console.log(
      'PASS microphone captions animate once and retain their DOM identity while updating',
    );

    marker = await turnMarker(page);
    await speak('voice-down.wav');
    const down = await wait(
      (state) => state.totalAnswers === baseline + 2,
      'A short spoken down answer reaches grading without a clarification loop',
    );
    expect(down.recentAttempts[0]?.answer?.direction).toBe('down');
    next = await wait(
      (state) => Boolean(state.current && state.current.id !== next.current!.id),
      'Another question follows the short down answer',
    );
    await expectOneSpokenReply(page, marker, 'Short down answer');
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 30_000 },
    );

    marker = await turnMarker(page);
    await speak('voice-pause.wav');
    await wait((state) => state.session?.status === 'paused', 'Spoken background pause');
    await expectOneSpokenReply(page, marker, 'Spoken pause');
    marker = await turnMarker(page);
    await speak('voice-resume.wav');
    await wait(
      (state) => state.session?.status === 'active' && state.current?.id === next.current!.id,
      'Spoken background resume preserves context',
    );
    await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
      'data-phase',
      'listening',
      { timeout: 30_000 },
    );
    await expectDirectPlayback(page, marker, 'resume_session', 'Spoken resume');
    marker = await turnMarker(page);
    await speak('voice-stop.wav');
    await wait((state) => state.session === null, 'Spoken background session ending');
    await expectOneSpokenReply(page, marker, 'Spoken ending');
    await expect
      .poll(() => page.evaluate(() => window.earrrVoiceFixture.released()), { timeout: 30_000 })
      .toBe(true);
    expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
    console.log('PASS microphone tracks are released after the spoken goodbye');
  } finally {
    if (browser?.isConnected()) {
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/Target.*closed|Session.*closed|Connection closed/i.test(error.message)
        )
          throw error;
      }
      await browser.close();
    }
    if (native.exitCode === null && native.signalCode === null) {
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => {
          if (!native.kill()) reject(new Error('The isolated voice browser could not be stopped.'));
        }, 5_000);
        const deadline = setTimeout(
          () => reject(new Error('The isolated voice browser did not exit.')),
          15_000,
        );
        native.once('exit', () => {
          clearTimeout(timeout);
          clearTimeout(deadline);
          done();
        });
      });
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

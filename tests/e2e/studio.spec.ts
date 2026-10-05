import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Snapshot, ToolResult } from '../../server/types/agent.types.js';
import { intervalNames } from '../../server/services/exercise/music.js';
import { sampleFor } from '../../frontend/audio/samples.js';
import { audioEvidenceScript } from '../browser-audio.js';
import { controlledCoachScript } from '../browser-coach.js';
import { prepareIntervalLesson } from '../interval-fixture.js';

let chatEpoch = '';
function isolateChat(body: Snapshot | ToolResult) {
  const snapshot = 'snapshot' in body ? body.snapshot : body;
  snapshot.transcript = snapshot.transcript.filter((message) => message.createdAt >= chatEpoch);
}
test.beforeEach(async ({ request, page }) => {
  chatEpoch = new Date().toISOString();
  await page.route(
    /\/api\/(?:state|tools|agent\/tools|solo\/answer|teaching\/delivered)$/,
    async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const body: Snapshot | ToolResult = await response.json();
      isolateChat(body);
      await route.fulfill({ response, json: body });
    },
  );
  const state: Snapshot = await (await request.get('/api/state')).json();
  const headers = { 'x-earrr-client': '1' };
  if (state.session)
    await request.post('/api/tools', {
      headers,
      data: {
        callId: randomUUID(),
        sessionId: state.session.id,
        name: 'end_session',
        arguments: {},
      },
    });
  await request.post('/api/tools', {
    headers,
    data: {
      callId: randomUUID(),
      name: 'select_lesson',
      arguments: { skillId: 'pitch-direction' },
    },
  });
  await request.put('/api/settings', {
    headers,
    data: { instrument: 'piano', volume: 0.8, voice: 'sage', timezone: 'UTC' },
  });
  const ready = await freshPitchRound(request);
  await request.post('/api/tools', {
    headers,
    data: {
      callId: randomUUID(),
      sessionId: ready.session!.id,
      name: 'end_session',
      arguments: {},
    },
  });
});

const enter = (page: Page) =>
  page.getByRole('button', { name: /^(Practice offline|Start training)$/ }).click();
const player = (page: Page) => page.getByLabel('Exercise player', { exact: true });
const fixedTitle = 'Earrr | Ear training game with a friendly AI tutor.';
async function noPageScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        horizontal: document.documentElement.scrollWidth > innerWidth,
        vertical: document.documentElement.scrollHeight > innerHeight,
      })),
    )
    .toEqual({ horizontal: false, vertical: false });
}
async function settledOverlays(page: Page) {
  await expect(page.locator('[data-slot="popover-content"][data-state="closed"]')).toHaveCount(0);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().iterations))
        .map((animation) =>
          animation.finished.catch((error: unknown) => {
            if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error;
          }),
        ),
    ),
  );
}
async function chooseInstrument(page: Page, name: 'Piano' | 'Guitar') {
  if (!(await page.getByRole('button', { name: /^Change instrument:/ }).isVisible()))
    await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  await page.getByRole('button', { name: /^Change instrument:/ }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function mockConfigured(page: Page, includeWelcome = false) {
  await page.route(/\/api\/(?:state|tools|agent\/tools)$/, async (route) => {
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const body: Snapshot | ToolResult = await response.json();
    const snapshot = 'snapshot' in body ? body.snapshot : body;
    snapshot.configured = true;
    isolateChat(body);
    if (!includeWelcome) snapshot.course.welcomeSeen = true;
    await route.fulfill({ response, json: body });
  });
}

async function controlledCoach(page: Page) {
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  await page.route('**/api/realtime/connect', (route) =>
    route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    }),
  );
}

async function captionReply(page: Page, text: string, preceding?: string) {
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
    .toBe(true);
  if (preceding)
    await page.evaluate((text) => Reflect.get(window, 'earrrCoachFixture').delta(text), preceding);
  await page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').tool('inspect_progress', {}));
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
    .toBe(true);
  await page.evaluate((text) => Reflect.get(window, 'earrrCoachFixture').reply(text), text);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
}

async function freshPitchRound(request: APIRequestContext) {
  const headers = { 'x-earrr-client': '1' };
  const start: ToolResult = await (
    await request.post('/api/tools', {
      headers,
      data: {
        callId: randomUUID(),
        name: 'start_session',
        arguments: { mode: 'solo' },
      },
    })
  ).json();
  const sessionId = start.snapshot.session!.id;
  const call = async (name: string, args: object = {}) => {
    const response = await request.post('/api/tools', {
      headers,
      data: { callId: randomUUID(), sessionId, name, arguments: args },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as ToolResult;
  };
  let state = start.snapshot;
  if (state.session?.awaitingRoundChoice) state = (await call('start_round')).snapshot;
  for (let attempt = 0; attempt < 10 && state.course.round.answers.length; attempt++) {
    const question = await call('play_exercise');
    const [first, second] = question.audio!.events;
    state = (
      await call('submit_answer', {
        exerciseId: question.snapshot.current!.id,
        answer: { direction: second!.midi > first!.midi ? 'down' : 'up' },
      })
    ).snapshot;
  }
  if (state.session?.awaitingRoundChoice) return (await call('start_round')).snapshot;
  return (await call('play_exercise')).snapshot;
}

test('shows only essential setup without capturing a microphone whose permission is already granted', async ({
  page,
}) => {
  await page.context().grantPermissions(['microphone']);
  await page.addInitScript({ content: audioEvidenceScript });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Get ready.', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Microphone', exact: true })).toHaveCount(1);
  await expect(page.getByTestId('microphone-meter')).toHaveAttribute('data-active', 'false');
  await expect(
    page.getByTestId('setup-music').getByText('Instrument sound', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Speakers', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Speaker volume', exact: true })).toHaveCount(1);
  await expect(page.getByRole('slider')).toHaveCount(1);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByTestId('instrument-piano').locator('svg text')).toHaveCount(0);
  const instrumentBox = (await page
    .getByLabel('Instrument preview', { exact: true })
    .boundingBox())!;
  const settingsBox = (await page
    .getByLabel('Microphone and speaker setup', { exact: true })
    .boundingBox())!;
  expect(settingsBox.x).toBeGreaterThan(instrumentBox.x + instrumentBox.width);
  await expect(page.getByRole('heading', { name: 'Earrr', exact: true })).toBeVisible();
  await expect(page.getByTestId('setup-tagline')).toHaveText(
    'Ear training game with a friendly AI tutor.',
  );
  for (const text of [
    'Not connected',
    'Your listening studio',
    'Typing is always available',
    'Your next lesson',
    'Ready when you are',
  ]) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
  expect(
    await page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').microphoneRequests),
  ).toBe(0);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: 'test-results\\compact-setup-piano.png',
    fullPage: true,
    animations: 'disabled',
  });
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`makes Log In prominent and centers minimal account screens at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page).toHaveTitle(fixedTitle);
    const login = page.getByRole('button', { name: 'Log In', exact: true });
    let button = (await login.boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(40);
    expect(button.width).toBeGreaterThanOrEqual(96);
    await expect(login).toHaveAttribute('data-variant', 'outline');
    const header = (await page.getByRole('banner').boundingBox())!;
    expect(button.y - header.y).toBeGreaterThanOrEqual(10);
    await enter(page);
    await expect(player(page)).toBeVisible();
    await expect(page).toHaveTitle(fixedTitle);
    button = (await login.boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(40);
    await login.click();
    await expect(page).toHaveTitle(fixedTitle);
    await expect(
      page.getByRole('heading', { name: "Don't have an account?", exact: true }),
    ).toBeVisible();
    await expect(page.getByText('New here?', { exact: true })).toHaveCount(0);
    const panel = (await page
      .getByRole('region', { name: 'Welcome back.', exact: true })
      .boundingBox())!;
    expect(panel.x + panel.width / 2).toBeCloseTo(viewport.width / 2, 0);
    const back = (await page
      .getByRole('button', { name: 'Back to learning', exact: true })
      .boundingBox())!;
    const form = (await page
      .getByRole('form', { name: 'Welcome back.', exact: true })
      .boundingBox())!;
    if (viewport.width > 1024) {
      expect(Math.abs((back.y + form.y + form.height) / 2 - viewport.height / 2)).toBeLessThan(64);
    }
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results\\centered-login-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const create = page.getByRole('button', { name: 'Create an account', exact: true });
    await expect(create).toHaveAttribute('data-variant', 'text');
    await create.click();
    await expect(page).toHaveTitle(fixedTitle);
    await expect(
      page.getByRole('heading', { name: 'Create an account.', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(page.getByText('Keep your progress.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Already have an account?', { exact: true })).toHaveCount(0);
    const signup = (await page
      .getByRole('form', { name: 'Create an account.', exact: true })
      .boundingBox())!;
    expect(signup.x + signup.width / 2).toBeCloseTo(viewport.width / 2, 0);
    await page.screenshot({
      path: `test-results\\single-signup-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Back to learning', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Practice offline', exact: true })).toBeVisible();
    await enter(page);
    await expect(player(page)).toBeVisible();
  });
}

test('requests missing microphone permission on entry before backend hydration or any device click', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.set(window, 'entryPermission', { requests: 0, stops: 0 });
    Reflect.set(navigator.permissions, 'query', async () => ({ state: 'prompt' }));
    navigator.mediaDevices.getUserMedia = async () => {
      const evidence = Reflect.get(window, 'entryPermission');
      evidence.requests++;
      const stream = new MediaStream();
      Reflect.set(stream, 'getTracks', () => [
        {
          stop: () => {
            evidence.stops++;
          },
        },
      ]);
      return stream;
    };
  });
  let ready!: () => void;
  const pending = new Promise<void>((resolve) => {
    ready = resolve;
  });
  await page.route('**/api/config', async (route) => {
    await pending;
    await route.fallback();
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'entryPermission').requests))
      .toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'entryPermission').stops))
      .toBe(1);
    await expect(page.getByRole('button', { name: 'Start training', exact: true })).toBeEnabled();
    await expect(page.getByTestId('microphone-meter')).toHaveAttribute('data-active', 'false');
    ready();
    await enter(page);
    await expect(player(page)).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'entryPermission').requests)).toBe(1);
  } finally {
    ready();
  }
});

test('retries missing microphone permission only from microphone settings and lists explicit inputs', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const evidence = { requests: 0, permission: 'prompt' };
    Reflect.set(window, 'micRetryEvidence', evidence);
    Reflect.set(navigator.permissions, 'query', async () => ({ state: evidence.permission }));
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        deviceId: 'default',
        kind: 'audioinput',
        label: 'System microphone',
        groupId: 'g',
        toJSON() {
          return {};
        },
      },
      {
        deviceId: 'communications',
        kind: 'audioinput',
        label: 'Communications',
        groupId: 'g',
        toJSON() {
          return {};
        },
      },
      {
        deviceId: '',
        kind: 'audioinput',
        label: '',
        groupId: 'g',
        toJSON() {
          return {};
        },
      },
      {
        deviceId: 'usb-mic',
        kind: 'audioinput',
        label: 'USB microphone',
        groupId: 'g',
        toJSON() {
          return {};
        },
      },
    ];
    navigator.mediaDevices.getUserMedia = async () => {
      evidence.requests++;
      if (evidence.requests === 1) {
        evidence.permission = 'denied';
        throw new DOMException('Denied', 'NotAllowedError');
      }
      evidence.permission = 'granted';
      return new MediaStream();
    };
  });
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'micRetryEvidence').requests))
    .toBe(1);
  const inputs = page.getByRole('radiogroup', { name: 'Microphone', exact: true });
  await expect(inputs.getByRole('radio')).toHaveCount(2);
  await expect(inputs.getByRole('radio', { name: 'None', exact: true })).toBeChecked();
  await expect(inputs.getByRole('radio', { name: 'USB microphone', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'System microphone', exact: true })).toHaveCount(0);
  await enter(page);
  await expect(player(page)).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'micRetryEvidence').requests)).toBe(1);
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'micRetryEvidence').requests)).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'micRetryEvidence').requests))
    .toBe(2);
  const popup = page.getByRole('dialog', { name: 'Microphone settings', exact: true });
  await expect(popup.getByRole('radio')).toHaveCount(2);
  await expect(popup.getByRole('radio', { name: 'USB microphone', exact: true })).toBeVisible();
  await expect(popup.getByRole('radio', { name: 'System microphone', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('microphone-meter')).toHaveAttribute('data-active', 'false');
});

test('uses native output permission only when a selected speaker actually requires it', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const evidence = { authorized: false, requests: 0 };
    Reflect.set(window, 'speakerPermissionEvidence', evidence);
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        deviceId: 'headphones',
        kind: 'audiooutput',
        label: 'Headphones',
        groupId: 'g',
        toJSON() {
          return {};
        },
      },
    ];
    const output = async (id: string) => {
      if (id === 'headphones' && !evidence.authorized)
        throw new DOMException('Output permission required.', 'NotAllowedError');
    };
    Object.defineProperty(AudioContext.prototype, 'setSinkId', {
      configurable: true,
      value: output,
    });
    HTMLMediaElement.prototype.setSinkId = output;
    Reflect.set(navigator.mediaDevices, 'selectAudioOutput', async () => {
      evidence.requests++;
      evidence.authorized = true;
      return {
        deviceId: 'headphones',
        kind: 'audiooutput',
        label: 'Headphones',
        groupId: 'g',
        toJSON() {
          return {};
        },
      };
    });
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Headphones', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Headphones', exact: true })).toBeChecked();
  expect(await page.evaluate(() => Reflect.get(window, 'speakerPermissionEvidence').requests)).toBe(
    1,
  );
  await expect(page.getByTestId('audio-notice-setup')).toHaveCount(0);
});

test('plays piano keys and guitar string/fret notes without scoring practice', async ({
  page,
  request,
}) => {
  await page.addInitScript({ content: audioEvidenceScript });
  await page.goto('/');
  const piano = page.getByTestId('instrument-piano').first();
  await piano.getByRole('button', { name: 'Play C4', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').pianoPeak))
    .toBeGreaterThan(0.01);
  await piano.getByRole('button', { name: 'Play C4', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(piano.getByRole('button', { name: 'Play C sharp4', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await chooseInstrument(page, 'Guitar');
  const guitar = page.getByTestId('instrument-guitar').first();
  await expect(guitar.locator('svg text')).toHaveCount(0);
  await expect(guitar.locator('[data-fret-wire]')).toHaveCount(19);
  await expect(guitar.getByRole('button')).toHaveCount(120);
  await expect(
    guitar.getByRole('button', { name: 'String 6, fret 0, E2', exact: true }),
  ).toHaveAttribute('data-midi', '40');
  await expect(
    guitar.getByRole('button', { name: 'String 1, fret 12, E5', exact: true }),
  ).toHaveAttribute('data-midi', '76');
  const sample = page.waitForResponse(
    (response) => response.url().includes('/audio/guitar/') && response.ok(),
  );
  await guitar.getByRole('button', { name: 'String 6, fret 0, E2', exact: true }).click();
  await sample;
  await guitar.getByRole('button', { name: 'String 1, fret 12, E5', exact: true }).click();
  for (const [index, open] of [64, 59, 55, 50, 45, 40].entries()) {
    const note = guitar.locator(`[data-string="${index + 1}"][data-fret="19"]`);
    const midi = open + 19;
    await expect(note).toHaveAttribute('data-midi', String(midi));
    const count = await page.evaluate(
      () => Reflect.get(window, 'earrrAudioEvidence').sampleVoices.length,
    );
    await note.click();
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').sampleVoices.length),
      )
      .toBeGreaterThan(count);
    const rate = await page.evaluate(
      () => Reflect.get(window, 'earrrAudioEvidence').sampleVoices.at(-1).playbackRate,
    );
    expect(rate).toBeCloseTo(2 ** ((midi - sampleFor('guitar', midi).midi) / 12), 5);
  }
  const upper = guitar.locator('[data-string="1"][data-fret="19"]');
  await upper.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(upper).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(guitar.locator('[data-string="2"][data-fret="19"]')).toBeFocused();
  const state: Snapshot = await (await request.get('/api/state')).json();
  expect(state.session).toBeNull();
  expect(state.settings.instrument).toBe('guitar');
  expect(
    await page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').pianoPeak),
  ).toBeLessThan(0.95);
  await page.screenshot({
    path: 'test-results\\compact-setup-guitar.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('starts practice with one click, shows musical playback, and removes redundant controls', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  expect(((await (await request.get('/api/state')).json()) as Snapshot).session?.mode).toBe('solo');
  await expect(page.getByTestId('playback-indicator')).toHaveCount(0);
  await expect(page.getByTestId('coach-waveform')).toHaveAttribute('data-active', 'false');
  await expect(page.getByRole('button', { name: 'Audio settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change instrument: Piano' })).toHaveCount(0);
  await expect(page.getByTestId('lesson-mode')).toHaveText('Exercise');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  for (const name of [
    'Hint',
    'Teach me this lesson',
    'Guide & examples',
    'Pause session',
    'End session',
    'Choose microphone',
    'Toggle lessons',
    'Open lessons',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(player(page).locator('footer')).toHaveCount(0);
  await expect(page.getByText(/\bXP\b/)).toHaveCount(0);
  await expect(page.getByText('Disabled', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Enabled', { exact: true })).toHaveCount(0);
  const micBox = (await page
    .getByRole('button', { name: 'Microphone settings', exact: true })
    .boundingBox())!;
  const messageBox = (await page.getByLabel('Message', { exact: true }).boundingBox())!;
  expect(micBox.x).toBeGreaterThan(messageBox.x + messageBox.width);
  expect(
    Math.abs(micBox.y + micBox.height / 2 - (messageBox.y + messageBox.height / 2)),
  ).toBeLessThan(12);
  const selected = page
    .getByRole('navigation', { name: 'Chapters and lessons' })
    .locator('[aria-current="step"]');
  expect(
    await selected.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(14);
  expect(await selected.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await expect(selected.getByTestId('lesson-status').locator('span')).toHaveCount(0);
  for (const text of [
    'Your coach',
    'Here with you',
    'With your coach',
    'Typing mode',
    'No rush. Every replay is free.',
    'Message your coach',
    'Not connected',
  ]) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  await expect(page.getByTestId('instrument-piano').first().getByRole('button')).toHaveCount(0);
  const illustration = await page
    .getByTestId('instrument-piano')
    .first()
    .locator('svg')
    .boundingBox();
  expect(illustration!.width).toBeGreaterThanOrEqual(50);
  await page.keyboard.press('Escape');
  await settledOverlays(page);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: 'test-results\\compact-training.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('combines speaker, master volume and fixed-size instrument controls without changing the question', async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const audio: ToolResult[] = [];
  page.on('response', (response) => {
    if (response.url().endsWith('/api/tools') && response.ok())
      void response.json().then((result: ToolResult) => {
        if (result.audio) audio.push(result);
      });
  });
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const before: Snapshot = await (await request.get('/api/state')).json();
  const toolbar = (await page.getByTestId('lesson-toolbar').boundingBox())!;
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Audio settings', exact: true });
  await expect(popup.getByRole('radiogroup', { name: 'Speakers', exact: true })).toBeVisible();
  await expect(popup.getByText('Instrument sound', { exact: true })).toBeVisible();
  await expect(popup.getByRole('slider')).toHaveCount(1);
  const popupBefore = (await popup.boundingBox())!;
  const pickerBefore = (await popup
    .getByRole('button', { name: /^Change instrument:/ })
    .boundingBox())!;
  await chooseInstrument(page, 'Guitar');
  await expect
    .poll(
      async () =>
        ((await (await request.get('/api/state')).json()) as Snapshot).settings.instrument,
    )
    .toBe('guitar');
  const pickerAfter = (await popup
    .getByRole('button', { name: /^Change instrument:/ })
    .boundingBox())!;
  expect(pickerAfter).toEqual(pickerBefore);
  expect(await popup.boundingBox()).toEqual(popupBefore);
  expect(await page.getByTestId('lesson-toolbar').boundingBox()).toEqual(toolbar);
  await expect(page.getByTestId('instrument-guitar').first().getByRole('button')).toHaveCount(0);
  const volume = popup.getByRole('slider', { name: 'Speaker volume', exact: true });
  await volume.focus();
  await page.keyboard.press('Home');
  await expect
    .poll(
      async () => ((await (await request.get('/api/state')).json()) as Snapshot).settings.volume,
    )
    .toBe(0);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(
      async () => ((await (await request.get('/api/state')).json()) as Snapshot).settings.volume,
    )
    .toBe(0.05);
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Audio settings', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Hear again', exact: true }).click();
  await expect.poll(() => audio.at(-1)?.audio?.instrument).toBe('guitar');
  expect(audio.at(-1)?.audio?.events).toEqual(audio[0]?.audio?.events);
  expect(audio.at(-1)?.snapshot.current?.id).toBe(before.current?.id);
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`keeps training inside the viewport at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByLabel('Instrument preview', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    await noPageScroll(page);
    await expect(
      page.getByRole('separator', { name: 'Resize exercise and conversation' }),
    ).toBeVisible();
  });
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`keeps one speaker volume and a labeled instrument selector at ${viewport.width}x${viewport.height}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const volume = page.getByRole('slider', { name: 'Speaker volume', exact: true });
    await expect(volume).toHaveAttribute('aria-valuenow', '80');
    await expect(page.getByRole('slider')).toHaveCount(1);
    await expect(page.getByText('Tutor voice', { exact: true })).toHaveCount(0);
    await expect(
      page.getByTestId('setup-music').getByText('Instrument sound', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: join('test-results', `speaker-volume-setup-${viewport.width}.png`),
      animations: 'disabled',
      fullPage: true,
    });
    await volume.focus();
    await page.keyboard.press('Home');
    await expect
      .poll(
        async () => ((await (await request.get('/api/state')).json()) as Snapshot).settings.volume,
      )
      .toBe(0);
    await enter(page);
    await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Audio settings', exact: true });
    const sound = popup.getByRole('slider', { name: 'Speaker volume', exact: true });
    await expect(sound).toHaveAttribute('aria-valuenow', '0');
    await expect(popup.getByRole('slider')).toHaveCount(1);
    await expect(popup.getByText('Instrument sound', { exact: true })).toBeVisible();
    await sound.focus();
    await page.keyboard.press('End');
    await expect
      .poll(
        async () => ((await (await request.get('/api/state')).json()) as Snapshot).settings.volume,
      )
      .toBe(1);
    await page.screenshot({
      path: join('test-results', `speaker-volume-game-${viewport.width}.png`),
      animations: 'disabled',
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByRole('slider', { name: 'Speaker volume', exact: true })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    await expect(page.getByRole('slider')).toHaveCount(1);
  });
}

test('resizes the two desktop panels by pointer and keyboard', async ({ page }) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const divider = page.getByRole('separator', { name: 'Resize exercise and conversation' });
  const before = (await player(page).boundingBox())!.width;
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const resized = (await player(page).boundingBox())!.width;
  expect(resized).toBeLessThan(before - 30);
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await player(page).boundingBox())!.width).toBeGreaterThan(resized);
  await noPageScroll(page);
});

test('replaces the sidebar progress footer with a silent interactive ear mascot', async ({
  page,
  request,
}) => {
  await page.addInitScript({ content: audioEvidenceScript });
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const mascot = page.getByTestId('ear-companion').filter({ visible: true });
  await expect(mascot).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'Course completion', exact: true }),
  ).toHaveCount(0);
  const before: Snapshot = await (await request.get('/api/state')).json();
  const sampleCount = await page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').samples);
  const background = await mascot.evaluate((element) => getComputedStyle(element).backgroundColor);
  await mascot.hover();
  expect(await mascot.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    background,
  );
  await mascot.click();
  await expect(mascot).toHaveAttribute('data-reaction', '1');
  expect(
    await mascot
      .locator('svg')
      .evaluate((element) => element.getAnimations({ subtree: true }).length),
  ).toBeGreaterThan(0);
  await mascot.click();
  await expect(mascot).toHaveAttribute('data-reaction', '2');
  const after: Snapshot = await (await request.get('/api/state')).json();
  expect(after.totalAnswers).toBe(before.totalAnswers);
  expect(after.current?.id).toBe(before.current?.id);
  expect(after.course).toEqual(before.course);
  expect(await page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').samples)).toBe(
    sampleCount,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mascot.click();
  await expect(mascot).toHaveAttribute('data-reaction', '3');
  expect(
    await mascot
      .locator('[data-part="left-ear"]')
      .evaluate((element) => element.getAnimations().length),
  ).toBe(0);
});

for (const viewport of [
  { width: 1440, height: 600 },
  { width: 390, height: 640 },
]) {
  test(`scrolls the companion with all lessons at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await enter(page);
    if (viewport.width < 1024)
      await page.getByRole('button', { name: 'Open lessons', exact: true }).click();
    const sidebar = page.getByRole('complementary', { name: 'Course outline', exact: true });
    const scroll = sidebar.getByTestId('lesson-scroll');
    const mascot = sidebar.getByTestId('ear-companion');
    const title = sidebar.getByRole('heading', { name: 'Lessons', exact: true });
    const heading = (await title.boundingBox())!;
    expect(
      await mascot.evaluate((element) => Boolean(element.closest('[data-testid="lesson-scroll"]'))),
    ).toBe(true);
    const collapsed = sidebar.getByRole('button', { expanded: false });
    while (await collapsed.count()) await collapsed.first().click();
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(mascot).not.toBeInViewport();
    const below = (await mascot.boundingBox())!.y;
    const nav = sidebar.getByRole('navigation', { name: 'Chapters and lessons' });
    expect(await nav.evaluate((element) => getComputedStyle(element).overflowY)).toBe('visible');
    await page.screenshot({
      path: `test-results\\lessons-shared-scroll-top-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(mascot).toBeInViewport();
    expect(below - (await mascot.boundingBox())!.y).toBeGreaterThan(100);
    expect((await title.boundingBox())!.y).toBe(heading.y);
    expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await noPageScroll(page);
    await page.screenshot({
      path: `test-results\\lessons-shared-scroll-bottom-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}

test('unifies microphone controls in one accessible popup and closes with Escape', async ({
  page,
}) => {
  await page.goto('/');
  await enter(page);
  const button = page.getByRole('button', { name: 'Microphone settings', exact: true });
  await button.click();
  const popup = page.getByRole('dialog', { name: 'Microphone settings' });
  await expect(popup.getByRole('radiogroup', { name: 'Microphone', exact: true })).toHaveCount(1);
  await expect(popup.getByTestId('microphone-meter')).toBeVisible();
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(button).toBeFocused();
});

test('denied or pending microphone permission never blocks the single entry action', async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        deviceId: 'test',
        kind: 'audioinput',
        label: 'Test mic',
        groupId: 'test',
        toJSON: () => ({}),
      },
    ];
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Test mic', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone access was denied');
  await enter(page);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
});

test('lists microphone devices and keeps an inactive or live meter in the same place', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const source = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.08;
    source.connect(gain);
    gain.connect(destination);
    source.start();
    navigator.mediaDevices.enumerateDevices = async () =>
      ['USB microphone', 'Webcam microphone', 'Built-in microphone'].map((label, index) => ({
        deviceId: `mic-${index}`,
        kind: 'audioinput' as const,
        label,
        groupId: `group-${index}`,
        toJSON: () => ({}),
      }));
    navigator.mediaDevices.getUserMedia = async () => {
      await context.resume();
      return destination.stream.clone();
    };
  });
  await page.goto('/');
  await expect(
    page.getByRole('radiogroup', { name: 'Microphone', exact: true }).getByRole('radio'),
  ).toHaveCount(4);
  await expect(page.getByRole('radio', { name: 'None', exact: true })).toBeChecked();
  const meter = page.getByTestId('microphone-meter');
  await expect(meter).toBeVisible();
  expect(
    await page.locator('#main-content').evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe('visible');
  await expect(meter).toHaveAttribute('aria-valuenow', '0');
  const before = (await meter.boundingBox())!;
  await page.getByRole('radio', { name: 'USB microphone', exact: true }).click();
  await expect(meter).toHaveAttribute('data-active', 'true');
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeGreaterThan(10);
  const after = (await meter.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 0);
  await page.getByRole('radio', { name: 'None', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'None', exact: true })).toBeChecked();
  await expect(meter).toHaveAttribute('data-active', 'false');
  await expect(meter).toHaveAttribute('aria-valuenow', '0');
  await expect(meter).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});
test('can enter while microphone permission is still pending', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        deviceId: 'test',
        kind: 'audioinput',
        label: 'Test mic',
        groupId: 'test',
        toJSON: () => ({}),
      },
    ];
    navigator.mediaDevices.getUserMedia = () => new Promise(() => undefined);
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Test mic', exact: true }).click();
  await expect(page.getByText('Waiting for permission…', { exact: true })).toBeVisible();
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
});

test('does not emit a generic audio-paused banner and contacts the server despite delayed audio', async ({
  page,
}) => {
  await mockConfigured(page);
  await page.addInitScript(() => {
    AudioContext.prototype.resume = () => new Promise(() => undefined);
    HTMLMediaElement.prototype.play = () => new Promise(() => undefined);
  });
  await page.route('**/api/realtime/connect', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'test_connection', message: 'Test connection reached the server.' },
      }),
    }),
  );
  await page.goto('/');
  const request = page.waitForRequest('**/api/realtime/connect');
  await enter(page);
  await request;
  await expect(
    page.getByRole('alertdialog', { name: 'Something went wrong', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Browser audio is paused. Select Enable audio to continue.', { exact: true }),
  ).toHaveCount(0);
});

test('keeps the header logo passive and resumes the saved exercise after a page reload', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const before: Snapshot = await (await request.get('/api/state')).json();
  await expect(
    page.getByRole('banner').getByRole('img', { name: 'Earrr', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Earrr training setup', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Instrument preview', { exact: true })).toBeVisible();
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const after: Snapshot = await (await request.get('/api/state')).json();
  expect(after.session?.id).toBe(before.session?.id);
  expect(after.current?.id).toBe(before.current?.id);
});

for (const stage of ['intervals-foundation', 'intervals-harmonic'] as const) {
  test(`${stage} keeps direct scoring and playback with the compact UI`, async ({
    page,
    request,
  }) => {
    const initial = await prepareIntervalLesson('http://127.0.0.1:3101', stage);
    const audio: ToolResult[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('/api/tools') && response.ok())
        void response.json().then((result: ToolResult) => {
          if (result.audio) audio.push(result);
        });
    });
    await page.goto('/');
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const first = audio[0]!;
    expect(first.audio?.events).toHaveLength(2);
    const [a, b] = first.audio!.events;
    expect(a!.at === b!.at).toBe(stage === 'intervals-harmonic');
    await page
      .getByLabel('Message', { exact: true })
      .fill(intervalNames[Math.abs(a!.midi - b!.midi)]!);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('piano-diagram')).toBeVisible();
    await expect(page.getByTestId('grade-feedback')).not.toContainText(
      /Correct|Not quite|Partly correct/i,
    );
    await page.getByRole('button', { name: 'Next question', exact: true }).click();
    await expect.poll(() => audio.length).toBe(2);
    expect(((await (await request.get('/api/state')).json()) as Snapshot).totalAnswers).toBe(
      initial.totalAnswers + 1,
    );
  });
}

test('uses a single output volume for the instrument and persists mute across reload', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const slider = page.getByRole('slider', { name: 'Speaker volume', exact: true });
  await expect(slider).toBeEnabled();
  await slider.focus();
  await page.keyboard.press('Home');
  await expect
    .poll(
      async () => ((await (await request.get('/api/state')).json()) as Snapshot).settings.volume,
    )
    .toBe(0);
  await page.reload();
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
});

test('respects reduced motion and still plays the instrument', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript({ content: audioEvidenceScript });
  await page.goto('/');
  await page.getByRole('button', { name: 'Play C4', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').pianoPeak))
    .toBeGreaterThan(0.01);
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('coach-waveform')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('playback-indicator')).toHaveCount(0);
});

test('shows music playback without moving the coach speech waveform', async ({ page }) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('playback-indicator')).toHaveCount(0);
  await expect(page.getByTestId('coach-waveform')).toHaveAttribute('data-active', 'false');
});

test('shows the waveform only during coach speech and no unsolicited speaker for Hear again', async ({
  page,
}) => {
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  await page.route('**/api/realtime/connect', (route) =>
    route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    }),
  );
  await page.goto('/');
  await enter(page);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  if ((await player(page).getAttribute('data-mode')) === 'teaching')
    await page.getByRole('button', { name: /^(Skip tutorial|Start exercises)$/ }).click();
  await expect(player(page)).toHaveAttribute('data-mode', 'practice');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').delta('Listen carefully.'));
  await expect(player(page)).toHaveAttribute('data-phase', 'speaking');
  await expect(page.getByRole('img', { name: 'Coach audio', exact: true })).toBeVisible();
  await expect(page.getByTestId('playback-indicator')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hear again', exact: true }).click();
  await expect(page.getByTestId('coach-waveform')).toHaveAttribute('data-active', 'false');
  await expect(page.getByTestId('playback-indicator')).toHaveCount(0);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await expect(page.getByTestId('coach-waveform')).toHaveAttribute('data-active', 'false');
});

test('shares one mobile workspace without page scrolling and preserves interactive notes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play C4', exact: true })).toBeVisible();
  await chooseInstrument(page, 'Guitar');
  await expect(
    page.getByRole('button', { name: 'String 6, fret 0, E2', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results\\compact-setup-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await enter(page);
  await expect(
    page.getByRole('separator', { name: 'Resize exercise and conversation' }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await expect(page.getByTestId('latest-message').last()).toBeVisible();
  await expect(page.getByRole('log', { name: 'Practice conversation' })).toHaveCount(0);
  await noPageScroll(page);
  await expect(page.getByRole('navigation', { name: 'Chapters and lessons' })).toHaveCount(0);
  await expect(page.getByTestId('ear-companion').filter({ visible: true })).toHaveCount(0);
  await expect(
    page
      .getByTestId('conversation-preview')
      .getByRole('img', { name: 'Earrr', exact: true })
      .first(),
  ).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open lessons', exact: true });
  await menu.click();
  const drawer = page.getByRole('dialog', { name: 'Lessons', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('img', { name: 'Earrr', exact: true })).toBeVisible();
  const companion = drawer.getByTestId('ear-companion');
  await expect(companion).toBeVisible();
  expect((await companion.innerText()).trim().length).toBeGreaterThan(0);
  expect((await companion.boundingBox())!.height).toBeGreaterThan(100);
  expect(
    await drawer
      .getByRole('button', { name: 'Close', exact: true })
      .evaluate((element) => getComputedStyle(element).cursor),
  ).toBe('pointer');
  await expect(drawer.getByRole('navigation', { name: 'Chapters and lessons' })).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())!.x).toBe(0);
  const collapsed = drawer.getByRole('button', { expanded: false });
  const chapters = await collapsed.count();
  for (let index = 0; index < chapters; index++) {
    await collapsed.first().click();
    await expect(collapsed).toHaveCount(chapters - index - 1);
  }
  await page.screenshot({
    path: 'test-results\\shared-mobile-drawer.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(menu).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results\\compact-training-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('aligns desktop conversation with the title and keeps the sidebar fixed and waveform narrow', async ({
  page,
}) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const title = (await page.getByTestId('lesson-toolbar').boundingBox())!;
  const chat = (await page
    .getByRole('region', { name: 'Conversation', exact: true })
    .boundingBox())!;
  expect(chat.y).toBeCloseTo(title.y, 0);
  await expect(page.getByTestId('playback-indicator')).toHaveCount(0);
  const sidebar = page.getByRole('complementary', { name: 'Course outline' });
  const width = (await sidebar.boundingBox())!.width;
  for (const value of [1280, 1024]) {
    await page.setViewportSize({ width: value, height: 720 });
    expect((await sidebar.boundingBox())!.width).toBe(width);
    expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const nav = page.getByRole('navigation', { name: 'Chapters and lessons' });
    expect(await nav.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(
      await page
        .getByTestId('lesson-scroll')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('scrollbar-width')),
    ).toBe('thin');
    await noPageScroll(page);
  }
  await page.setViewportSize({ width: 1023, height: 720 });
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open lessons', exact: true })).toBeVisible();
  await noPageScroll(page);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 600 },
]) {
  test(`keeps exercise, history and composer inside ${viewport.width}x${viewport.height}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const before: Snapshot = await (await request.get('/api/state')).json();
    await noPageScroll(page);
    const box = (await page.getByTestId('message-composer').boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
    await expect(player(page)).toHaveCount(0);
    await expect(page.getByRole('log', { name: 'Practice conversation' })).toBeVisible();
    await noPageScroll(page);
    await page.getByRole('button', { name: 'Minimize conversation', exact: true }).click();
    await expect(player(page)).toBeVisible();
    const after: Snapshot = await (await request.get('/api/state')).json();
    expect(after.session?.id).toBe(before.session?.id);
    expect(after.current?.id).toBe(before.current?.id);
    expect(after.totalAnswers).toBe(before.totalAnswers);
    await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
    const audio = (await page
      .getByRole('dialog', { name: 'Audio settings', exact: true })
      .boundingBox())!;
    expect(audio.x).toBeGreaterThanOrEqual(0);
    expect(audio.x + audio.width).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Microphone settings', exact: true }).click();
    const microphone = (await page
      .getByRole('dialog', { name: 'Microphone settings', exact: true })
      .boundingBox())!;
    expect(microphone.x).toBeGreaterThanOrEqual(0);
    expect(microphone.x + microphone.width).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press('Escape');
    await settledOverlays(page);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
  });
}

test('keeps drafts and musical playback when history opens and the layout changes', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const before: Snapshot = await (await request.get('/api/state')).json();
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('I am still thinking about this one');
  await page.getByRole('button', { name: 'Hear again', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
  await expect(message).toHaveValue('I am still thinking about this one');
  await expect
    .poll(
      async () => ((await (await request.get('/api/state')).json()) as Snapshot).session?.listened,
    )
    .toBeGreaterThan(before.session!.listened);
  await page.getByRole('button', { name: 'Minimize conversation', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(message).toHaveValue('I am still thinking about this one');
  await expect(page.getByRole('log', { name: 'Practice conversation' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(message).toHaveValue('I am still thinking about this one');
  expect(((await (await request.get('/api/state')).json()) as Snapshot).current?.id).toBe(
    before.current?.id,
  );
  await noPageScroll(page);
});

test('keeps the composer within the visual viewport when a mobile keyboard opens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await enter(page);
  await page.getByLabel('Message', { exact: true }).fill('Still listening');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(async () => (await page.getByTestId('app-frame').boundingBox())!.height)
    .toBe(360);
  const composer = (await page.getByTestId('message-composer').boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(360);
  await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
  expect(
    (await page.getByTestId('message-composer').boundingBox())!.y + composer.height,
  ).toBeLessThanOrEqual(360);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Still listening');
  await noPageScroll(page);
});

test('scrolls a long mobile conversation internally instead of scrolling the page', async ({
  page,
}) => {
  await controlledCoach(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await enter(page);
  for (let index = 0; index < 12; index++) {
    await page
      .getByLabel('Message', { exact: true })
      .fill(`Message ${index * 2 + 1}: ${'A long explanation about listening. '.repeat(12)}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await captionReply(
      page,
      `Message ${index * 2 + 2}: ${'A long explanation about listening. '.repeat(12)}`,
    );
  }
  await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
  const log = page.getByRole('log', { name: 'Practice conversation' });
  expect(
    await log.evaluate((element) => getComputedStyle(element).getPropertyValue('scrollbar-width')),
  ).toBe('thin');
  expect(await log.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await log.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(log.getByText(/^Message 1:/)).toBeInViewport();
  await expect(page.getByLabel('Message', { exact: true })).toBeInViewport();
  await noPageScroll(page);
  await page.screenshot({
    path: 'test-results\\shared-mobile-history.png',
    fullPage: true,
    animations: 'disabled',
  });
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`restores saved chat on launch without changing learning at ${viewport.width}`, async ({
    page,
    request,
  }) => {
    await controlledCoach(page);
    await page.setViewportSize(viewport);
    const chatRequests: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/(?:transcript|events)$/.test(request.url())) chatRequests.push(request.url());
    });
    const started: ToolResult = await (
      await request.post('/api/tools', {
        headers: { 'x-earrr-client': '1' },
        data: { callId: randomUUID(), name: 'start_session', arguments: { mode: 'coach' } },
      })
    ).json();
    const practice = await request.post('/api/tools', {
      headers: { 'x-earrr-client': '1' },
      data: {
        callId: randomUUID(),
        sessionId: started.snapshot.session!.id,
        name: 'start_practice',
        arguments: {},
      },
    });
    expect(practice.ok()).toBe(true);
    await page.goto('/');
    await enter(page);
    const coachMarker = 'This caption belongs only to the current launch.';
    const userMarker = 'Please repeat the current-launch example.';
    await captionReply(page, coachMarker);
    await page.getByLabel('Message', { exact: true }).fill(userMarker);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await captionReply(page, 'The current question is unchanged.');
    await expect(page.locator('[data-message-role="user"]')).toContainText(userMarker);
    if (viewport.width < 1024)
      await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
    await expect(page.getByText(coachMarker, { exact: true })).toBeVisible();
    const before: Snapshot = await (await request.get('/api/state')).json();
    expect(before.current).not.toBeNull();
    await expect
      .poll(async () => {
        const saved: Snapshot = await (await request.get('/api/state')).json();
        return saved.transcript.some((message) => message.text === userMarker);
      })
      .toBe(true);
    const checkpoint = await (
      await request.get(`/api/sessions/${before.session!.id}/checkpoint`)
    ).json();
    expect(checkpoint.state).not.toHaveProperty('messages');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Start training', exact: true })).toBeVisible();
    await enter(page);
    if (viewport.width < 1024)
      await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
    await expect(page.getByText(coachMarker, { exact: true })).toBeVisible();
    await expect(page.getByText(userMarker, { exact: true })).toBeVisible();
    const after: Snapshot = await (await request.get('/api/state')).json();
    expect(after.session?.id).toBe(before.session?.id);
    expect(after.current?.id).toBe(before.current?.id);
    expect(after.totalAnswers).toBe(before.totalAnswers);
    expect(after.course.round).toEqual(before.course.round);
    expect(chatRequests.some((url) => url.endsWith('/api/transcript'))).toBe(true);
    expect(chatRequests.some((url) => url.endsWith('/api/events'))).toBe(false);
    expect(
      await page.evaluate(() =>
        Object.values(localStorage).some(
          (value) =>
            typeof value === 'string' &&
            value.includes('This caption belongs only to the current launch.'),
        ),
      ),
    ).toBe(false);
    await noPageScroll(page);
  });
}

test('keeps Start training pressed during connection, then requires page refresh after failure', async ({
  page,
}) => {
  await mockConfigured(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let connections = 0;
  await page.route('**/api/realtime/connect', async (route) => {
    connections++;
    await pending;
    await route.fulfill({
      status: 502,
      json: { error: { code: 'test_connection', message: 'Connection unavailable. Try again.' } },
    });
  });
  await page.goto('/');
  const button = page.getByRole('button', { name: /^(Start training|Practice offline)$/ });
  const before = (await button.boundingBox())!;
  try {
    await button.click();
    await expect(page.getByTestId('start-spinner')).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('data-starting', 'true');
    expect(await button.boundingBox()).toEqual(before);
    await expect(page.getByLabel('Instrument preview', { exact: true })).toBeVisible();
    await expect(player(page)).toHaveCount(0);
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await button.evaluate((element) => (element as HTMLButtonElement).click());
    await expect.poll(() => connections).toBe(1);
  } finally {
    release();
  }
  const failure = page.getByRole('alertdialog', { name: 'Something went wrong', exact: true });
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  await expect(page.getByTestId('start-spinner')).toHaveCount(0);
});

test('disconnects into a blurred refresh toast without background reconnection', async ({
  page,
}) => {
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  let connections = 0;
  await page.route('**/api/realtime/connect', (route) => {
    connections++;
    return route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    });
  });
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').disconnect());
  const failure = page.getByRole('alertdialog', { name: 'Something went wrong', exact: true });
  await expect(failure).toBeVisible();
  await expect(page.getByTestId('fatal-backdrop')).toHaveCSS('backdrop-filter', 'blur(3px)');
  await page.keyboard.press('Escape');
  await expect(failure).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1200);
  expect(connections).toBe(1);
  await page.screenshot({
    path: 'test-results\\refresh-only-failure.png',
    fullPage: true,
    animations: 'disabled',
  });
  await failure.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start training', exact: true })).toBeVisible();
  await expect(page.getByTestId('fatal-toast')).toHaveCount(0);
  expect(connections).toBe(1);
});

test('keeps the refresh toast reachable on a narrow screen after a realtime error', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await controlledCoach(page);
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').fail());
  const toast = page.getByRole('alertdialog', { name: 'Something went wrong', exact: true });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Refresh', exact: true })).toBeInViewport({
    ratio: 1,
  });
  const box = (await toast.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y + box.height).toBeLessThanOrEqual(568);
  await page.screenshot({
    path: 'test-results\\refresh-only-failure-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('a fatal server error on answer review also uses the global refresh surface', async ({
  page,
}) => {
  await page.goto('/');
  await enter(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('same');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(player(page).locator('[data-outcome="incorrect"]')).toHaveCount(1);
  await page.route('**/api/answers/**', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'server_error', message: 'Fixture storage unavailable.' } },
    }),
  );
  await page.getByRole('button', { name: 'Review answer 1: Incorrect', exact: true }).click();
  await expect(
    page.getByRole('alertdialog', { name: 'Something went wrong', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('fatal-toast').getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeVisible();
});

test('keeps only app-open and actual training-start browser events without visitor tracking or input traces', async ({
  page,
}) => {
  const events: Array<{
    event: string;
    message: Record<string, unknown>;
  }> = [];
  await page.route('**/api/logs', async (route) => {
    events.push(...route.request().postDataJSON().events);
    await route.fulfill({ status: 202, body: '' });
  });
  await page.goto('/');
  await enter(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('same');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(player(page).locator('[data-outcome="incorrect"]')).toHaveCount(1);
  await expect
    .poll(() => events.map((event) => event.event))
    .toEqual(expect.arrayContaining(['user_open_app', 'user_start_training']));
  expect(events.map((event) => event.event)).toEqual(['user_open_app', 'user_start_training']);
  for (const event of events) {
    expect(event).not.toHaveProperty('visitId');
    expect(event).not.toHaveProperty('visitorId');
    expect(event.message).not.toHaveProperty('text');
    expect(event.message).not.toHaveProperty('transcript');
  }
});

test('a rendering failure also produces the refresh toast instead of a blank page', async ({
  page,
}) => {
  await page.route('**/api/tools', async (route) => {
    const response = await route.fetch();
    const result: ToolResult = await response.json();
    if (result.snapshot) Reflect.set(result.snapshot.course, 'lessons', null);
    await route.fulfill({ response, json: result });
  });
  await page.goto('/');
  await enter(page);
  await expect(
    page.getByRole('alertdialog', { name: 'Something went wrong', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('fatal-toast').getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeVisible();
});

test('eight correct answers end the round immediately with two unasked positions', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await enter(page);
  for (let index = 0; index < 8; index++) {
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const state: Snapshot = await (await request.get('/api/state')).json();
    const played: ToolResult = await (
      await request.post('/api/tools', {
        headers: { 'x-earrr-client': '1' },
        data: {
          callId: randomUUID(),
          sessionId: state.session!.id,
          name: 'replay_exercise',
          arguments: {},
        },
      })
    ).json();
    const [a, b] = played.audio!.events;
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(b!.midi > a!.midi ? 'up' : 'down');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(player(page).locator('[data-outcome="correct"]')).toHaveCount(index + 1);
    if (index < 7) await page.getByRole('button', { name: 'Next question', exact: true }).click();
  }
  await expect(
    player(page).getByRole('heading', { name: 'Round passed', exact: true }),
  ).toBeVisible();
  await expect(player(page).locator('[data-outcome="unanswered"]')).toHaveCount(2);
  await expect(
    player(page).getByRole('button', { name: 'Restart exercises', exact: true }),
  ).toBeVisible();
  await expect(
    player(page).getByRole('button', { name: 'Next question', exact: true }),
  ).toHaveCount(0);
  const state: Snapshot = await (await request.get('/api/state')).json();
  expect(state.course.round.previous).toMatchObject({ correct: 8, answered: 8, passed: true });
  expect(state.session?.awaitingRoundChoice).toBe(true);
});

test('waits at the entry button until the offline question is ready, without a loading screen', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/tools', async (route) => {
    if (route.request().postDataJSON()?.name === 'play_exercise') await pending;
    await route.continue();
  });
  await page.goto('/');
  try {
    await enter(page);
    await expect(page.getByTestId('start-spinner')).toBeVisible();
    await expect(page.getByLabel('Instrument preview', { exact: true })).toBeVisible();
    await expect(player(page)).toHaveCount(0);
  } finally {
    release();
  }
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByTestId('start-spinner')).toHaveCount(0);
});

test('animates new messages upward and respects reduced motion', async ({ page }) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await page.getByLabel('Message', { exact: true }).fill('up');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const message = page.locator('[data-message-role="user"]').last();
  await expect(message).toBeVisible();
  expect(await message.evaluate((element) => getComputedStyle(element).animationName)).not.toBe(
    'none',
  );
  expect(await message.getAttribute('class')).toContain('slide-in-from-bottom-2');
  const id = await message.getAttribute('data-message-id');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await message.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  expect(await message.getAttribute('data-message-id')).toBe(id);
});

test('renders scored answers as correct or incorrect tiles without a rolling window', async ({
  page,
  request,
}) => {
  const headers = { 'x-earrr-client': '1' };
  await freshPitchRound(request);
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  for (const outcome of ['incorrect', 'assisted', 'correct']) {
    const state: Snapshot = await (await request.get('/api/state')).json();
    const replay: ToolResult = await (
      await request.post('/api/tools', {
        headers,
        data: {
          callId: randomUUID(),
          sessionId: state.session!.id,
          name: 'replay_exercise',
          arguments: {},
        },
      })
    ).json();
    const [first, second] = replay.audio!.events;
    const up = second!.midi > first!.midi;
    if (outcome === 'assisted')
      await request.post('/api/tools', {
        headers,
        data: {
          callId: randomUUID(),
          sessionId: state.session!.id,
          name: 'give_hint',
          arguments: { exerciseId: state.current!.id },
        },
      });
    await page
      .getByLabel('Message', { exact: true })
      .fill((outcome === 'incorrect' ? !up : up) ? 'up' : 'down');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(async () => ((await (await request.get('/api/state')).json()) as Snapshot).totalAnswers)
      .toBe(state.totalAnswers + 1);
    if (outcome !== 'correct') {
      await page.getByRole('button', { name: 'Next question', exact: true }).click();
      await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    }
  }
  const state: Snapshot = await (await request.get('/api/state')).json();
  const results = state.course.round.answers.map((answer) => answer.outcome);
  expect(results.slice(-3)).toEqual(['incorrect', 'correct', 'correct']);
  const tiles = page.getByRole('list', { name: 'Round answers' }).getByRole('listitem');
  await expect(tiles).toHaveCount(10);
  expect(
    await tiles.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-outcome')),
    ),
  ).toEqual(Array.from({ length: 10 }, (_, index) => results[index] ?? 'unanswered'));
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  const colors = await tiles.evaluateAll((elements) =>
    Object.fromEntries(
      elements.map((element) => [
        element.getAttribute('data-outcome'),
        getComputedStyle(element).backgroundColor,
      ]),
    ),
  );
  expect(colors.correct).not.toBe(colors.incorrect);
  await page.setViewportSize({ width: 320, height: 568 });
  await noPageScroll(page);
});

test('shows a revealed keyboard only after grading, then hides it before the next sound', async ({
  page,
  request,
}) => {
  await freshPitchRound(request);
  const audio: ToolResult[] = [];
  page.on('response', (response) => {
    if (response.url().endsWith('/api/tools') && response.ok())
      void response.json().then((result: ToolResult) => {
        if (result.audio) audio.push(result);
      });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await expect(page.getByTestId('piano-diagram')).toHaveCount(0);
  await expect(player(page).getByRole('list', { name: 'Round answers' })).toBeVisible();
  const first = audio[0]!;
  const [a, b] = first.audio!.events;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/solo/answer', async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.getByLabel('Message', { exact: true }).fill(b!.midi > a!.midi ? 'up' : 'down');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('piano-diagram')).toHaveCount(0);
  } finally {
    release();
  }
  const piano = page.getByTestId('piano-diagram');
  await expect(piano).toHaveAttribute('data-example-id', first.snapshot.current!.id);
  expect(
    await piano
      .locator('[data-note-midi]')
      .evaluateAll((keys) =>
        keys.map((key) => Number(key.getAttribute('data-note-midi'))).sort((x, y) => x - y),
      ),
  ).toEqual([a!.midi, b!.midi].sort((x, y) => x - y));
  await expect(piano.locator('text')).toHaveCount(2);
  const card = (await player(page).boundingBox())!;
  const progress = (await player(page)
    .getByRole('region', { name: 'Pass condition' })
    .boundingBox())!;
  expect(progress.y + progress.height).toBeLessThanOrEqual(card.y + card.height);
  await expect(page.getByText('Recent answers', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('round-score')).toHaveCount(0);
  await expect(player(page).getByRole('region', { name: 'Pass condition' })).toContainText('8/10');
  await expect(player(page).locator('[data-outcome="correct"]')).toHaveCount(1);
  await page.screenshot({
    path: 'test-results\\answer-reveal-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await expect(piano).toHaveCount(0);
  await noPageScroll(page);
});

for (const correct of [7, 8]) {
  test(`judges ${correct}/10 only at the boundary and visibly resets the complete round`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const initial = await freshPitchRound(request);
    await page.goto('/');
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    for (let index = 0; index < 10; index++) {
      const state: Snapshot = await (await request.get('/api/state')).json();
      const replay: ToolResult = await (
        await request.post('/api/tools', {
          headers: { 'x-earrr-client': '1' },
          data: {
            callId: randomUUID(),
            sessionId: state.session!.id,
            name: 'replay_exercise',
            arguments: {},
          },
        })
      ).json();
      const [a, b] = replay.audio!.events;
      const up = b!.midi > a!.midi;
      const response = page.waitForResponse('**/api/solo/answer');
      const answerCorrect = correct === 8 ? index < 7 || index === 9 : index < correct;
      await page
        .getByLabel('Message', { exact: true })
        .fill((answerCorrect ? up : !up) ? 'up' : 'down');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const graded: ToolResult = await (await response).json();
      if (index < 9) {
        expect(graded.roundResult).toBeUndefined();
        expect(graded.snapshot.course.round.answers).toHaveLength(index + 1);
        const tile = player(page)
          .getByRole('list', { name: 'Round answers' })
          .getByRole('listitem')
          .nth(index);
        await expect(tile).toHaveAttribute('data-outcome', answerCorrect ? 'correct' : 'incorrect');
        const mark = tile.locator('span');
        expect(await mark.evaluate((element) => getComputedStyle(element).animationName)).not.toBe(
          'none',
        );
        expect(await mark.getAttribute('class')).toContain('slide-in-from-bottom');
        await page.getByRole('button', { name: 'Next question', exact: true }).click();
        await expect(player(page)).toHaveAttribute('data-phase', 'listening');
      } else {
        expect(graded.roundResult).toMatchObject({ correct, passed: correct === 8, questions: 10 });
        expect(graded.snapshot.course.round.answers).toEqual([]);
        expect(graded.snapshot.course.round.number).toBe(initial.course.round.number + 1);
        await expect(
          page.getByRole('heading', {
            name: correct === 8 ? 'Round passed' : 'Round not passed',
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.getByTestId('round-score')).toHaveCount(0);
        await expect(player(page).locator('[data-outcome="unanswered"]')).toHaveCount(0);
        await expect(player(page).getByTestId('piano-diagram')).toHaveAttribute(
          'data-example-id',
          graded.gradedExerciseId!,
        );
        await expect(page.getByText('Last answer', { exact: true })).toHaveCount(0);
        const restart = player(page).getByRole('button', {
          name: 'Restart exercises',
          exact: true,
        });
        await expect(restart).toHaveAttribute('data-variant', 'outline');
        await expect(restart).toHaveAttribute('data-size', 'sm');
        await expect(restart).toHaveCSS('font-size', '14px');
        await expect(restart).toHaveCSS('font-weight', '500');
        await expect(player(page).getByRole('button', { name: 'Review', exact: true })).toHaveCount(
          0,
        );
        const next = player(page).getByRole('button', { name: 'Next lesson', exact: true });
        await expect(next).toBeEnabled();
        expect((await next.boundingBox())!.x).toBeGreaterThan((await restart.boundingBox())!.x);
        const firstBox = (await restart.boundingBox())!;
        const nextBox = (await next.boundingBox())!;
        const card = (await player(page).boundingBox())!;
        expect((firstBox.x + nextBox.x + nextBox.width) / 2).toBeCloseTo(
          card.x + card.width / 2,
          0,
        );
        expect(firstBox.height).toBe(nextBox.height);
        await page.screenshot({
          path: `test-results\\round-${correct}-of-10.png`,
          fullPage: true,
          animations: 'disabled',
        });
        let resume!: () => void;
        const pending = new Promise<void>((resolve) => {
          resume = resolve;
        });
        await page.route('**/api/tools', async (route) => {
          if (route.request().postDataJSON()?.name === 'start_round') await pending;
          await route.fallback();
        });
        try {
          await restart.click();
          await expect(page.getByTestId('round-result')).toHaveCount(0);
          await expect(player(page).getByTestId('piano-diagram')).toHaveCount(0);
          await expect(
            player(page).getByRole('heading', { name: 'Your turn', exact: true }),
          ).toBeVisible();
        } finally {
          resume();
        }
        await expect(player(page)).toHaveAttribute('data-phase', 'listening');
        await expect(page.getByTestId('round-score')).toHaveCount(0);
        await expect(player(page).locator('[data-outcome="unanswered"]')).toHaveCount(10);
        await expect(page.getByTestId('piano-diagram')).toHaveCount(0);
      }
    }
  });
}

test('lists output devices consistently in entry and the speaker-icon popup', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, 'testOutputs', []);
    Object.defineProperty(AudioContext.prototype, 'setSinkId', {
      configurable: true,
      value: async (id: string) => {
        Reflect.get(window, 'testOutputs').push(['music', id]);
      },
    });

    HTMLMediaElement.prototype.setSinkId = async (id: string) => {
      Reflect.get(window, 'testOutputs').push(['voice', id]);
    };
    navigator.mediaDevices.enumerateDevices = async () =>
      ['Studio speakers', 'Headphones'].map((label, index) => ({
        deviceId: `output-${index}`,
        kind: 'audiooutput' as const,
        label,
        groupId: 'test',
        toJSON: () => ({}),
      }));
  });
  await page.goto('/');
  const group = page.getByRole('radiogroup', { name: 'Speakers', exact: true });
  await expect(group.getByRole('radio')).toHaveCount(3);
  await group.getByRole('radio', { name: 'Headphones', exact: true }).click();
  await expect(group.getByRole('radio', { name: 'Headphones', exact: true })).toBeChecked();
  expect(await page.evaluate(() => Reflect.get(window, 'testOutputs'))).toEqual([
    ['voice', 'output-1'],
    ['music', 'output-1'],
  ]);
  await enter(page);
  const trigger = page.getByRole('button', { name: 'Audio settings', exact: true });
  await expect(trigger).toHaveText('');
  await trigger.click();
  const popup = page.getByRole('dialog', { name: 'Audio settings', exact: true });
  await expect(popup.getByRole('radio', { name: 'Headphones', exact: true })).toBeChecked();
  await expect(popup.getByRole('combobox')).toHaveCount(0);
});

test('keeps setup and lesson speaker notices independent and inside the settings popup', async ({
  page,
}) => {
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  await page.addInitScript(() => {
    localStorage.setItem('earrr:speaker', 'missing-speaker');
    const select = async (id: string) => {
      if (id === 'missing-speaker')
        throw new DOMException('The saved speaker is missing.', 'NotFoundError');
      if (id === 'bad-game-speaker')
        throw new DOMException('Game speaker is unavailable.', 'NotFoundError');
    };
    Object.defineProperty(AudioContext.prototype, 'setSinkId', {
      configurable: true,
      value: select,
    });
    HTMLMediaElement.prototype.setSinkId = select;
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        kind: 'audiooutput',
        deviceId: 'bad-game-speaker',
        label: 'Game speaker',
        groupId: 'test',
        toJSON() {
          return {};
        },
      },
    ];
  });
  let connected!: () => void;
  const gate = new Promise<void>((resolve) => {
    connected = resolve;
  });
  await page.route('**/api/realtime/connect', async (route) => {
    await gate;
    await route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    });
  });
  await page.goto('/');
  try {
    await enter(page);
    await expect(page.getByTestId('audio-notice-setup')).toContainText(
      'The saved speaker is unavailable. Using the system default.',
    );
    connected();
    await expect(player(page)).toBeVisible();
    await expect(page.getByTestId('audio-notice-setup')).toHaveCount(0);
    await expect(
      page.getByText('The saved speaker is unavailable. Using the system default.', {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Audio settings', exact: true });
    await expect(popup.getByTestId('audio-notice-lesson')).toHaveCount(0);
    await popup.getByRole('radio', { name: 'Game speaker', exact: true }).click();
    const notice = popup.getByTestId('audio-notice-lesson');
    await expect(notice).toContainText('Game speaker is unavailable.');
    const label = popup.getByText('Instrument sound', { exact: true });
    const box = (await notice.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual((await label.boundingBox())!.y);
    await expect(
      page
        .getByRole('log', { name: 'Practice conversation', exact: true })
        .getByText('Game speaker is unavailable.'),
    ).toHaveCount(0);
    await notice.getByRole('button', { name: 'Dismiss audio notice', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Log In', exact: true }).click();
    await page.getByRole('button', { name: 'Back to learning', exact: true }).click();
    await expect(page.getByTestId('audio-notice-setup')).toBeVisible();
  } finally {
    connected();
  }
});

for (const viewport of [
  { width: 390, height: 568 },
  { width: 1280, height: 480 },
]) {
  test(`lets long entry content scroll as a page at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      navigator.mediaDevices.enumerateDevices = async () => [
        ...Array.from({ length: 8 }, (_, index) => ({
          kind: 'audioinput' as const,
          deviceId: `input-${index}`,
          label: `Microphone ${index + 1}`,
          groupId: 'test',
          toJSON: () => ({}),
        })),
        ...Array.from({ length: 8 }, (_, index) => ({
          kind: 'audiooutput' as const,
          deviceId: `output-${index}`,
          label: `Speakers ${index + 1}`,
          groupId: 'test',
          toJSON: () => ({}),
        })),
      ];
    });
    await page.goto('/');
    await expect(page.getByRole('radio', { name: 'Microphone 8', exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight > innerHeight))
      .toBe(true);
    const main = page.locator('#main-content');
    expect(await main.evaluate((element) => getComputedStyle(element).overflowY)).toBe('visible');
    for (const name of ['Microphone', 'Speakers']) {
      const list = page.getByRole('radiogroup', { name, exact: true });
      expect(await list.evaluate((element) => getComputedStyle(element).overflowY)).toBe('visible');
      expect(await list.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      );
    }
    await page
      .getByRole('button', { name: 'Practice offline', exact: true })
      .scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await noPageScroll(page);
    await page.reload();
    await expect(page.getByLabel('Instrument preview', { exact: true })).toBeVisible();
    expect(await main.evaluate((element) => getComputedStyle(element).overflowY)).toBe('visible');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight > innerHeight))
      .toBe(true);
    await page.screenshot({
      path: `test-results\\entry-page-scroll-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}

test('gives the selected lesson breathing room inside its gray group', async ({ page }) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const selected = page
    .getByRole('navigation', { name: 'Chapters and lessons' })
    .locator('[aria-current="step"]');
  const spacing = await selected.evaluate((element) => {
    const row = element.getBoundingClientRect();
    const group = element.closest('ul')!.getBoundingClientRect();
    return {
      left: row.left - group.left,
      right: group.right - row.right,
      radius: parseFloat(getComputedStyle(element).borderRadius),
      groupRadius: parseFloat(getComputedStyle(element.closest('ul')!).borderRadius),
    };
  });
  expect(spacing.left).toBeGreaterThanOrEqual(11);
  expect(spacing.right).toBeGreaterThanOrEqual(11);
  expect(spacing.radius).toBeLessThan(spacing.groupRadius);
  await page.screenshot({
    path: 'test-results\\lesson-menu-refined.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('keeps answer facts and marks without individual verdict copy or a duplicate running score', async ({
  page,
  request,
}) => {
  await freshPitchRound(request);
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await page.getByLabel('Message', { exact: true }).fill('same');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('piano-diagram')).toBeVisible();
  await expect(player(page).locator('[data-outcome="incorrect"]')).toHaveCount(1);
  for (const name of ['Correct', 'Not quite', 'Partly correct', 'Skipped']) {
    await expect(player(page).getByText(name, { exact: true })).toHaveCount(0);
  }
  await expect(player(page).getByRole('region', { name: 'Pass condition' })).toContainText('8/10');
  await expect(page.getByTestId('round-score')).toHaveCount(0);
  await expect(page.getByTestId('interval-size')).toHaveText(/^\d+ semitones?$/);
  await page.screenshot({
    path: 'test-results\\answer-without-verdict.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await noPageScroll(page);
  await expect(page.getByTestId('round-score')).toHaveCount(0);
});

for (const compact of [false, true]) {
  test(`${compact ? 'touch' : 'hover'} answer review preserves the current question and supports replay`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(
      compact ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    await page.goto('/');
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    await page.getByLabel('Message', { exact: true }).fill('same');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(player(page).locator('[data-outcome="incorrect"]')).toHaveCount(1);
    const state: Snapshot = await (await request.get('/api/state')).json();
    const target = state.feedback!.exerciseId;
    const notes = state.feedback!.example!.midi;
    await page.getByRole('button', { name: 'Next question', exact: true }).click();
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const before: Snapshot = await (await request.get('/api/state')).json();
    const mark = page.getByRole('button', { name: 'Review answer 1: Incorrect', exact: true });
    if (compact) await mark.click();
    else await mark.hover();
    const popup = page.getByRole('dialog', { name: 'Answer review', exact: true });
    await expect(popup.getByRole('heading', { name: 'Answer', exact: true })).toBeVisible();
    await expect(popup.getByTestId('piano-diagram')).toHaveAttribute('data-example-id', target);
    expect(
      await popup
        .locator('[data-note-midi]')
        .evaluateAll((keys) =>
          keys.map((key) => Number(key.getAttribute('data-note-midi'))).sort((a, b) => a - b),
        ),
    ).toEqual([...new Set(notes)].sort((a, b) => a - b));
    await popup.getByRole('button', { name: 'Hear again', exact: true }).hover();
    await page.waitForTimeout(220);
    await expect(popup).toBeVisible();
    if (compact) {
      const box = (await popup.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(12);
      expect(box.x + box.width).toBeLessThanOrEqual(378);
    }
    await page.screenshot({
      path: `test-results\\earrr-answer-review-${compact ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const response = page.waitForResponse(
      (result) =>
        result.url().endsWith('/api/tools') &&
        result.request().postDataJSON()?.arguments?.exerciseId === target,
    );
    await popup.getByRole('button', { name: 'Hear again', exact: true }).click();
    await expect(popup.getByTestId('replay-indicator')).toBeVisible();
    await expect(
      player(page).getByRole('heading', { name: 'Your turn', exact: true }),
    ).toBeVisible();
    const replay: ToolResult = await (await response).json();
    expect(replay.review?.exerciseId).toBe(target);
    expect(replay.audio?.events.map((note) => note.midi)).toEqual(notes);
    expect(replay.snapshot.current?.id).toBe(before.current!.id);
    expect(replay.snapshot.course).toEqual(before.course);
    expect(replay.snapshot.totalAnswers).toBe(before.totalAnswers);
    await page.getByTestId('lesson-toolbar').hover();
    if (compact) {
      await page.waitForTimeout(220);
      await expect(popup).toBeVisible();
      await page.getByTestId('lesson-toolbar').click();
    }
    await expect(popup).not.toBeVisible();
    await mark.focus();
    await page.keyboard.press('Enter');
    await expect(popup).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(mark).toBeFocused();
    await noPageScroll(page);
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`shows intro immediately and includes remaining bootstrap in Start training at ${viewport.width}`, async ({
    page,
  }) => {
    const gates = new Map<string, () => void>();
    const requests = new Map<string, number>();
    for (const endpoint of ['config', 'state', 'curriculum']) {
      const pending = new Promise<void>((resolve) => gates.set(endpoint, resolve));
      await page.route(`**/api/${endpoint}`, async (route) => {
        requests.set(endpoint, (requests.get(endpoint) ?? 0) + 1);
        await pending;
        await route.fallback();
      });
    }
    await page.setViewportSize(viewport);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    try {
      const button = page.getByRole('button', { name: 'Start training', exact: true });
      await expect(button).toBeEnabled();
      await expect(page.getByLabel('Instrument preview', { exact: true })).toBeVisible();
      await expect(page.getByRole('radiogroup', { name: 'Microphone', exact: true })).toBeVisible();
      await expect(page.getByTestId('coach-waveform')).toHaveCount(0);
      await expect(page.getByRole('status', { name: 'Loading learning progress' })).toHaveCount(0);
      await expect(page.getByTestId('start-spinner')).toHaveCount(0);
      await button.click();
      await expect(page.getByTestId('start-spinner')).toBeVisible();
      await expect(button).toBeDisabled();
      gates.get('config')!();
      await expect.poll(() => requests.get('state')).toBe(1);
      await expect(page.getByTestId('start-spinner')).toBeVisible();
      gates.get('state')!();
      await expect.poll(() => requests.get('curriculum')).toBe(1);
      await expect(page.getByLabel('Instrument preview', { exact: true })).toBeVisible();
      gates.get('curriculum')!();
      await expect(player(page)).toBeVisible();
      expect(requests.get('config')).toBe(1);
      expect(requests.get('state')).toBe(1);
      expect(requests.get('curriculum')).toBe(1);
      await expect(page.getByTestId('start-spinner')).toHaveCount(0);
    } finally {
      for (const release of gates.values()) release();
    }
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`matches Instrument sound styling and omits intro voice bars at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const picker = page.getByRole('button', { name: /^Change instrument:/ });
    await expect(picker).toBeEnabled();
    await expect(page.getByTestId('coach-waveform')).toHaveCount(0);
    await expect(page.getByTestId('microphone-meter')).toBeVisible();
    const typography = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        size: style.fontSize,
        weight: style.fontWeight,
        color: style.color,
        family: style.fontFamily,
        lineHeight: style.lineHeight,
      };
    };
    const labelStyle = await page
      .getByTestId('setup-music')
      .getByText('Instrument sound', { exact: true })
      .evaluate(typography);
    const selectorStyle = await picker.evaluate(typography);
    await page.screenshot({
      path: `test-results\\intro-instrument-consistency-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await enter(page);
    await expect(player(page)).toBeVisible();
    await expect(player(page).getByTestId('coach-waveform')).toBeVisible();
    await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Audio settings', exact: true });
    expect(
      await settings.getByText('Instrument sound', { exact: true }).evaluate(typography),
    ).toEqual(labelStyle);
    expect(
      await settings.getByRole('button', { name: /^Change instrument:/ }).evaluate(typography),
    ).toEqual(selectorStyle);
  });
}

test('keeps Your turn and shows a quiet indicator during current-question replay', async ({
  page,
}) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await player(page).getByRole('button', { name: 'Hear again', exact: true }).click();
  await expect(player(page).getByTestId('replay-indicator')).toBeVisible();
  await expect(player(page).getByRole('heading', { name: 'Your turn', exact: true })).toBeVisible();
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await expect(player(page).getByTestId('replay-indicator')).toHaveCount(0);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
});

test('ends on three misses, stays stopped, and starts again only when explicitly requested', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await enter(page);
  for (let index = 0; index < 3; index++) {
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    await page.getByLabel('Message', { exact: true }).fill('same');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    if (index < 2) {
      await expect(player(page).locator('[data-outcome="incorrect"]')).toHaveCount(index + 1);
      await page.getByRole('button', { name: 'Next question', exact: true }).click();
    }
  }
  await expect(page.getByRole('heading', { name: 'Round not passed', exact: true })).toBeVisible();
  const failed: Snapshot = await (await request.get('/api/state')).json();
  expect(failed.course.round.previous?.answered).toBe(3);
  expect(failed.session?.awaitingRoundChoice).toBe(true);
  await expect(page.getByRole('button', { name: 'Hear again', exact: true })).toHaveCount(0);
  await expect(player(page).locator('[data-outcome="unanswered"]')).toHaveCount(7);
  await expect(player(page).locator('[data-outcome="incorrect"]')).toHaveCount(3);
  const stale = await request.post('/api/tools', {
    headers: { 'x-earrr-client': '1' },
    data: {
      callId: randomUUID(),
      sessionId: failed.session!.id,
      name: 'play_exercise',
      arguments: {},
    },
  });
  expect(((await stale.json()) as ToolResult).audio).toBeUndefined();
  await page.getByRole('button', { name: 'Restart exercises', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  expect(((await (await request.get('/api/state')).json()) as Snapshot).current?.id).not.toBe(
    failed.current!.id,
  );
});

test('keeps an unanswered sound when navigating away and returning', async ({ page, request }) => {
  await prepareIntervalLesson('http://127.0.0.1:3101', 'intervals-foundation');
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const before: Snapshot = await (await request.get('/api/state')).json();
  const replay = async () =>
    (
      await request.post('/api/tools', {
        headers: { 'x-earrr-client': '1' },
        data: {
          callId: randomUUID(),
          sessionId: before.session!.id,
          name: 'replay_exercise',
          arguments: {},
        },
      })
    ).json() as Promise<ToolResult>;
  const first = await replay();
  await page.getByRole('button', { name: /^Pitch direction(?:, completed)?$/ }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await page.getByRole('button', { name: /^Intervals up & down(?:, completed)?$/ }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const returned = await replay();
  expect(returned.snapshot.current?.id).toBe(before.current!.id);
  expect(returned.audio).toEqual(first.audio);
  expect(returned.snapshot.course.round).toEqual(before.course.round);
});

test('shows the typing indicator fully and keeps streamed text pinned without moving a reader', async ({
  page,
}) => {
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  await page.route('**/api/realtime/connect', (route) =>
    route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    }),
  );
  await page.goto('/');
  await enter(page);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const log = page.getByRole('log', { name: 'Practice conversation', exact: true });
  for (let index = 0; index < 12; index++) {
    await page
      .getByLabel('Message', { exact: true })
      .fill(`Message ${index}: ${'I am practicing and listening carefully. '.repeat(14)}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
      .toBe(true);
  }
  const indicator = page.getByTestId('coach-thinking');
  await expect(indicator).toBeInViewport({ ratio: 1 });
  expect(
    await log.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    ),
  ).toBeLessThan(2);
  await expect(player(page).getByText(/Thinking|Connecting|Listening…/)).toHaveCount(0);
  await page.evaluate(() =>
    Reflect.get(window, 'earrrCoachFixture').delta('A streamed answer. '.repeat(50)),
  );
  await expect(log.locator('[data-message-role="assistant"]').last()).toContainText(
    'A streamed answer.',
  );
  expect(
    await log.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    ),
  ).toBeLessThan(2);
  await log.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() =>
    Reflect.get(window, 'earrrCoachFixture').delta('Additional words after scrolling up.'),
  );
  expect(await log.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByTestId('chat-bottom-fade')).toHaveAttribute('data-visible', 'true');
  await page.getByLabel('Message', { exact: true }).fill('My next thought');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(indicator).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('chat-top-fade')).toHaveAttribute('data-visible', 'true');
  expect(await log.getByRole('img', { name: 'Earrr', exact: true }).count()).toBeGreaterThan(0);
  await expect(log.getByText('Interrupted', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: 'test-results\\earrr-chat-boundaries.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('uses the Earrr image wordmark, local icons and search metadata', async ({
  page,
  request,
}) => {
  const html = await (await request.get('/')).text();
  expect(html).toContain('<title>Earrr | Ear training game with a friendly AI tutor.</title>');
  expect(html).toContain('property="og:title"');
  expect(html).toContain('name="twitter:card"');
  const manifest = await (await request.get('/site.webmanifest')).json();
  expect(manifest.short_name).toBe('Earrr');
  expect(manifest.name).toBe(fixedTitle);
  expect(manifest.description).toBe(
    'Simple, hands-free ear training with an AI tutor. Practice pitch, intervals and chords.',
  );
  for (const size of [32, 128, 180, 192, 512])
    expect((await request.get(`/brand/earrr-${size}.png`)).ok()).toBe(true);
  const logo = await (await request.get('/brand/earrr-wordmark.svg')).text();
  expect(logo).not.toContain('<text');
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Earrr', exact: true }).locator('img'),
  ).toBeVisible();
  await expect(
    page.locator('header').getByRole('button', { name: 'Earrr training setup' }),
  ).toHaveCount(0);
});

test('rapid replay stays bounded instead of stacking old sample voices', async ({
  page,
  request,
}) => {
  await page.addInitScript({ content: audioEvidenceScript });
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const before: Snapshot = await (await request.get('/api/state')).json();
  const replay = page.getByRole('button', { name: 'Hear again', exact: true });
  for (let index = 0; index < 12; index++) {
    await replay.click();
    await page.waitForTimeout(90);
  }
  await expect(player(page)).toHaveAttribute('data-phase', 'listening', { timeout: 15_000 });
  const measurement = await page.evaluate(() => {
    const evidence = Reflect.get(window, 'earrrAudioEvidence') as {
      pianoPeak: number;
      sampleVoices: Array<{ start: number; stop: number }>;
    };
    const events = evidence.sampleVoices
      .filter((voice) => voice.start < voice.stop)
      .flatMap((voice) => [
        { time: voice.start, change: 1 },
        { time: voice.stop, change: -1 },
      ])
      .sort((a, b) => a.time - b.time || a.change - b.change);
    let active = 0;
    let max = 0;
    for (const event of events) {
      active += event.change;
      max = Math.max(max, active);
    }
    return { peak: evidence.pianoPeak, max };
  });
  expect(measurement.peak).toBeGreaterThan(0.01);
  expect(measurement.peak).toBeLessThan(0.9);
  expect(measurement.max).toBeLessThanOrEqual(2);
  const after: Snapshot = await (await request.get('/api/state')).json();
  expect(after.current?.id).toBe(before.current!.id);
  expect(after.totalAnswers).toBe(before.totalAnswers);
  expect(after.course).toEqual(before.course);
});

test('automatically resumes and reconnects after returning to a paused section, without recovery buttons', async ({
  page,
  request,
}) => {
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  let connections = 0;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/realtime/connect', async (route) => {
    connections++;
    if (connections === 2) await gate;
    await route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    });
  });
  await page.goto('/');
  await enter(page);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const before: Snapshot = await (await request.get('/api/state')).json();
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
  const paused: Snapshot = await (await request.get('/api/state')).json();
  expect(paused.session?.status).toBe('paused');
  await page.getByRole('button', { name: 'Back to learning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start training', exact: true })).toBeVisible();
  expect(connections).toBe(1);
  await enter(page);
  await expect.poll(() => connections).toBe(2);
  await expect(page.getByTestId('start-spinner')).toBeVisible();
  for (const name of ['Cancel', 'Reconnect', 'Resume'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Paused', exact: true })).toHaveCount(0);
  release();
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const restored: Snapshot = await (await request.get('/api/state')).json();
  expect(restored.session?.id).toBe(before.session?.id);
  expect(restored.session?.status).toBe('active');
  expect(restored.current?.id).toBe(before.current?.id);
  expect(restored.course.round).toEqual(before.course.round);
  await expect(page).toHaveTitle(fixedTitle);

  await page.getByLabel('Message', { exact: true }).fill('Please pause.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').tool('pause_session', {}));
  await expect
    .poll(
      async () => ((await (await request.get('/api/state')).json()) as Snapshot).session?.status,
    )
    .toBe('paused');
  await expect(page.getByRole('heading', { name: 'Paused', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Pitch direction(?:, completed)?$/ }).click();
  await expect
    .poll(
      async () => ((await (await request.get('/api/state')).json()) as Snapshot).session?.status,
    )
    .toBe('active');
});

test('Tutorial return cancels safely or resets only the confirmed round', async ({
  page,
  request,
}) => {
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  await page.route('**/api/realtime/connect', (route) =>
    route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    }),
  );
  await page.goto('/');
  await enter(page);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  if (await page.getByRole('button', { name: 'Skip tutorial', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Skip tutorial', exact: true }).click();
  await expect
    .poll(async () => ((await (await request.get('/api/state')).json()) as Snapshot).session?.phase)
    .toBe('practice');
  const before: Snapshot = await (await request.get('/api/state')).json();
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Tutorial', exact: true }),
  ).toHaveCount(0);
  await player(page).getByRole('button', { name: 'Tutorial', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Return to the tutorial?', exact: true });
  await expect(dialog).toContainText('Your current round will be reset');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const cancelled: Snapshot = await (await request.get('/api/state')).json();
  expect(cancelled.current?.id).toBe(before.current!.id);
  expect(cancelled.course.round).toEqual(before.course.round);
  expect(cancelled.session?.phase).toBe('practice');
  await player(page).getByRole('button', { name: 'Tutorial', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByTestId('lesson-mode')).toHaveText('Tutorial');
  const after: Snapshot = await (await request.get('/api/state')).json();
  expect(after.session?.phase).toBe('teaching');
  expect(after.teaching?.index).toBe(0);
  expect(after.current).toBeNull();
  expect(after.course.round.id).not.toBe(before.course.round.id);
  expect(after.course.round.answers).toEqual([]);
  expect(after.totalAnswers).toBe(before.totalAnswers);
  await expect(player(page).getByRole('button', { name: 'Tutorial', exact: true })).toHaveCount(0);
  const skip = player(page).getByRole('button', { name: 'Skip tutorial', exact: true });
  await expect(skip).toHaveAttribute('data-variant', 'ghost');
  await expect(skip).toHaveText('Skip');
  const action = (await skip.boundingBox())!;
  const title = (await player(page)
    .getByRole('heading', { name: 'Let us learn the sound' })
    .boundingBox())!;
  expect(action.y).toBeGreaterThan(title.y + title.height);
});

test('offers Start exercises instead of Skip at the final tutorial invitation', async ({
  page,
  request,
}) => {
  const headers = { 'x-earrr-client': '1' };
  const started: ToolResult = await (
    await request.post('/api/tools', {
      headers,
      data: {
        callId: randomUUID(),
        name: 'start_session',
        arguments: { mode: 'coach' },
      },
    })
  ).json();
  await request.post('/api/tools', {
    headers,
    data: {
      callId: randomUUID(),
      sessionId: started.snapshot.session!.id,
      name: 'teach_lesson',
      arguments: { stepId: 'ready-for-practice' },
    },
  });
  await mockConfigured(page);
  await page.addInitScript({ content: controlledCoachScript });
  await page.route('**/api/realtime/connect', (route) =>
    route.fulfill({
      json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
    }),
  );
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-mode', 'teaching');
  await expect(page.getByRole('button', { name: 'Skip tutorial', exact: true })).toHaveCount(0);
  const start = page.getByRole('button', { name: 'Start exercises', exact: true });
  await expect(start).toHaveText('Start exercises');
  await start.click();
  await expect(player(page)).toHaveAttribute('data-mode', 'practice');
  const state: Snapshot = await (await request.get('/api/state')).json();
  expect(state.totalAnswers).toBe(started.snapshot.totalAnswers);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`shows section 00 Welcome and waits for an explicit lesson handoff at ${viewport.width}`, async ({
    page,
    request,
  }) => {
    const headers = { 'x-earrr-client': '1' };
    const started: ToolResult = await (
      await request.post('/api/tools', {
        headers,
        data: { callId: randomUUID(), name: 'start_session', arguments: { mode: 'coach' } },
      })
    ).json();
    const sessionId = started.snapshot.session!.id;
    await request.post('/api/tools', {
      headers,
      data: { callId: randomUUID(), sessionId, name: 'teach_lesson', arguments: { restart: true } },
    });
    await request.post('/api/tools', {
      headers,
      data: { callId: randomUUID(), sessionId, name: 'show_welcome', arguments: {} },
    });
    await mockConfigured(page, true);
    await page.addInitScript({ content: controlledCoachScript });
    await page.route('**/api/realtime/connect', (route) =>
      route.fulfill({
        json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
      }),
    );
    await page.setViewportSize(viewport);
    await page.goto('/');
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-mode', 'welcome');
    await expect(page.getByTestId('lesson-toolbar')).toHaveText('Welcome');
    await expect(page.getByRole('button', { name: 'Start learning', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toHaveCount(2);
    await expect(page.getByTestId('coach-waveform')).toBeVisible();
    await expect(page).toHaveTitle(fixedTitle);
    await expect(page.getByRole('button', { name: 'Skip tutorial', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('playback-indicator')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
      .toBe(true);
    await page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').tool('play_exercise', {}));
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
      .toBe(true);
    await page.evaluate(() =>
      Reflect.get(window, 'earrrCoachFixture').reply(
        "Welcome to ear training. I'm your AI coach. We'll progress from basic pitch and intervals to advanced chords and harmony. Shall we start ear training?",
      ),
    );
    await expect
      .poll(
        async () =>
          ((await (await request.get('/api/state')).json()) as Snapshot).teaching?.delivered,
      )
      .toBe(true);
    const waiting: Snapshot = await (await request.get('/api/state')).json();
    expect(waiting.teaching?.section).toBe('welcome');
    await expect(page.getByTestId('coach-waveform')).toHaveAttribute('data-active', 'false');
    expect(waiting.totalAnswers).toBe(started.snapshot.totalAnswers);
    if (viewport.width < 1024)
      await page.getByRole('button', { name: 'Open lessons', exact: true }).click();
    const welcome = page
      .getByRole('navigation', { name: 'Chapters and lessons' })
      .getByRole('button', { name: 'Welcome', exact: true });
    await expect(welcome).toContainText('00');
    await expect(welcome).toHaveAttribute('aria-current', 'step');
    if (viewport.width < 1024) await page.keyboard.press('Escape');
    await page.screenshot({
      path: `test-results\\brief-welcome-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.reload();
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-mode', 'welcome');
    await page.getByRole('button', { name: 'Start learning', exact: true }).click();
    await expect(page.getByTestId('lesson-toolbar')).toHaveText('Pitch direction');
    await expect(player(page)).toHaveAttribute('data-mode', 'teaching');
    await expect(page.getByRole('button', { name: 'Skip tutorial', exact: true })).toBeVisible();
    const moved: Snapshot = await (await request.get('/api/state')).json();
    expect(moved.course.welcomeSeen).toBe(true);
    expect(moved.teaching?.stepId).toBe('overview');
    expect(moved.totalAnswers).toBe(waiting.totalAnswers);
    await noPageScroll(page);
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`Tutorial step input at ${viewport.width}`, () => {
    test.use({ hasTouch: viewport.width < 1024 });
    test(`allows every tutorial step by click or touch and distinguishes current/played steps at ${viewport.width}`, async ({
      page,
      request,
    }) => {
      const before = await prepareIntervalLesson(
        'http://127.0.0.1:3101',
        viewport.width < 1024 ? 'intervals-harmonic' : 'intervals-foundation',
      );
      await mockConfigured(page);
      await page.addInitScript({ content: controlledCoachScript });
      await page.route('**/api/realtime/connect', (route) =>
        route.fulfill({
          json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
        }),
      );
      await page.setViewportSize(viewport);
      await page.goto('/');
      await enter(page);
      if ((await player(page).getAttribute('data-mode')) !== 'teaching') {
        await player(page).getByRole('button', { name: 'Tutorial', exact: true }).click();
        await page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Confirm', exact: true })
          .click();
      }
      const selector = page.getByRole('navigation', { name: 'Tutorial steps', exact: true });
      await expect(selector).toBeVisible();
      for (const button of await selector.getByRole('button').all())
        await expect(button).toBeEnabled();
      const late = selector.getByRole('button', { name: /octave/i });
      await expect(late).toHaveAttribute('data-played', 'false');
      expect(await late.getAttribute('title')).toBeNull();
      expect(await late.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer');
      if (viewport.width >= 1024) {
        const tooltip = page.locator('[data-slot="tooltip-content"]');
        await late.hover();
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText('octave');
        await expect(page.getByRole('tooltip')).toContainText('octave');
        const box = (await tooltip.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({
          path: 'test-results\\tutorial-native-tooltip.png',
          fullPage: true,
          animations: 'disabled',
        });
        await tooltip.hover();
        await expect(tooltip).toBeVisible();
        await page.mouse.move(2, 2, { steps: 8 });
        await expect(tooltip).not.toBeVisible();
        await late.focus();
        await expect(tooltip).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(tooltip).not.toBeVisible();
        await expect(late).toBeFocused();
        await late.click();
      } else {
        await late.tap();
        await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
      }
      await expect(
        player(page).getByRole('heading', { name: 'octave', exact: true }),
      ).toBeVisible();
      await expect(late).toHaveAttribute('aria-current', 'step');
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
        .toBe(true);
      await page.evaluate(() =>
        Reflect.get(window, 'earrrCoachFixture').reply('An octave spans twelve semitones.'),
      );
      await expect(late).toHaveAttribute('data-played', 'true');
      await expect(selector.getByRole('button', { name: /Ready to practice/i })).toHaveAttribute(
        'aria-current',
        'step',
      );
      expect(((await (await request.get('/api/state')).json()) as Snapshot).current).toBeNull();
      const early = selector.locator('button[data-step-id="minor-third"]');
      await expect(early).toBeEnabled();
      if (viewport.width < 1024) await early.tap();
      else await early.click();
      await expect(
        player(page).getByRole('heading', { name: 'minor third', exact: true }),
      ).toBeVisible();
      await expect(early).toHaveAttribute('aria-current', 'step');
      await expect(late).toHaveAttribute('data-played', 'true');
      await expect(early).toHaveAttribute('data-played', 'false');
      await expect(player(page).getByTestId('interval-size')).toHaveText('3 semitones');
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
        .toBe(true);
      await page.evaluate(() =>
        Reflect.get(window, 'earrrCoachFixture').reply('A minor third is three semitones.'),
      );
      await expect(
        player(page).getByRole('heading', { name: 'major third', exact: true }),
      ).toBeVisible();
      await expect(player(page).getByTestId('interval-size')).toHaveText('4 semitones');
      await expect(early).toHaveAttribute('data-played', 'true');
      await expect(page.getByTestId('coach-waveform')).toBeVisible();
      const waveform = await page.getByTestId('coach-waveform').elementHandle();
      const end = selector.getByRole('button', { name: /Ready to practice/i });
      await end.click();
      await expect(
        page.getByRole('button', { name: 'Start exercises', exact: true }),
      ).toBeVisible();
      await expect(end).toHaveAttribute('aria-current', 'step');
      await expect(page.getByRole('progressbar')).toHaveCount(0);
      await page.screenshot({
        path: `test-results\\tutorial-step-selector-${viewport.width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Start exercises', exact: true }).click();
      await expect(player(page)).toHaveAttribute('data-mode', 'practice');
      expect(await waveform!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(page.getByTestId('coach-waveform')).toHaveAttribute('data-active', 'false');
      expect(((await (await request.get('/api/state')).json()) as Snapshot).totalAnswers).toBe(
        before.totalAnswers,
      );
      await noPageScroll(page);
    });
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`shows tutorial piano examples and restores their mode after navigation at ${viewport.width}`, async ({
    page,
    request,
  }) => {
    const initial = await prepareIntervalLesson('http://127.0.0.1:3101', 'intervals-foundation');
    const headers = { 'x-earrr-client': '1' };
    const start: ToolResult = await (
      await request.post('/api/tools', {
        headers,
        data: {
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'coach' },
        },
      })
    ).json();
    const demo: ToolResult = await (
      await request.post('/api/tools', {
        headers,
        data: {
          callId: randomUUID(),
          sessionId: start.snapshot.session!.id,
          name: 'teach_lesson',
          arguments: { stepId: 'minor-third' },
        },
      })
    ).json();
    await mockConfigured(page);
    await page.addInitScript({ content: controlledCoachScript });
    await page.route('**/api/realtime/connect', (route) =>
      route.fulfill({
        json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
      }),
    );
    await page.setViewportSize(viewport);
    await page.goto('/');
    await enter(page);
    const diagram = player(page).getByTestId('piano-diagram');
    await expect(player(page)).toHaveAttribute('data-mode', 'teaching');
    await expect(diagram).toHaveAttribute('data-example-id', demo.teaching!.presentationId);
    const pianoBox = (await diagram.boundingBox())!;
    const voiceBox = (await player(page).getByTestId('coach-waveform').boundingBox())!;
    expect(voiceBox.y).toBeGreaterThanOrEqual(pianoBox.y + pianoBox.height);
    expect(
      await diagram
        .locator('[data-note-midi]')
        .evaluateAll((keys) =>
          keys.map((key) => Number(key.getAttribute('data-note-midi'))).sort((a, b) => a - b),
        ),
    ).toEqual([60, 63]);
    await expect(diagram.locator('text')).toHaveCount(2);
    await expect(player(page).getByRole('button', { name: 'Tutorial', exact: true })).toHaveCount(
      0,
    );
    const skip = player(page).getByRole('button', { name: 'Skip tutorial', exact: true });
    await expect(skip).toHaveAttribute('data-variant', 'ghost');
    const heading = (await player(page)
      .getByRole('heading', { name: 'minor third', exact: true })
      .boundingBox())!;
    const action = (await skip.boundingBox())!;
    expect(action.y).toBeGreaterThan(heading.y + heading.height);
    await expect(player(page).getByRole('region', { name: 'Pass condition' })).toHaveCount(0);
    if (viewport.width < 1024)
      await page.getByRole('button', { name: 'Open lessons', exact: true }).click();
    await page.getByRole('button', { name: /^Pitch direction(?:, completed)?$/ }).click();
    await expect(page.getByTestId('lesson-toolbar')).toContainText('Pitch direction');
    if (viewport.width < 1024)
      await page.getByRole('button', { name: 'Open lessons', exact: true }).click();
    await page.getByRole('button', { name: /^Intervals up & down(?:, completed)?$/ }).click();
    await expect(page.getByTestId('lesson-toolbar')).toContainText('Intervals up & down');
    await expect(player(page)).toHaveAttribute('data-mode', 'teaching');
    const returned: Snapshot = await (await request.get('/api/state')).json();
    expect(returned.teaching?.stepId).toBe('minor-third');
    expect(returned.teaching?.presentationId).not.toBe(demo.teaching!.presentationId);
    expect(returned.teaching?.example).toEqual(demo.teaching!.example);
    expect(returned.totalAnswers).toBe(initial.totalAnswers);
    await page.reload();
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-mode', 'teaching');
    await expect(
      player(page).getByRole('heading', { name: 'minor third', exact: true }),
    ).toBeVisible();
    await expect(diagram).toHaveAttribute('data-example-id', returned.teaching!.presentationId);
    expect(
      ((await (await request.get('/api/state')).json()) as Snapshot).course.round.answers,
    ).toEqual(returned.course.round.answers);
    await expect(page.getByRole('button', { name: 'Skip tutorial', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await noPageScroll(page);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results\\rose-tutorial-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await skip.click();
    await expect(player(page)).toHaveAttribute('data-mode', 'practice');
    await expect(diagram).toHaveCount(0);
    await expect(player(page).getByRole('button', { name: 'Tutorial', exact: true })).toBeVisible();
  });
}

test('lets the entire compact conversation preview expand and preserves drafts while minimizing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await expect(page.getByText('History', { exact: true })).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('I am still listening');
  const preview = page.getByTestId('conversation-preview');
  const button = preview.getByRole('button', { name: 'Expand conversation', exact: true });
  const box = (await preview.boundingBox())!;
  expect(await button.boundingBox()).toEqual(box);
  await button.click({ position: { x: box.width / 2, y: Math.max(10, box.height / 2) } });
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toBeVisible();
  await expect(player(page)).toHaveCount(0);
  const minimize = page.getByRole('button', { name: 'Minimize conversation', exact: true });
  await expect(minimize).toHaveText('Minimize');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('I am still listening');
  await minimize.click();
  await expect(player(page)).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('I am still listening');
  await noPageScroll(page);
});

test('groups coach replies under one transparent logo until a user speaks', async ({ page }) => {
  await prepareIntervalLesson('http://127.0.0.1:3101', 'intervals-foundation');
  await controlledCoach(page);
  const messages = [
    { role: 'assistant', text: 'Listen for the distance between the two notes.' },
    {
      role: 'assistant',
      text: 'Take your time. You can ask for another listen whenever you need.',
    },
    { role: 'user', text: 'Could you play that again?' },
    { role: 'assistant', text: 'Of course. Here is the same interval.' },
    { role: 'user', text: 'I think it is a minor third.' },
    { role: 'assistant', text: 'Almost. It was a major third, four semitones from C to E.' },
    { role: 'assistant', text: 'Next question: listen to two notes descending.' },
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await enter(page);
  await captionReply(page, messages[1]!.text, messages[0]!.text);
  await page.getByLabel('Message', { exact: true }).fill(messages[2]!.text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await captionReply(page, messages[3]!.text);
  await page.getByLabel('Message', { exact: true }).fill(messages[4]!.text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await captionReply(page, messages[6]!.text, messages[5]!.text);
  const log = page.getByRole('log', { name: 'Practice conversation', exact: true });
  await expect(log.getByRole('img', { name: 'Earrr', exact: true })).toHaveCount(3);
  const first = log.locator('[data-message-id]').filter({ hasText: messages[0]!.text });
  const second = log.locator('[data-message-id]').filter({ hasText: messages[1]!.text });
  const reply = log.locator('[data-message-id]').filter({ hasText: messages[2]!.text });
  const a = (await first.boundingBox())!;
  const b = (await second.boundingBox())!;
  const c = (await reply.boundingBox())!;
  expect(b.y - a.y - a.height).toBeCloseTo(8, 0);
  expect(c.y - b.y - b.height).toBeGreaterThan(20);
  expect(
    await first.locator('p').evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBe(15);
  const avatar = (await first.getByTestId('message-sender').boundingBox())!;
  const mark = (await first.getByRole('img', { name: 'Earrr', exact: true }).boundingBox())!;
  expect(avatar.width).toBe(32);
  expect(avatar.height).toBe(24);
  expect(mark.width).toBe(24);
  expect(mark.height).toBe(24);
  expect(mark.x - avatar.x).toBe(4);
  expect(mark.y - avatar.y).toBe(0);
  expect(
    await first
      .getByTestId('message-sender')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgba(0, 0, 0, 0)');
  await expect(second.getByRole('img', { name: 'Earrr', exact: true })).toHaveCount(0);
  expect((await first.locator('p').boundingBox())!.x).toBe(
    (await second.locator('p').boundingBox())!.x,
  );
  const content = (await log.boundingBox())!;
  expect(avatar.x - content.x).toBe(12);
  await expect(first.getByText('Earrr', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: 'test-results\\friendly-conversation-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const latest = page.getByTestId('latest-message').last();
  await expect(latest.getByRole('img', { name: 'Earrr', exact: true })).toBeVisible();
  await expect(page.getByTestId('latest-message')).toHaveCount(1);
  await expect(
    page.getByTestId('conversation-preview').getByRole('img', {
      name: 'Earrr',
      exact: true,
    }),
  ).toHaveCount(1);
  expect(
    await latest.locator('p').evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBe(14);
  await noPageScroll(page);
  await page.screenshot({
    path: 'test-results\\friendly-conversation-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Expand conversation', exact: true }).click();
  await expect(log.getByRole('img', { name: 'Earrr', exact: true })).toHaveCount(3);
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: 'test-results\\friendly-conversation-expanded.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('uses rose accents only for identifiers and notes while preserving neutral controls and grading colors', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await enter(page);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      ['primary', 'success', 'destructive', 'brand', 'tutorial'].map((name) => [
        name,
        style.getPropertyValue(`--color-${name}`).trim(),
      ]),
    );
  });
  const channels = (name: string) => tokens[name]!.match(/(?:\d+\.?\d*|\.\d+)/g)!.map(Number);
  expect(channels('primary')).toEqual([25, 0.005, 85]);
  expect(channels('success')).toEqual([48, 0.17, 150]);
  expect(channels('destructive')).toEqual([52, 0.2, 25]);
  expect(channels('tutorial')).toEqual([80, 0.14, 90]);
  expect(tokens.brand).not.toBe(tokens.success);
  const icon = await (await request.get('/brand/earrr-mark.svg')).text();
  expect(icon).toContain('oklch(60% .22 355)');
  expect(icon).not.toContain('oklch(39% .052 168)');
  await page.getByLabel('Message', { exact: true }).fill('same');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const diagram = player(page).getByTestId('piano-diagram');
  await expect(diagram).toBeVisible();
  await expect(diagram.locator('.fill-brand').first()).toBeVisible();
  await expect(diagram.locator('.fill-success, .fill-success\\/20')).toHaveCount(0);
  await expect(player(page).locator('[data-outcome="incorrect"]')).toHaveCount(1);
  await page.screenshot({
    path: 'test-results\\rose-exercise-answer.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('chapter hover stays quiet and desktop marks are larger than mobile marks', async ({
  page,
}) => {
  await page.goto('/');
  await enter(page);
  const chapter = page
    .getByRole('navigation', { name: 'Chapters and lessons' })
    .getByRole('button', { expanded: true })
    .first();
  const color = await chapter.evaluate((element) => getComputedStyle(element).backgroundColor);
  await chapter.hover();
  await page.waitForTimeout(250);
  expect(await chapter.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    color,
  );
  const marks = player(page).getByRole('list', { name: 'Round answers' }).getByRole('listitem');
  const large = (await marks.first().boundingBox())!;
  expect(large.height).toBeGreaterThanOrEqual(40);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(marks.first()).toBeVisible();
  await expect.poll(async () => (await marks.first().boundingBox())?.height).toBe(28);
  await noPageScroll(page);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 1884, height: 889 },
]) {
  test(`balances card controls and answer spacing at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await enter(page);
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('img', { name: 'Earrr' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Home', exact: true })).toHaveCount(0);
    await expect(banner.getByRole('button', { name: 'Tutorial', exact: true })).toHaveCount(0);
    const card = (await player(page).boundingBox())!;
    const tutorial = (await player(page)
      .getByRole('button', { name: 'Tutorial', exact: true })
      .boundingBox())!;
    const speaker = player(page).getByRole('button', { name: 'Audio settings', exact: true });
    const sound = (await speaker.boundingBox())!;
    const lastMark = (await player(page)
      .getByRole('list', { name: 'Round answers' })
      .getByRole('listitem')
      .last()
      .boundingBox())!;
    const compact = viewport.width < 1024;
    expect(sound.width).toBe(48);
    expect(sound.height).toBe(48);
    expect((await speaker.locator('svg').boundingBox())!.width).toBe(24);
    expect(tutorial.x - card.x).toBeGreaterThanOrEqual(compact ? 16 : 24);
    expect(sound.y - card.y).toBeGreaterThanOrEqual(compact ? 12 : 16);
    expect(card.x + card.width - sound.x - sound.width).toBeGreaterThanOrEqual(compact ? 16 : 24);
    expect(Math.abs(tutorial.y - sound.y)).toBeLessThan(1);
    expect(card.y + card.height - lastMark.y - lastMark.height).toBeGreaterThanOrEqual(
      compact ? 20 : 32,
    );
    expect(
      await page
        .getByTestId('lesson-mode')
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBe(compact ? 14 : 16);
    await expect(
      player(page).getByRole('button', { name: 'Hear again', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await noPageScroll(page);
    await page.screenshot({
      path: `test-results\\balanced-training-${viewport.width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}

for (const viewport of [
  { width: 1884, height: 889 },
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`groups the branded introduction and keeps instrument geometry stable at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockConfigured(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.enumerateDevices = async () => [
        ...['Microphone array', 'USB microphone', 'Audio interface microphone'].map(
          (label, index) => ({
            deviceId: `input-${index}`,
            kind: 'audioinput' as const,
            label,
            groupId: 'test',
            toJSON: () => ({}),
          }),
        ),
        ...[
          'Display speakers',
          'Studio monitors',
          'USB headphones',
          'Audio interface speakers',
        ].map((label, index) => ({
          deviceId: `output-${index}`,
          kind: 'audiooutput' as const,
          label,
          groupId: 'test',
          toJSON: () => ({}),
        })),
      ];
    });
    await page.goto('/');
    await expect(
      page.getByRole('radio', { name: 'Audio interface speakers', exact: true }),
    ).toBeVisible();
    const tagline = page.getByTestId('setup-tagline');
    await expect(tagline).toHaveText('Ear training game with a friendly AI tutor.');
    await page.evaluate(() => document.fonts.ready);
    const typeSize = await tagline.evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    );
    expect(typeSize).toBeGreaterThanOrEqual(viewport.width < 640 ? 20 : 24);
    const caption = (await tagline.boundingBox())!;
    const instrument = (await page.getByTestId('instrument-piano').boundingBox())!;
    expect(instrument.y - caption.y - caption.height).toBeLessThan(90);
    const before = (await page.getByLabel('Instrument preview', { exact: true }).boundingBox())!;
    const music = (await page.getByTestId('setup-music').boundingBox())!;
    const devices = (await page
      .getByLabel('Microphone and speaker setup', { exact: true })
      .boundingBox())!;
    if (viewport.width >= 768) {
      expect(devices.x).toBeGreaterThan(music.x + music.width);
      expect(Math.abs(music.y + music.height / 2 - devices.y - devices.height / 2)).toBeLessThan(2);
    } else expect(devices.y).toBeGreaterThan(music.y + music.height);
    await page.screenshot({
      path: `test-results\\balanced-entry-${viewport.width}-piano.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await chooseInstrument(page, 'Guitar');
    await expect(page.getByTestId('setup-music').getByTestId('instrument-guitar')).toBeVisible();
    const after = (await page.getByLabel('Instrument preview', { exact: true }).boundingBox())!;
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.screenshot({
      path: `test-results\\balanced-entry-${viewport.width}-guitar.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}

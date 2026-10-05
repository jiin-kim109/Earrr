import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { ApiEnvelope, GuestSave } from '../shared/types/user.js';
import type { Snapshot } from '../server/types/agent.types.js';
import { audioEvidenceScript } from '../tests/browser-audio.js';
import { readCurrentMessages } from '../tests/browser-conversation.js';
import {
  expectOneSpokenReply,
  realtimeTraceScript,
  turnMarker,
} from '../tests/browser-realtime.js';

const origin = 'http://127.0.0.1:3117';
const server = spawn(process.execPath, ['dist\\server\\main.js'], {
  env: { ...process.env, PORT: '3117', DATABASE_PATH: ':memory:', DATABASE_URL: '' },
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
let guestToken = '';
const tools: string[] = [];

async function snapshot(): Promise<Snapshot> {
  const response = await fetch(`${origin}/api/state`, { headers: { 'x-earrr-guest': guestToken } });
  if (!response.ok) throw new Error(`Welcome state could not be read (${response.status}).`);
  return ((await response.json()) as ApiEnvelope<Snapshot>).data;
}
async function send(page: Page, message: string) {
  await page.getByLabel('Message', { exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Welcome server stopped: ${serverOutput}`);
    try {
      if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })).ok) {
        ready = true;
        break;
      }
    } catch (error) {
      if (attempt === 119) throw error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) throw new Error('Welcome server did not become ready.');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let connections = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/realtime/connect')) connections++;
    if (request.url().endsWith('/api/agent/tools')) tools.push(request.postDataJSON().name);
  });
  await page.addInitScript({ content: audioEvidenceScript + realtimeTraceScript });
  await page.goto(origin);
  await expect(page.getByRole('button', { name: 'Start training', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Change instrument:/ })).toBeEnabled();
  const save = await page.evaluate(
    () =>
      new Promise<GuestSave>((done, fail) => {
        const opening = indexedDB.open('earrr-learning', 1);
        opening.onerror = () => fail(new Error('Guest progress could not be opened.'));
        opening.onsuccess = () => {
          const db = opening.result;
          const read = db.transaction('guest').objectStore('guest').get('save');
          read.onsuccess = () => {
            db.close();
            done(read.result);
          };
          read.onerror = () => {
            db.close();
            fail(new Error('Guest progress could not be read.'));
          };
        };
      }),
  );
  const access = await fetch(`${origin}/api/workspaces/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-earrr-client': '1' },
    body: JSON.stringify({ save }),
  });
  if (!access.ok) throw new Error('The scoped Welcome test could not attach to its own guest.');
  guestToken = (await access.json()).data.guestToken;
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  await expectOneSpokenReply(page, 0, 'Brief section 00 Welcome');
  let state = await snapshot();
  expect(state.teaching?.section).toBe('welcome');
  expect(state.current).toBeNull();
  expect(state.totalAnswers).toBe(0);
  const greeting = (await readCurrentMessages(page))
    .filter((message) => message.role === 'assistant')
    .at(-1)!.text;
  expect(greeting.split(/\s+/).length).toBeLessThanOrEqual(35);
  expect(greeting).toMatch(/welcome/i);
  expect(greeting).toContain('?');
  expect(greeting).not.toMatch(/\b(?:reply|say|type)\s+(?:yes|start|continue)\b/i);
  expect((greeting.match(/[.!?]+(?:\s|$)/g) ?? []).length).toBeLessThanOrEqual(4);
  expect(greeting).not.toMatch(/\bear+r\b|start.*pitch direction|begin.*pitch direction/i);
  expect(greeting).toMatch(/AI coach/i);
  expect(greeting).toMatch(/pitch|interval/i);
  expect(greeting).toMatch(/advanced|complex/i);
  await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toHaveCount(2);
  await expect(page.getByTestId('coach-waveform')).toBeVisible();
  expect(state.course.welcomeSeen).toBe(false);
  expect(state.teaching?.autoContinue).toBe(false);

  const clarification = await turnMarker(page);
  await send(page, 'Can I type my answers instead of speaking?');
  await expectOneSpokenReply(page, clarification, 'Welcome clarification without advancement');
  state = await snapshot();
  expect(state.teaching?.section).toBe('welcome');
  expect(state.current).toBeNull();
  expect(state.course.welcomeSeen).toBe(false);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results\\native-brief-welcome.png', fullPage: true });

  const originalSessionId = state.session!.id;
  const paused = await fetch(`${origin}/api/tools`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-earrr-client': '1',
      'x-earrr-guest': guestToken,
    },
    body: JSON.stringify({
      callId: crypto.randomUUID(),
      sessionId: originalSessionId,
      name: 'pause_session',
      arguments: {},
    }),
  });
  if (!paused.ok) throw new Error('The automatic restore fixture could not pause its own session.');
  const checkpoint = (await paused.json()).guestSave as GuestSave;
  await page.evaluate(
    (save) =>
      new Promise<void>((done, fail) => {
        const opening = indexedDB.open('earrr-learning', 1);
        opening.onsuccess = () => {
          const db = opening.result;
          const transaction = db.transaction('guest', 'readwrite');
          transaction.objectStore('guest').put(save, 'save');
          transaction.oncomplete = () => {
            db.close();
            done();
          };
          transaction.onerror = () => {
            db.close();
            fail(new Error('Paused fixture could not be saved.'));
          };
        };
        opening.onerror = () => fail(new Error('Paused fixture storage could not open.'));
      }),
    checkpoint,
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start training', exact: true })).toBeVisible();
  expect(connections).toBe(1);
  expect((await snapshot()).session?.status).toBe('paused');
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  for (const name of ['Reconnect', 'Resume', 'Cancel'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Paused', exact: true })).toHaveCount(0);
  await expectOneSpokenReply(page, 0, 'Saved-section reconnection after mandatory audio setup');
  state = await snapshot();
  expect(state.session?.id).toBe(originalSessionId);
  expect(state.session?.status).toBe('active');
  expect(state.teaching?.section).toBe('welcome');
  await expect(page.getByTestId('coach-waveform')).toBeVisible();
  await expect(page).toHaveTitle('Earrr | Ear training with a friendly AI tutor.');

  const beforeConsent = tools.length;
  await send(page, 'Yes, let us start ear training.');
  await expect
    .poll(async () => (await snapshot()).course.welcomeSeen, { timeout: 60_000 })
    .toBe(true);
  expect(tools.slice(beforeConsent)).toContain('continue_teaching');
  await expect
    .poll(async () => (await snapshot()).teaching?.awaitingPractice, { timeout: 120_000 })
    .toBe(true);
  state = await snapshot();
  expect(state.teaching?.section).toBeUndefined();
  expect(state.current).toBeNull();
  expect(state.totalAnswers).toBe(0);
  expect(tools.slice(beforeConsent)).not.toContain('start_practice');
  expect(connections).toBe(2);
  await expect(page.getByRole('button', { name: 'Start exercises', exact: true })).toBeVisible();
  console.log(
    'PASS natural agreement leaves Welcome on the same native connection; clarification and tutorial handoff never auto-start questions',
  );
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) server.kill('SIGTERM');
}

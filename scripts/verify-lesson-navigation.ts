import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from '@playwright/test';
import { expect } from '@playwright/test';
import type { Snapshot, ToolName, ToolResult } from '../server/types/agent.types.js';
import { intervalNames } from '../server/services/exercise/music.js';
import { audioEvidenceScript } from '../tests/browser-audio.js';
import {
  realtimeTraceScript,
  expectOneSpokenReply,
  turnMarker,
} from '../tests/browser-realtime.js';
import { readCurrentMessages } from '../tests/browser-conversation.js';

export async function verifyLessonNavigation(browser: Browser, origin: string, sessionId: string) {
  const call = async (name: ToolName, args = {}) => {
    const response = await fetch(`${origin}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-earrr-client': '1' },
      body: JSON.stringify({ callId: randomUUID(), sessionId, name, arguments: args }),
    });
    if (!response.ok) throw new Error(`Navigation fixture failed (${response.status}).`);
    return (await response.json()) as ToolResult;
  };
  await call('select_lesson', { skillId: 'intervals-harmonic' });
  const exercise = await call('play_exercise');
  const notes = exercise.audio!.events.filter((note) => note.role === 'exercise');
  const interval = Math.abs(notes[1]!.midi - notes[0]!.midi);
  const initial: Snapshot = await (await fetch(`${origin}/api/state`)).json();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
  });
  let releaseGrade!: () => void, releaseOverview!: () => void;
  const gradeHeld = new Promise<void>((done) => {
    releaseGrade = done;
  });
  const overviewHeld = new Promise<void>((done) => {
    releaseOverview = done;
  });
  let grading = false;
  let freeze = true;
  try {
    await page.addInitScript({ content: audioEvidenceScript + realtimeTraceScript });
    await page.route('**/api/agent/tools', async (route) => {
      const response = await route.fetch();
      if (route.request().postDataJSON()?.name === 'submit_answer') {
        grading = true;
        await gradeHeld;
      }
      await route.fulfill({ response });
    });
    await page.route('**/api/teaching/delivered', async (route) => {
      const response = await route.fetch();
      const snapshot: Snapshot = await response.json();
      if (freeze && snapshot.teaching?.stepId === 'overview') await overviewHeld;
      await route.fulfill({ response, json: snapshot });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    const player = page.getByRole('region', { name: 'Exercise player', exact: true });
    await expect(player).toHaveAttribute('data-phase', 'listening', { timeout: 60_000 });
    const marker = await turnMarker(page);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`I think it is a ${intervalNames[interval]}.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => grading, { timeout: 30_000 }).toBe(true);
    await page
      .getByRole('navigation', { name: 'Chapters and lessons' })
      .getByText('Chord colors', { exact: true })
      .click();
    await page.getByRole('button', { name: /Major & minor/ }).click();
    releaseGrade();
    await expect(player).toHaveAttribute('data-mode', 'teaching');
    await expectOneSpokenReply(
      page,
      marker,
      'New section overview replaces the old in-flight exercise',
    );
    const overview = (await readCurrentMessages(page)).at(-1)?.text ?? '';
    expect(overview).toMatch(/triad|major|minor/i);
    expect(overview).not.toMatch(
      /I(?:'ll| will) (?:stop|pause)|ready for your answer|next question/i,
    );
    const current: Snapshot = await (await fetch(`${origin}/api/state`)).json();
    expect(current.teaching?.stepId).toBe('overview');
    expect(current.course.selectedLesson).toBe('triads');
    expect(current.totalAnswers).toBe(initial.totalAnswers + 1);
    console.log('PASS native section handoff speaks the new overview, not the old quiz feedback.');
    await page.evaluate(() => {
      const frames: Array<{ id: string; symbol: string; midi: number[] }> = [];
      Reflect.set(window, 'earrrCharacterFrames', frames);
      new MutationObserver(() => {
        const piano = document.querySelector(
          '[aria-label="Exercise player"] [data-testid="piano-diagram"]',
        );
        const symbol = document.querySelector(
          '[aria-label="Exercise player"] [data-testid="chord-symbol"]',
        )?.textContent;
        const id = piano?.getAttribute('data-example-id');
        if (piano && symbol && id && frames.at(-1)?.id !== id)
          frames.push({
            id,
            symbol,
            midi: [...piano.querySelectorAll('[data-note-midi]')]
              .map((note) => Number(note.getAttribute('data-note-midi')))
              .sort((a, b) => a - b),
          });
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    freeze = false;
    releaseOverview();
    await page.locator('[data-step-id="character"]').click();
    for (const [index, symbol] of ['CM', 'Cm', 'EM', 'Em'].entries()) {
      await expect(player.getByTestId('chord-symbol')).toHaveText(symbol, { timeout: 45_000 });
      await page.screenshot({
        path: resolve('test-results', `native-character-${index + 1}-${symbol}.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
    await expect(page.getByRole('button', { name: 'Start exercises', exact: true })).toBeVisible({
      timeout: 120_000,
    });
    const frames: Array<{ symbol: string; midi: number[] }> = await page.evaluate(() =>
      Reflect.get(window, 'earrrCharacterFrames'),
    );
    const sequence = frames.filter(
      (frame, index) => index === 0 || frames[index - 1]!.symbol !== frame.symbol,
    );
    expect(sequence.map((frame) => frame.symbol).slice(-4)).toEqual(['CM', 'Cm', 'EM', 'Em']);
    expect(sequence.map((frame) => frame.midi).slice(-4)).toEqual([
      [60, 64, 67],
      [60, 63, 67],
      [64, 68, 71],
      [64, 67, 71],
    ]);
    const messages = await readCurrentMessages(page);
    expect(
      messages
        .filter((message) => message.role === 'assistant')
        .slice(-5)
        .map((message) => message.text)
        .join(' '),
    ).not.toMatch(/I(?:'ll| will) (?:stop|pause)/i);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').voicePeak))
      .toBeGreaterThan(0.001);
    await writeFile(
      resolve('test-results', 'native-lesson-flow.json'),
      JSON.stringify({ overview, sequence, narration: messages.slice(-6) }, null, 2),
    );
    console.log(
      'PASS native major/minor character examples advance CM, Cm, EM, Em with changing piano facts.',
    );
  } finally {
    releaseGrade?.();
    releaseOverview?.();
    await page.close();
  }
}

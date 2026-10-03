import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import type { Snapshot, ToolName, ToolResult } from '../server/types/agent.types.js';
import { intervalNames } from '../server/services/exercise/music.js';
import { prepareIntervalLesson } from '../tests/interval-fixture.js';
import {
  realtimeTraceScript,
  turnMarker,
  expectOneSpokenReply,
} from '../tests/browser-realtime.js';

export async function verifyRounds(origin: string, snapshot: () => Promise<Snapshot>) {
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || url.port !== '3102') {
    throw new Error('Round verification is restricted to the isolated live-test server.');
  }
  await prepareIntervalLesson(origin, 'intervals-foundation');
  const call = async (name: ToolName, args: object = {}, sessionId?: string) => {
    const response = await fetch(`${origin}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-earrr-client': '1' },
      body: JSON.stringify({ callId: randomUUID(), sessionId, name, arguments: args }),
    });
    if (!response.ok) throw new Error(`Round fixture ${name} failed (${response.status}).`);
    return (await response.json()) as ToolResult;
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const finalCorrect of [false, true]) {
      const active = (await snapshot()).session;
      if (active) await call('end_session', {}, active.id);
      const sessionId = (await call('start_session', { mode: 'coach' })).snapshot.session!.id;
      let question = await call('start_practice', {}, sessionId);
      if (question.snapshot.session?.awaitingRoundChoice)
        question = await call('start_round', {}, sessionId);
      const round = question.snapshot.course.round;
      const warmup = finalCorrect ? 9 : 4;
      for (let index = 0; index < warmup; index++) {
        const [a, b] = question.audio!.events;
        const interval = Math.abs(a!.midi - b!.midi);
        await call(
          'submit_answer',
          {
            exerciseId: question.snapshot.current!.id,
            answer: {
              interval: index < (finalCorrect ? 7 : 2) ? interval : interval === 3 ? 4 : 3,
            },
          },
          sessionId,
        );
        question = await call('play_exercise', {}, sessionId);
      }
      expect((await snapshot()).course.round.correct).toBe(finalCorrect ? 7 : 2);
      const [a, b] = question.audio!.events;
      const interval = Math.abs(a!.midi - b!.midi);
      const answer = finalCorrect ? interval : interval === 3 ? 4 : 3;
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript({ content: realtimeTraceScript });
      await page.goto(origin);
      await page.getByRole('button', { name: 'Start training', exact: true }).click();
      await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
        'data-phase',
        'listening',
        { timeout: 60_000 },
      );
      await expect(page.getByTestId('piano-diagram')).toHaveCount(0);
      const marker = await turnMarker(page);
      const response = page.waitForResponse(
        (result) =>
          result.url().endsWith('/api/agent/tools') &&
          result.request().postDataJSON()?.name === 'submit_answer',
      );
      await page
        .getByLabel('Message', { exact: true })
        .fill(`I think it is a ${intervalNames[answer]}.`);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const graded: ToolResult = await (await response).json();
      expect(graded.roundResult).toMatchObject({
        passed: finalCorrect,
        correct: finalCorrect ? 8 : 2,
        questions: 10,
        answered: finalCorrect ? 10 : 5,
      });
      expect(graded.snapshot.course.round).toMatchObject({
        number: round.number + 1,
        correct: 0,
        answers: [],
      });
      await expect(page.getByTestId('piano-diagram')).toHaveAttribute(
        'data-example-id',
        question.snapshot.current!.id,
      );
      await expectOneSpokenReply(
        page,
        marker,
        finalCorrect ? 'Passed round verdict' : 'Early failure invitation',
      );
      await expect(page.getByTestId('round-score')).toHaveCount(0);
      await expect(
        page.getByLabel('Exercise player', { exact: true }).locator('[data-outcome="unanswered"]'),
      ).toHaveCount(10);
      expect((await snapshot()).session?.awaitingRoundChoice).toBe(true);
      await expect(
        page.getByRole('heading', {
          name: finalCorrect ? 'Round passed' : 'Round not passed',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Hear again', exact: true })).toHaveCount(0);
      const stoppedId = (await snapshot()).current?.id;
      const clarification = await turnMarker(page);
      await page
        .getByLabel('Message', { exact: true })
        .fill('Wait before restarting. What score do I need to pass?');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expectOneSpokenReply(page, clarification, 'Round clarification does not restart');
      expect((await snapshot()).session?.awaitingRoundChoice).toBe(true);
      expect((await snapshot()).current?.id).toBe(stoppedId);
      const restarting = page.waitForRequest(
        (request) =>
          request.url().endsWith('/api/agent/tools') &&
          request.postDataJSON()?.name === 'start_round',
      );
      await page
        .getByLabel('Message', { exact: true })
        .fill('Yes, start another round of this lesson.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await restarting;
      await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
        'data-phase',
        'listening',
        { timeout: 60_000 },
      );
      await expect(page.getByTestId('piano-diagram')).toHaveCount(0);
      const after = await snapshot();
      expect(after.current?.id).not.toBe(question.snapshot.current!.id);
      expect(after.course.round).toMatchObject({
        number: round.number + 1,
        correct: 0,
        answers: [],
      });
      await page.close();
      console.log(
        `PASS native ${finalCorrect ? '8/10 pass' : 'early failure'} verdict, explicit retry consent, and empty next round`,
      );
    }
  } finally {
    await browser.close();
  }
}

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import request from 'supertest';
import { Store } from '../../server/db/database.js';
import { createApp } from '../../server/app.js';
import { createExercise } from '../../server/services/exercise/generator.js';
import type { Exercise, ExerciseTarget } from '../../server/types/exercise.types.js';
import type { SkillId } from '../../shared/types/course.js';
import type { ToolResult } from '../../server/types/agent.types.js';
import { controlledCoachScript } from '../browser-coach.js';
import { audioEvidenceScript } from '../browser-audio.js';

type Engine = { store: Store; game: Awaited<ReturnType<typeof createApp>>['game'] };
const test = base.extend<{ engine: Engine }>({
  engine: async ({ page }, use) => {
    const store = await Store.open(':memory:');
    try {
      const { app, game } = await createApp(
        {
          port: 3101,
          databasePath: ':memory:',
          azureEndpoint: '',
          apiKey: '',
          deployment: 'test',
          transcriptionDeployment: '',
          configured: false,
        },
        store,
      );
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/realtime/connect')
          return route.fulfill({
            json: { answer: 'test', sessionId: route.request().postDataJSON().sessionId },
          });
        const path = url.pathname + url.search;
        const method = route.request().method();
        const pending =
          method === 'POST'
            ? request(app).post(path)
            : method === 'PUT'
              ? request(app).put(path)
              : request(app).get(path);
        pending.set('Host', '127.0.0.1');
        const marker = await route.request().headerValue('x-earrr-client');
        if (marker) pending.set('x-earrr-client', marker);
        const body = route.request().postData();
        if (body) pending.send(JSON.parse(body));
        const response = await pending;
        if (response.body?.snapshot) response.body.snapshot.configured = true;
        if (response.body && 'configured' in response.body) response.body.configured = true;
        await route.fulfill({
          status: response.status,
          headers: { 'content-type': 'application/json' },
          body: response.status === 204 ? '' : JSON.stringify(response.body),
        });
      });
      await page.context().grantPermissions(['microphone']);
      await use({ store, game });
    } finally {
      if (!page.isClosed()) await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'wait' });
      await store.close();
    }
  },
});
const player = (page: Page) => page.getByRole('region', { name: 'Exercise player', exact: true });

async function pendingQuestion(engine: Engine, skillId: SkillId, target: ExerciseTarget) {
  const started = await engine.game.execute({
    callId: randomUUID(),
    name: 'start_session',
    arguments: { mode: 'solo', focus: skillId },
  });
  const session = started.snapshot.session!;
  await engine.game.execute({
    callId: randomUUID(),
    sessionId: session.id,
    name: 'play_exercise',
    arguments: {},
  });
  const round = (await engine.store.progress.round(skillId))!;
  const exercise: Exercise = {
    ...createExercise({
      id: randomUUID(),
      skillId,
      seed: 19,
      target: { root: 0, ...target },
      settings: await engine.store.user.getSettings(),
      now: new Date().toISOString(),
    }),
    roundId: round.id,
    roundTargetId: round.remaining[0]!.id,
  };
  await engine.store.exercises.save(exercise, session.id);
  await engine.store.sessions.save({
    ...(await engine.store.sessions.get(session.id))!,
    currentExerciseId: exercise.id,
  });
  return exercise;
}

const scenarios: Array<{
  skill: SkillId;
  target: ExerciseTarget;
  diagram: string;
  answer: (exercise: Exercise) => string;
}> = [
  { skill: 'major-functions', target: { degree: 4 }, diagram: 'progression', answer: () => 'IV' },
  {
    skill: 'scales',
    target: { scale: 'harmonicMinor' },
    diagram: 'scale',
    answer: () => 'harmonic minor',
  },
  {
    skill: 'modes',
    target: { scale: 'lydian', format: 'compare' },
    diagram: 'scale',
    answer: () => 'lydian',
  },
  {
    skill: 'minor-modes',
    target: { scale: 'dorian' },
    diagram: 'scale',
    answer: () => 'dorian',
  },
  {
    skill: 'progressions',
    target: { length: 4, format: 'complete' },
    diagram: 'progression',
    answer: (exercise) => String(exercise.expected.degree),
  },
  {
    skill: 'cadences',
    target: { length: 3, format: 'complete' },
    diagram: 'progression',
    answer: (exercise) => String(exercise.expected.degree),
  },
  {
    skill: 'seventh-colors',
    target: { quality: 'halfDiminished7', format: 'compare' },
    diagram: 'piano',
    answer: () => 'half diminished',
  },
  {
    skill: 'extensions',
    target: { quality: 'dominant9', format: 'compare' },
    diagram: 'piano',
    answer: () => '9',
  },
  {
    skill: 'upper-alterations',
    target: { quality: '7#11', format: 'identify' },
    diagram: 'piano',
    answer: () => '7#11',
  },
];

for (const width of [1440, 390, 320]) {
  for (const scenario of scenarios) {
    if (width === 320 && !['scales', 'cadences', 'extensions'].includes(scenario.skill)) continue;
    test(`${scenario.skill} uses its own concise question, result and review at ${width}`, async ({
      page,
      engine,
    }) => {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 900 : width === 320 ? 568 : 844,
      });
      const exercise = await pendingQuestion(engine, scenario.skill, scenario.target);
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      await page.goto('/');
      await page.getByRole('button', { name: 'Start training', exact: true }).click();
      await expect(player(page)).toBeVisible();
      await expect(player(page).getByTestId('piano-diagram')).toHaveCount(0);
      await expect(player(page).getByTestId('musical-diagram')).toHaveCount(0);
      const question = player(page).getByTestId('question-diagram');
      if (
        exercise.task ||
        exercise.kind === 'degree' ||
        exercise.kind === 'function' ||
        exercise.kind === 'progression'
      ) {
        await expect(question).toBeVisible();
        await expect(question.locator('[data-note-midi]')).toHaveCount(0);
        if (exercise.kind === 'function') {
          await expect(question.getByTestId('music-notation')).toHaveCount(0);
          await expect(question).toContainText('CM7');
          await expect(question).toContainText('?');
        }
        if (exercise.task?.kind === 'complete') {
          await expect(question).toContainText('?');
        }
        if (exercise.kind === 'progression' || exercise.kind === 'melody')
          await expect.poll(() => question.getAttribute('data-active-position')).not.toBe('-1');
      }
      await expect(player(page)).toHaveAttribute('data-phase', 'listening');
      if (['major-functions', 'progressions', 'modes'].includes(scenario.skill))
        await page.screenshot({
          path: `test-results\\${scenario.skill}-question-${width}.png`,
          fullPage: true,
          animations: 'disabled',
        });
      const result = page.waitForResponse('**/api/solo/answer');
      await page
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill(scenario.answer(exercise));
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const scored: ToolResult = await (await result).json();
      expect(scored.grade?.verdict).toBe('correct');
      const diagram = player(page).getByTestId(
        scenario.diagram === 'piano' ? 'piano-diagram' : 'musical-diagram',
      );
      if (scenario.diagram !== 'piano')
        await expect(diagram).toHaveAttribute('data-diagram-kind', scenario.diagram);
      await expect(diagram).toHaveAttribute('data-example-id', exercise.id);
      if (scenario.diagram === 'piano') {
        const notes = await diagram
          .locator('[data-note-midi]')
          .evaluateAll((nodes) =>
            nodes.map((node) => Number(node.getAttribute('data-note-midi'))).sort((a, b) => a - b),
          );
        expect(notes).toEqual(
          [
            ...new Set(
              exercise.audio.events
                .filter((note) => note.role === 'exercise')
                .map((note) => note.midi),
            ),
          ].sort((a, b) => a - b),
        );
      } else if (scenario.diagram === 'progression') {
        await expect(diagram.getByTestId('music-notation')).toHaveCount(0);
        await expect(diagram.locator('[data-question-position]')).not.toHaveCount(0);
      } else if (width > 320) {
        await expect(diagram.getByTestId('music-notation').locator('svg')).toBeVisible();
        expect(await page.evaluate(() => document.fonts.check('40px Bravura'))).toBe(true);
      }
      await expect(player(page).getByRole('region', { name: 'Pass condition' })).toContainText(
        '8/10',
      );
      await expect(player(page).locator('[data-outcome="correct"]')).toHaveCount(1);
      await expect(
        player(page).getByRole('list', { name: 'Round answers' }).getByRole('listitem'),
      ).toHaveCount(10);
      await expect(page.getByTestId('coach-waveform')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next question', exact: true })).toBeInViewport(
        { ratio: 1 },
      );
      await page.screenshot({
        path: `test-results\\${scenario.skill}-result-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Next question', exact: true }).click();
      await expect(diagram).toHaveCount(0);
      const before = await engine.game.snapshot();
      const mark = page.getByRole('button', { name: 'Review answer 1: Correct', exact: true });
      await mark.click();
      const review = page.getByRole('dialog', { name: 'Answer review', exact: true });
      const reviewGraphic = review.getByTestId(
        scenario.diagram === 'piano' ? 'piano-diagram' : 'musical-diagram',
      );
      if (scenario.diagram !== 'piano')
        await expect(reviewGraphic).toHaveAttribute('data-diagram-kind', scenario.diagram);
      await expect(reviewGraphic).toHaveAttribute('data-example-id', exercise.id);
      const replay = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/tools') &&
          response.request().postDataJSON().name === 'replay_exercise',
      );
      await review.getByRole('button', { name: 'Hear again', exact: true }).click();
      const replayed: ToolResult = await (await replay).json();
      expect(replayed.review?.exerciseId).toBe(exercise.id);
      expect(replayed.snapshot.current?.id).toBe(before.current?.id);
      expect(replayed.snapshot.course.round).toEqual(before.course.round);
      expect(failures).toEqual([]);
    });
  }
}

test('later tutorials share the same meaningful display while core inversions retain piano', async ({
  page,
  engine,
}) => {
  await page.addInitScript({ content: controlledCoachScript });
  const started = await engine.game.execute({
    callId: randomUUID(),
    name: 'start_session',
    arguments: { mode: 'coach', focus: 'progressions' },
  });

  const sessionId = started.snapshot.session!.id;
  await engine.game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'teach_lesson',
    arguments: { stepId: 'progression-1-4-5-1' },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-mode', 'teaching');
  await expect(player(page).getByTestId('musical-diagram')).toHaveAttribute(
    'data-diagram-kind',
    'progression',
  );
  await expect(player(page).getByTestId('piano-diagram')).toHaveCount(0);
  await expect(player(page).getByTestId('music-notation')).toHaveCount(0);
  await expect(player(page).locator('[data-question-position]')).toHaveCount(4);
  expect((await engine.game.snapshot()).totalAnswers).toBe(0);
  await engine.game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'select_lesson',
    arguments: { skillId: 'triad-inversions' },
  });
  await engine.game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'teach_lesson',
    arguments: { stepId: 'major-1' },
  });
  await page.reload();
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  await expect(player(page).getByTestId('piano-diagram')).toBeVisible();
  await expect(player(page).getByTestId('musical-diagram')).toHaveCount(0);
});

test('reduced motion keeps musical listening markers static without disabling playback', async ({
  page,
  engine,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pendingQuestion(engine, 'progressions', { length: 4, format: 'complete' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  const question = player(page).getByTestId('question-diagram');
  await expect(question).toHaveAttribute('data-active-position', '-1');
  await expect(question.locator('[data-active="true"]')).toHaveCount(0);
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  expect((await engine.game.snapshot()).session?.listened).toBeGreaterThan(0);
  expect((await engine.game.snapshot()).totalAnswers).toBe(0);
});

for (const skillId of ['intervals-foundation', 'intervals-harmonic'] as const) {
  test(`${skillId} has four interval demos and no perfect-fourth tutorial step`, async ({
    page,
    engine,
  }) => {
    const started = await engine.game.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'coach', focus: skillId },
    });
    await engine.game.execute({
      callId: randomUUID(),
      sessionId: started.snapshot.session!.id,
      name: 'teach_lesson',
      arguments: { stepId: 'perfect-fifth' },
    });
    await page.addInitScript({ content: controlledCoachScript });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await expect(player(page)).toHaveAttribute('data-mode', 'teaching');
    const steps = page.getByRole('navigation', { name: 'Tutorial steps', exact: true });
    await expect(steps.locator('[data-step-id]')).toHaveCount(6);
    await expect(steps.locator('[data-step-id="perfect-fourth"]')).toHaveCount(0);
    for (const id of ['minor-third', 'major-third', 'perfect-fifth', 'octave'])
      await expect(steps.locator(`[data-step-id="${id}"]`)).toHaveCount(1);
    await expect(
      player(page).getByRole('heading', { name: 'perfect fifth', exact: true }),
    ).toBeVisible();
    expect((await engine.game.snapshot()).course.completedLessons).toBe(0);
    await page.screenshot({
      path: join('test-results', `four-interval-tutorial-${skillId}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`opens advanced lessons freely and marks only passed exercises at ${viewport.width}`, async ({
    page,
    engine,
  }) => {
    await page.setViewportSize(viewport);
    await pendingQuestion(engine, 'pitch-direction', { direction: 'up' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const outline = page.getByRole('complementary', { name: 'Course outline', exact: true });
    const openOutline = async () => {
      if (viewport.width < 1024)
        await page.getByRole('button', { name: 'Open lessons', exact: true }).click();
    };
    await openOutline();
    const collapsed = outline.getByRole('button', { expanded: false });
    while (await collapsed.count()) await collapsed.first().click();
    const marks = outline.getByTestId('lesson-status');
    await expect(marks).toHaveCount(27);
    await expect(marks.locator('svg')).toHaveCount(0);
    await expect(outline.getByRole('button', { name: /locked/i })).toHaveCount(0);
    await expect(outline.getByTestId('ear-companion')).toHaveAttribute('data-tier', '0');
    const advanced = outline.getByRole('button', { name: 'Ninth chords', exact: true });
    await expect(advanced).toBeEnabled();
    await advanced.click();
    await expect(page.getByRole('heading', { name: 'Ninth chords', exact: true })).toBeVisible();
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const selected = await engine.game.snapshot();
    expect(selected.course.selectedLesson).toBe('extensions');
    expect(selected.course.completedLessons).toBe(0);
    expect(selected.totalAnswers).toBe(0);
    const sessionId = selected.session!.id;
    for (let index = 0; index < 8; index++) {
      const played = await engine.game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      const exercise = (await engine.store.exercises.get(played.snapshot.current!.id))!;
      await engine.game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      });
    }
    await page.reload();
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await expect(player(page).getByTestId('round-result')).toHaveText('Round passed');
    await openOutline();
    const completed = outline.getByRole('button', { name: 'Ninth chords, completed', exact: true });
    await expect(completed.getByTestId('lesson-status')).toHaveAttribute(
      'data-status',
      'completed',
    );
    await expect(completed.getByTestId('lesson-status').locator('svg')).toBeVisible();
    const row = (await completed.boundingBox())!;
    const check = (await completed.getByTestId('lesson-status').boundingBox())!;
    expect(check.x).toBeGreaterThan(row.x + row.width / 2);
    await expect(outline.getByTestId('ear-companion')).toHaveAttribute('data-tier', '1');
    await expect(outline.getByTestId('ear-companion')).toContainText('Pitch Scout');
    expect((await engine.game.snapshot()).course.completedLessons).toBe(1);
    await page.screenshot({
      path: join('test-results', `open-lessons-passed-check-${viewport.width}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  });
}

test.describe('short touch-screen round result', () => {
  test.use({ hasTouch: true });
  test('keeps the complete result, restart and next lesson visible at 320x568', async ({
    page,
    engine,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await pendingQuestion(engine, 'extensions', { quality: 'dominant9', format: 'compare' });
    const sessionId = (await engine.game.snapshot()).session!.id;
    for (let index = 0; index < 8; index++) {
      const played = await engine.game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      const exercise = (await engine.store.exercises.get(played.snapshot.current!.id))!;
      await engine.game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      });
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Start training', exact: true }).tap();
    await expect(
      player(page).getByRole('heading', { name: 'Round passed', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(player(page).getByTestId('piano-diagram')).toBeInViewport({ ratio: 1 });
    const restart = player(page).getByRole('button', { name: 'Restart exercises', exact: true });
    const next = player(page).getByRole('button', { name: 'Next lesson', exact: true });
    await expect(restart).toBeInViewport({ ratio: 1 });
    await expect(next).toBeInViewport({ ratio: 1 });
    await expect(restart).toHaveAttribute('data-variant', 'outline');
    expect((await next.boundingBox())!.x).toBeGreaterThan((await restart.boundingBox())!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: 'test-results\\extended-round-touch-320.png',
      fullPage: true,
      animations: 'disabled',
    });
    await restart.tap();
    await expect(player(page).getByTestId('round-result')).toHaveCount(0);
    await expect(player(page).getByTestId('musical-diagram')).toHaveCount(0);
    await expect(player(page).locator('[data-outcome="unanswered"]')).toHaveCount(10);
  });
});

test('rapid progression replays keep one audio plan at the same loudness and a later lesson wins', async ({
  page,
  engine,
}) => {
  test.setTimeout(60_000);
  const exercise = await pendingQuestion(engine, 'progressions', { length: 4, format: 'complete' });
  await page.addInitScript({ content: audioEvidenceScript });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const firstPeak = await page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').pianoPeak);
  expect(firstPeak).toBeGreaterThan(0.01);
  await page.evaluate(() => {
    Reflect.get(window, 'earrrAudioEvidence').pianoPeak = 0;
  });
  const replay = page.getByRole('button', { name: 'Hear again', exact: true });
  await replay.evaluate((button) => {
    for (let count = 0; count < 12; count++) (button as HTMLButtonElement).click();
  });
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  const repeatedPeak = await page.evaluate(
    () => Reflect.get(window, 'earrrAudioEvidence').pianoPeak,
  );
  expect(repeatedPeak).toBeLessThanOrEqual(firstPeak * 1.15 + 0.02);
  expect((await engine.game.snapshot()).current?.id).toBe(exercise.id);
  expect((await engine.game.snapshot()).settings.volume).toBe(0.8);
  const voices = (await page.evaluate(
    () => Reflect.get(window, 'earrrAudioEvidence').sampleVoices,
  )) as Array<{ start: number; stop: number }>;
  const maxSimultaneous = Math.max(
    ...voices.map(
      (voice) =>
        voices.filter((other) => other.start <= voice.start && other.stop > voice.start).length,
    ),
  );
  const plannedVoices = Math.max(
    ...exercise.audio.events.map(
      (note) =>
        exercise.audio.events.filter(
          (other) => other.at <= note.at && other.at + other.duration + 0.32 > note.at,
        ).length,
    ),
  );
  expect(maxSimultaneous).toBeLessThanOrEqual(plannedVoices + 1);
  await page.getByRole('button', { name: /Intervals/, expanded: false }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/tools', async (route) => {
    if (route.request().postDataJSON().name === 'replay_exercise') await held;
    await route.fallback();
  });
  await replay.click();
  await page.getByRole('button', { name: /^Pitch direction/ }).click();
  await page.getByRole('button', { name: 'Complete the progression', exact: true }).click();
  release();
  await expect(player(page)).toHaveAttribute('data-phase', 'playing');
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  expect((await engine.game.snapshot()).course.selectedLesson).toBe('progressions');
  expect((await engine.game.snapshot()).current?.id).toBe(exercise.id);
  await page.getByRole('button', { name: /^Pitch direction/ }).click();
  await expect(page.getByTestId('lesson-toolbar')).toHaveText('Pitch direction');
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  expect((await engine.game.snapshot()).course.selectedLesson).toBe('pitch-direction');
  expect((await engine.game.snapshot()).totalAnswers).toBe(0);
  await expect(page.getByTestId('fatal-toast')).toHaveCount(0);
  expect(failures).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 768, height: 900 },
  { width: 320, height: 568 },
]) {
  test(`persists the five-step tutor speed with the original speed centered at ${viewport.width}`, async ({
    page,
    engine,
  }) => {
    await page.setViewportSize(viewport);
    await pendingQuestion(engine, 'pitch-direction', { direction: 'up' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Audio settings', exact: true });
    const speed = popup.getByRole('slider', { name: 'Tutor speed', exact: true });
    await expect(speed).toHaveAttribute('aria-valuenow', '2');
    await expect(speed).toHaveAttribute('aria-valuetext', 'Default, 1.2 times speed');
    await speed.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => (await engine.store.user.getSettings()).voiceSpeed).toBe(1.5);
    await page.keyboard.press('ArrowLeft');
    await expect(speed).toHaveAttribute('aria-valuenow', '3');
    await expect.poll(async () => (await engine.store.user.getSettings()).voiceSpeed).toBe(1.35);
    expect((await engine.game.snapshot()).settings.volume).toBe(0.8);
    await page.screenshot({
      path: join('test-results', `tutor-speed-${viewport.width}.png`),
      animations: 'disabled',
      fullPage: true,
    });
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.reload();
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
    await expect(page.getByRole('slider', { name: 'Tutor speed', exact: true })).toHaveAttribute(
      'aria-valuenow',
      '3',
    );
  });
}

test('starts a new visible conversation on every lesson visit while retaining model history', async ({
  page,
  engine,
}) => {
  await page.addInitScript({ content: controlledCoachScript });
  const started = await engine.game.execute({
    callId: randomUUID(),
    name: 'start_session',
    arguments: { mode: 'coach', focus: 'pitch-direction' },
  });
  await engine.game.execute({
    callId: randomUUID(),
    sessionId: started.snapshot.session!.id,
    name: 'start_practice',
    arguments: {},
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
    .toBe(true);
  await page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').tool('inspect_progress', {}));
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'earrrCoachFixture').ready()))
    .toBe(true);
  const marker = 'This explanation belongs to the first pitch lesson visit.';
  await page.evaluate((text) => Reflect.get(window, 'earrrCoachFixture').reply(text), marker);
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      (await engine.game.snapshot()).transcript.some((message) => message.text === marker),
    )
    .toBe(true);
  const outline = page.getByRole('navigation', { name: 'Chapters and lessons' });
  await outline.getByRole('button', { name: /Chord colors/ }).click();
  await outline.getByRole('button', { name: 'Major & minor', exact: true }).click();
  await expect(page.getByTestId('lesson-toolbar')).toHaveText('Major & minor');
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  await outline.getByRole('button', { name: /^Pitch direction/ }).click();
  await expect(page.getByTestId('lesson-toolbar')).toHaveText('Pitch direction');
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Start training', exact: true }).click();
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  expect((await engine.game.snapshot()).transcript.some((message) => message.text === marker)).toBe(
    true,
  );
  expect((await engine.game.snapshot()).totalAnswers).toBe(0);
});

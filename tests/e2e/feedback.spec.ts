import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import request from 'supertest';
import { Store } from '../../server/db/database.js';
import { createApp } from '../../server/app.js';
import type { FeedbackSubmission } from '../../shared/types/feedback.js';

type Engine = { store: Store; game: Awaited<ReturnType<typeof createApp>>['game'] };
const test = base.extend<{ engine: Engine }>({
  engine: async ({ page }, use) => {
    const store = await Store.open(':memory:');
    try {
      const { app, game } = await createApp(
        {
          port: 3101,
          databasePath: ':memory:',
          configured: false,
          apiKey: '',
          azureEndpoint: '',
          deployment: 'test',
          transcriptionDeployment: '',
        },
        store,
      );
      const started = await game.execute({
        callId: randomUUID(),
        name: 'start_session',
        arguments: { mode: 'solo' },
      });
      await game.execute({
        callId: randomUUID(),
        sessionId: started.snapshot.session!.id,
        name: 'play_exercise',
        arguments: {},
      });
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
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
const dialog = (page: Page) =>
  page.getByRole('dialog', {
    name: 'How useful has this been for your ear training?',
    exact: true,
  });
const enter = async (page: Page) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Practice offline', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Exercise player', exact: true })).toHaveAttribute(
    'data-phase',
    'listening',
  );
};

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`fits the in-training header and mascot rating modal at ${viewport.width}`, async ({
    page,
    engine,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await enter(page);
    const before = await engine.game.snapshot();
    const feedback = page.getByRole('button', { name: 'Feedback', exact: true });
    const login = page.getByRole('button', { name: 'Log In', exact: true });
    const feedbackBox = (await feedback.boundingBox())!;
    const loginBox = (await login.boundingBox())!;
    expect(feedbackBox.x + feedbackBox.width).toBeLessThanOrEqual(loginBox.x);
    await expect(feedback).toBeInViewport({ ratio: 1 });
    await expect(feedback.locator('.lucide-message-square-text')).toBeVisible();
    await expect(login).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await feedback.click();
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole('radiogroup', { name: 'Usefulness rating' }).getByRole('radio'),
    ).toHaveCount(5);
    await expect(modal.locator('[data-part="left-ear"],[data-part="right-ear"]')).toHaveCount(0);
    await expect(modal.locator('[data-part="face"]')).toHaveCount(5);
    for (const [label, rating] of [
      ['Not useful', '1: Not useful'],
      ['Very useful', '5: Very useful'],
    ] as const) {
      const labelBox = (await modal.getByText(label, { exact: true }).boundingBox())!;
      const ratingBox = (await modal
        .getByRole('radio', { name: rating, exact: true })
        .boundingBox())!;
      expect(labelBox.y + labelBox.height).toBeLessThan(ratingBox.y);
      expect(labelBox.x + labelBox.width / 2).toBeCloseTo(ratingBox.x + ratingBox.width / 2, 0);
    }
    await expect(modal.getByRole('radio', { name: 'No', exact: true })).toBeChecked();
    await expect(modal.getByLabel('Reply email', { exact: true })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await modal.getByRole('radio', { name: '4: Useful', exact: true }).click();
    await expect(modal.getByRole('radio', { name: '4: Useful', exact: true })).toBeChecked();
    await modal
      .getByLabel("Anything you'd like to share?", { exact: true })
      .fill('The quick questions are helpful.');
    await expect(modal.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: join('test-results', `feedback-default-${viewport.width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await modal.getByRole('radio', { name: 'Yes', exact: true }).click();
    await expect(modal.getByLabel('Reply email', { exact: true })).toHaveAttribute(
      'placeholder',
      'your-email@example.com',
    );
    for (const field of [
      modal.getByLabel("Anything you'd like to share?", { exact: true }),
      modal.getByLabel('Reply email', { exact: true }),
    ]) {
      expect(
        await field.evaluate((element) =>
          Number(getComputedStyle(element, '::placeholder').fontWeight),
        ),
      ).toBe(350);
    }
    await modal.getByLabel("Anything you'd like to share?", { exact: true }).fill('');
    await page.screenshot({
      path: join('test-results', `feedback-placeholders-${viewport.width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await modal
      .getByLabel("Anything you'd like to share?", { exact: true })
      .fill('The quick questions are helpful.');
    await modal.getByLabel('Reply email', { exact: true }).fill('listener@example.com');
    await expect(modal.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
    await expect(modal.getByRole('button', { name: 'Submit', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: join('test-results', `feedback-reply-${viewport.width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
    await expect(feedback).toBeFocused();
    expect(await engine.game.snapshot()).toEqual(before);
  });
}

test('submits without a reply address by default and overwrites the same player row invisibly', async ({
  page,
  engine,
}) => {
  await enter(page);
  const before = await engine.game.snapshot();
  const feedback = page.getByRole('button', { name: 'Feedback', exact: true });
  await feedback.click();
  const modal = dialog(page);
  await modal.getByRole('radio', { name: '5: Very useful', exact: true }).click();
  await modal.getByLabel("Anything you'd like to share?", { exact: true }).fill('  Nice pacing.  ');
  const submitted = page.waitForResponse('**/api/feedback');
  await modal.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(modal).not.toBeVisible();
  expect((await submitted).status()).toBe(204);
  expect(await engine.store.db.prepare('SELECT * FROM earrr_feedback').get()).toMatchObject({
    rating: 5,
    message: 'Nice pacing.',
    reply_email: null,
  });
  await feedback.click();
  await expect(modal.getByRole('radio', { name: 'No', exact: true })).toBeChecked();
  await expect(modal.getByLabel("Anything you'd like to share?", { exact: true })).toBeEmpty();
  await modal.getByRole('radio', { name: '2: A little useful', exact: true }).click();
  await modal
    .getByLabel("Anything you'd like to share?", { exact: true })
    .fill('The first exercise needs more context.');
  await modal.getByRole('radio', { name: 'Yes', exact: true }).click();
  await modal.getByLabel('Reply email', { exact: true }).fill('listener@example.com');
  const updated = page.waitForResponse('**/api/feedback');
  await modal.getByRole('button', { name: 'Submit', exact: true }).click();
  expect((await updated).status()).toBe(204);
  const rows = await engine.store.db.prepare('SELECT * FROM earrr_feedback').all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ rating: 2, reply_email: 'listener@example.com' });
  expect(await engine.game.snapshot()).toEqual(before);
});

test('uses keyboard ratings and native email validation without sending hidden contact details', async ({
  page,
}) => {
  await enter(page);
  const submissions: FeedbackSubmission[] = [];
  await page.route('**/api/feedback', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, body: '' });
  });
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  const modal = dialog(page);
  const first = modal.getByRole('radio', { name: '1: Not useful', exact: true });
  await first.focus();
  await page.keyboard.down('ArrowRight');
  await expect(modal.getByRole('radio', { name: '2: A little useful', exact: true })).toBeFocused();
  await page.keyboard.up('ArrowRight');
  await expect(modal.getByRole('radio', { name: '2: A little useful', exact: true })).toBeChecked();
  await modal
    .getByLabel("Anything you'd like to share?", { exact: true })
    .fill('Could use shorter pauses.');
  await modal.getByRole('radio', { name: 'Yes', exact: true }).click();
  await modal.getByLabel('Reply email', { exact: true }).fill('invalid-address');
  await modal.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(modal).toBeVisible();
  expect(submissions).toEqual([]);
  await modal.getByLabel('Reply email', { exact: true }).fill('listener@example.com');
  await modal.getByRole('radio', { name: 'No', exact: true }).click();
  await modal.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(modal).not.toBeVisible();
  expect(submissions).toEqual([
    { rating: 2, message: 'Could use shorter pauses.', replyEmail: null },
  ]);
});

for (const { width, reducedMotion } of [
  { width: 1440, reducedMotion: false },
  { width: 320, reducedMotion: false },
  { width: 390, reducedMotion: true },
]) {
  test(`acknowledges a saved submission inside the button at ${width}, reduced motion ${reducedMotion}`, async ({
    page,
    engine,
  }) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    await enter(page);
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    const modal = dialog(page);
    await modal.getByRole('radio', { name: '4: Useful', exact: true }).click();
    await modal
      .getByLabel("Anything you'd like to share?", { exact: true })
      .fill('The concise feedback is useful.');
    const submit = modal.getByRole('button', { name: 'Submit', exact: true });
    const before = (await submit.boundingBox())!;
    let requests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/feedback')) requests++;
    });
    const response = page.waitForResponse('**/api/feedback');
    await submit.click();
    expect((await response).status()).toBe(204);
    const saved = modal.getByRole('button', { name: 'Feedback submitted', exact: true });
    await expect(saved).toHaveAttribute('data-feedback-state', 'sent');
    await expect(saved).toBeDisabled();
    await expect(modal.getByRole('status')).toHaveText('Feedback submitted.');
    const check = saved.getByTestId('feedback-submit-check');
    const motion = await check.evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation)
        .map((animation) => animation.animationName),
    );
    if (reducedMotion) expect(motion).toEqual([]);
    else {
      expect(motion).toEqual(
        expect.arrayContaining(['feedback-check-appear', 'feedback-check-draw']),
      );
      await check.evaluate((element) =>
        element.getAnimations({ subtree: true }).forEach((animation) => animation.finish()),
      );
    }
    await expect(check).toHaveCSS('opacity', '1');
    await expect
      .poll(() =>
        check
          .locator('path')
          .evaluate((element) => parseFloat(getComputedStyle(element).strokeDashoffset)),
      )
      .toBe(0);
    await expect(saved.locator('.feedback-submit-label')).toHaveCSS('opacity', '0');
    expect(await saved.boundingBox()).toEqual(before);
    await modal.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(requests).toBe(1);
    expect(
      await engine.store.db.prepare('SELECT count(*) AS count FROM earrr_feedback').get(),
    ).toMatchObject({ count: 1 });
    await page.screenshot({
      path: join('test-results', `feedback-submitted-${width}-${reducedMotion}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await expect(modal).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeFocused();
  });
}

for (const responseStatus of [204, 503]) {
  test(`a late ${responseStatus} response cannot dismiss or mark a newly reopened feedback form`, async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/feedback', async (route) => {
      await held;
      await route.fulfill({ status: responseStatus, body: '' });
    });
    try {
      await enter(page);
      const trigger = page.getByRole('button', { name: 'Feedback', exact: true });
      await trigger.click();
      const modal = dialog(page);
      await modal.getByRole('radio', { name: '4: Useful', exact: true }).click();
      await modal
        .getByLabel("Anything you'd like to share?", { exact: true })
        .fill('First submission.');
      const response = page.waitForResponse('**/api/feedback');
      await modal.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(modal.getByRole('button', { name: 'Submit', exact: true })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await modal.getByRole('button', { name: 'Close feedback', exact: true }).click();
      await expect(modal).not.toBeVisible();
      await trigger.click();
      await modal
        .getByLabel("Anything you'd like to share?", { exact: true })
        .fill('Keep this new draft.');
      release();
      expect((await response).status()).toBe(responseStatus);
      await page.waitForTimeout(1200);
      await expect(modal).toBeVisible();
      await expect(modal.getByLabel("Anything you'd like to share?", { exact: true })).toHaveValue(
        'Keep this new draft.',
      );
      await expect(
        modal.getByRole('button', { name: 'Feedback submitted', exact: true }),
      ).toHaveCount(0);
    } finally {
      release();
    }
  });
}

test('closes quietly after a failed sink without showing a false success or interrupting practice', async ({
  page,
  engine,
}) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[feedback]'))
      warnings.push(message.text());
  });
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/api/feedback', async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { error: { code: 'feedback_storage_unavailable' } } });
  });
  try {
    await enter(page);
    const before = await engine.game.snapshot();
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    const modal = dialog(page);
    await modal.getByRole('radio', { name: '3: Somewhat useful', exact: true }).click();
    await modal
      .getByLabel("Anything you'd like to share?", { exact: true })
      .fill('A low-stakes feedback submission.');
    const submit = modal.getByRole('button', { name: 'Submit', exact: true });
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole('button', { name: 'Feedback submitted', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('alertdialog', { name: 'Something went wrong' })).toHaveCount(0);
    finish();
    await expect.poll(() => warnings).toContain('[feedback] Submission rejected (503).');
    await expect(modal).not.toBeVisible();
    expect(await engine.game.snapshot()).toEqual(before);
    await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeEnabled();
  } finally {
    finish();
  }
});

for (const width of [1440, 390, 320]) {
  test(`prefills reply email and fits the signed-in header at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const id = randomUUID();
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await page.addInitScript(
      ({ id, expires }) => {
        localStorage.setItem(
          'earrr:auth',
          JSON.stringify({
            access_token: `${btoa('{}')}.${btoa(JSON.stringify({ sub: id, exp: expires }))}.fixture`,
            refresh_token: 'fixture-refresh-token',
            token_type: 'bearer',
            expires_at: expires,
            expires_in: 3600,
            user: {
              id,
              aud: 'authenticated',
              email: 'mira@example.com',
              user_metadata: { first_name: 'Alexandria', last_name: 'Constantinopoulos' },
              app_metadata: {},
              created_at: new Date().toISOString(),
            },
          }),
        );
      },
      { id, expires },
    );
    await page.route('https://feedback-fixture.supabase.co/**', (route) =>
      route.fulfill({ json: [{ first_name: 'Alexandria', last_name: 'Constantinopoulos' }] }),
    );
    await page.route('**/api/config', (route) =>
      route.fulfill({
        json: {
          auth: {
            enabled: true,
            url: 'https://feedback-fixture.supabase.co',
            publishableKey: 'fixture-public-key',
            googleEnabled: false,
            guestStorage: false,
          },
        },
      }),
    );
    await page.goto('/');
    await expect(
      page.getByRole('button', {
        name: 'Account menu for Alexandria Constantinopoulos',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Practice offline', exact: true }).click();
    const feedback = page.getByRole('button', { name: 'Feedback', exact: true });
    const account = page.getByRole('button', {
      name: 'Account menu for Alexandria Constantinopoulos',
      exact: true,
    });
    await expect(feedback).toBeInViewport({ ratio: 1 });
    await expect(account).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    const modal = dialog(page);
    await expect(modal.getByLabel('Reply email', { exact: true })).toHaveCount(0);
    await modal.getByRole('radio', { name: 'Yes', exact: true }).click();
    await expect(modal.getByLabel('Reply email', { exact: true })).toHaveValue('mira@example.com');
    await page.screenshot({
      path: join('test-results', `feedback-account-${width}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  });
}

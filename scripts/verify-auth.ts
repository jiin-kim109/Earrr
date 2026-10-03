import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { ApiEnvelope } from '../shared/types/user.js';
import type { Snapshot, ToolResult } from '../server/types/agent.types.js';
import { SaveCodec } from '../server/services/storage/save-codec.js';

loadEnvFile('.env');
const managed = process.argv.includes('--managed-server');
const port = managed ? 3115 : 3105;
const origin = `http://127.0.0.1:${port}`;
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const codec = new SaveCodec(process.env.LEARNING_SAVE_KEY!);
function learningOnly(scope: string, payload: string) {
  const archive = codec.open(scope, payload).archive;
  expect(Array.isArray(archive.tables.transcripts)).toBe(true);
  for (const checkpoint of archive.tables.session_checkpoints ?? [])
    expect(JSON.parse(String(checkpoint.state))).not.toHaveProperty('messages');
  expect(
    (archive.tables.conversation_events ?? []).some((event) =>
      [
        'message.saved',
        'response.completed',
        'response.interrupted',
        'connection.opened',
        'connection.closed',
      ].includes(String(event.kind)),
    ),
  ).toBe(false);
}
mkdirSync(resolve('test-results'), { recursive: true });
const profile = mkdtempSync(resolve('test-results', 'account-browser-'));
const users: string[] = [];
let context: BrowserContext | null = null;
const failures: string[] = [];
let server: ChildProcess | null = null;

async function startServer() {
  const entry = process.argv.includes('--production-server')
    ? ['dist\\server\\main.js']
    : ['--import', 'tsx', 'server\\main.ts'];
  server = spawn(process.execPath, entry, {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: ':memory:', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  server.stderr!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`The isolated account server stopped: ${output}`);
    try {
      if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch (error) {
      if (attempt === 119) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The isolated account server did not become ready.');
}
async function stopServer() {
  const current = server;
  if (!current) return;
  server = null;
  if (current.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    current.once('exit', () => resolve());
    current.kill('SIGTERM');
  });
}
async function screen(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results\\earrr-auth-${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

async function open() {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--mute-audio'],
  });
  const page = context.pages()[0]!;
  page.on('pageerror', (error) => failures.push(error.message));
  await context.route(
    /\/api\/(?:state|tools|agent\/tools|solo\/answer|workspaces\/guest|workspaces\/import)$/,
    async (route) => {
      const response = await route.fetch();
      if (!response.ok()) {
        await route.fulfill({ response });
        return;
      }
      const body = await response.json();
      const data = body.data ?? body;
      if (data.snapshot) data.snapshot.configured = false;
      if ('configured' in data) data.configured = false;
      await route.fulfill({ response, json: body });
    },
  );
  return page;
}
async function close() {
  await context!.close();
  context = null;
}
const player = (page: Page) => page.getByLabel('Exercise player', { exact: true });

try {
  if (managed) await startServer();
  let page = await open();
  await page.addInitScript(() => {
    const native = indexedDB.open.bind(indexedDB);
    let denied = false;
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
      if (!denied) {
        denied = true;
        throw new DOMException('Transient storage denial.', 'SecurityError');
      }
      return native(...args);
    };
  });
  await page.goto(origin);
  await expect(page.getByText('Transient storage denial.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Practice offline', exact: true }).click();
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await page.getByLabel('Message', { exact: true }).fill('up');
  const graded = page.waitForResponse('**/api/solo/answer');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const result: ApiEnvelope<ToolResult> = await (await graded).json();
  learningOnly('guest', result.guestSave!.checkpoint);
  let total = result.data.snapshot.totalAnswers;
  let questionId = result.data.snapshot.current!.id;
  expect(total).toBe(1);
  await expect(
    player(page).locator('[data-outcome="correct"],[data-outcome="incorrect"]'),
  ).toHaveCount(1);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hear again', exact: true })).toBeVisible();
  await expect(player(page)).toHaveAttribute('data-phase', 'listening');
  await page.route('**/api/solo/answer', async (route) => {
    const committed: ApiEnvelope<ToolResult> = await (await route.fetch()).json();
    total = committed.data.snapshot.totalAnswers;
    questionId = committed.data.snapshot.current!.id;
    await route.abort('failed');
  });
  await page.getByLabel('Message', { exact: true }).fill('up');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => total).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((done) => {
            const request = indexedDB.open('earrr-learning', 1);
            request.onsuccess = () => {
              const read = request.result.transaction('guest').objectStore('guest').get('pending');
              read.onsuccess = () => {
                done(read.result?.length ?? 0);
                request.result.close();
              };
            };
          }),
      ),
    )
    .toBe(1);
  expect(total).toBe(2);
  await close();
  if (managed) {
    await stopServer();
    await startServer();
  }

  page = await open();
  const restoredResponse = page.waitForResponse('**/api/state');
  await page.goto(origin);
  await expect(page.getByRole('button', { name: 'Practice offline', exact: true })).toBeVisible();
  await expect(player(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Practice offline', exact: true }).click();
  await expect(player(page)).toBeVisible();
  await expect(
    player(page).locator('[data-outcome="correct"],[data-outcome="incorrect"]'),
  ).toHaveCount(2);
  const restoredState: ApiEnvelope<Snapshot> = await (await restoredResponse).json();
  expect(restoredState.data.totalAnswers).toBe(total);
  questionId = restoredState.data.current!.id;
  console.log(
    'PASS guest progress and an unacknowledged answer survive browser/server restart behind mandatory audio setup',
  );
  if (managed && process.argv.includes('--production-server')) {
    await stopServer();
    await startServer();
    const liveRestore = page.waitForResponse(
      (response) => response.url().endsWith('/api/tools') && response.ok(),
    );
    await page.getByRole('button', { name: 'Next question', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Hear again', exact: true })).toBeVisible();
    await expect(player(page)).toHaveAttribute('data-phase', 'listening');
    const recovered: ApiEnvelope<ToolResult> = await (await liveRestore).json();
    questionId = recovered.data.snapshot.current!.id;
    expect(recovered.data.snapshot.totalAnswers).toBe(total);
    console.log(
      'PASS a running guest restores its capability after a server restart without reloading',
    );
  }

  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.', exact: true })).toBeVisible();
  await screen(page, 'login-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screen(page, 'login-mobile');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await screen(page, 'signup-mobile');
  const email = `earrr-test-${crypto.randomUUID()}@example.com`;
  const password = `Earrr-${crypto.randomUUID()}`;
  let otp = '';
  await page.route('**/auth/v1/signup*', async (route) => {
    const input = route.request().postDataJSON();
    const generated = await admin.auth.admin.generateLink({
      type: 'signup',
      email: input.email,
      password: input.password,
      options: { data: input.data },
    });
    if (generated.error || !generated.data.user)
      throw generated.error ?? new Error('Fixture account could not be created.');
    users.push(generated.data.user.id);
    otp = generated.data.properties.email_otp;
    await route.fulfill({ json: generated.data.user });
  });
  await page.getByLabel('First name', { exact: true }).fill('Account');
  await page.getByLabel('Last name', { exact: true }).fill('Verification');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.', exact: true })).toBeVisible();
  expect(otp).toHaveLength(6);
  await screen(page, 'verify-mobile');
  await page.getByLabel('Email code', { exact: true }).fill(otp);
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Practice offline', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(player(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Account menu/ })).toContainText(
    'Account Verification',
  );
  await expect(page.getByRole('button', { name: /^Account menu/ })).toHaveAttribute(
    'data-variant',
    'outline',
  );
  await page.getByRole('button', { name: 'Practice offline', exact: true }).click();
  await expect(player(page)).toBeVisible();
  const cloud = await admin
    .from('earrr_learning_saves')
    .select('revision,payload,imported_guest_id')
    .eq('user_id', users[0]!)
    .single();
  if (cloud.error) throw cloud.error;
  expect(cloud.data.imported_guest_id).not.toBeNull();
  expect(cloud.data.payload).not.toContain('expected');
  learningOnly(`account:${users[0]!}`, cloud.data.payload);
  const local = await page.evaluate(
    () =>
      new Promise<unknown>((done, fail) => {
        const opening = indexedDB.open('earrr-learning', 1);
        opening.onsuccess = () => {
          const request = opening.result.transaction('guest').objectStore('guest').get('save');
          request.onsuccess = () => done(request.result ?? null);
          request.onerror = () => fail(new Error('Could not inspect local transfer.'));
        };
      }),
  );
  expect(local).toBeNull();
  console.log(
    'PASS actual email-code verification logs in, commits guest progress to Supabase and clears the local save',
  );
  await page.screenshot({
    path: 'test-results\\earrr-account-learning.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: /^Account menu/ }).click();
  await screen(page, 'account-mobile');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 568 });
  await screen(page, 'named-account-small');
  await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('earrr:auth')!);
    session.user.user_metadata = {};
    localStorage.setItem('earrr:auth', JSON.stringify(session));
  });
  await close();

  page = await open();
  await page.goto(origin);
  await expect(page.getByRole('button', { name: 'Practice offline', exact: true })).toBeVisible();
  await expect(player(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Practice offline', exact: true }).click();
  await expect(player(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Account menu/ })).toContainText(
    'Account Verification',
  );
  const authenticated = await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('earrr:auth')!);
    return { access: session.access_token, refresh: session.refresh_token };
  });
  const stateResponse = await fetch(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${authenticated.access}` },
  });
  const state = (await stateResponse.json()) as ApiEnvelope<Snapshot>;
  expect(Array.isArray(state.data.transcript)).toBe(true);
  expect(state.data.totalAnswers).toBe(total);
  expect(state.data.current?.id).toBe(questionId);
  await expect(page.locator('[data-message-role="user"]')).not.toHaveCount(0);
  console.log('PASS remembered metadata without names still resolves the full-name account button');
  console.log('PASS login and cloud learning progress survive a full browser restart');

  const publicClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const refreshed = await publicClient.auth.refreshSession({
    refresh_token: authenticated.refresh,
  });
  if (refreshed.error || !refreshed.data.session)
    throw refreshed.error ?? new Error('Refresh returned no session.');
  const own = await publicClient.from('earrr_learning_saves').select('user_id,payload');
  if (own.error) throw own.error;
  expect(own.data).toHaveLength(1);
  expect(own.data[0]!.user_id).toBe(users[0]);
  const denied = await publicClient.rpc('earrr_save_learning', {
    subject_user_id: users[0],
    expected_revision: cloud.data.revision,
    next_payload: 'untrusted',
    guest_import_id: null,
  });
  expect(denied.error).not.toBeNull();
  console.log(
    'PASS refresh tokens remain usable and authenticated clients cannot overwrite trusted learning saves',
  );

  const second = await admin.auth.admin.createUser({
    email: `earrr-isolation-${crypto.randomUUID()}@example.com`,
    password,
    email_confirm: true,
    user_metadata: { first_name: 'Other', last_name: 'Account' },
  });
  if (second.error || !second.data.user)
    throw second.error ?? new Error('The isolation account could not be created.');
  users.push(second.data.user.id);
  const otherClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const otherLogin = await otherClient.auth.signInWithPassword({
    email: second.data.user.email!,
    password,
  });
  if (otherLogin.error || !otherLogin.data.session)
    throw otherLogin.error ?? new Error('The isolation account could not log in.');
  const otherAccess = otherLogin.data.session.access_token;
  const independent = await fetch(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${otherAccess}` },
  });
  expect(independent.ok).toBe(true);
  const independentState: ApiEnvelope<Snapshot> = await independent.json();
  expect(independentState.data.totalAnswers).toBe(0);
  expect(independentState.data.session).toBeNull();
  const started = await fetch(`${origin}/api/tools`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-earrr-client': '1',
      Authorization: `Bearer ${otherAccess}`,
    },
    body: JSON.stringify({
      callId: crypto.randomUUID(),
      name: 'start_session',
      arguments: { mode: 'solo' },
    }),
  });
  expect(started.ok).toBe(true);
  const hiddenFromOther = await otherClient
    .from('earrr_learning_saves')
    .select('user_id')
    .eq('user_id', users[0]!);
  const hiddenFromOriginal = await publicClient
    .from('earrr_learning_saves')
    .select('user_id')
    .eq('user_id', users[1]!);
  if (hiddenFromOther.error || hiddenFromOriginal.error)
    throw hiddenFromOther.error ?? hiddenFromOriginal.error;
  expect(hiddenFromOther.data).toEqual([]);
  expect(hiddenFromOriginal.data).toEqual([]);
  const directWrite = await otherClient
    .from('earrr_learning_saves')
    .update({ payload: 'untrusted' })
    .eq('user_id', users[1]!);
  expect(directWrite.error).not.toBeNull();
  console.log('PASS separate accounts cannot see or directly write unrelated learning saves');

  const sibling = await context!.newPage();
  sibling.on('pageerror', (error) => failures.push(error.message));
  await sibling.goto(origin);
  await expect(
    sibling.getByRole('button', { name: 'Practice offline', exact: true }),
  ).toBeVisible();
  await expect(player(sibling)).toHaveCount(0);

  await page.getByRole('button', { name: /^Account menu/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log In', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Practice offline', exact: true })).toBeVisible();
  await expect(player(page)).toHaveCount(0);
  await expect(player(sibling)).toHaveCount(0);
  await expect(
    sibling.getByRole('button', { name: 'Practice offline', exact: true }),
  ).toBeVisible();
  await sibling.close();
  console.log('PASS signing out in both tabs starts a fresh guest, without transferred data');
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('form', { name: 'Welcome back.', exact: true })
    .getByRole('button', { name: 'Log In', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Practice offline', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(player(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible();
  console.log('PASS verified email/password login restores the existing cloud account');

  await page.getByRole('button', { name: /^Account menu/ }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await screen(page, 'recovery-mobile');
  let recoveryCode = '';
  await page.route('**/auth/v1/recover*', async (route) => {
    const input = route.request().postDataJSON();
    const generated = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: input.email,
    });
    if (generated.error) throw generated.error;
    recoveryCode = generated.data.properties.email_otp;
    await route.fulfill({ json: {} });
  });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send reset code', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Enter your reset code.', exact: true }),
  ).toBeVisible();
  expect(recoveryCode).toHaveLength(6);
  await page.getByLabel('Email code', { exact: true }).fill(recoveryCode);
  await page.getByRole('button', { name: 'Verify code', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Choose a new password.', exact: true }),
  ).toBeVisible();
  await screen(page, 'new-password-mobile');
  const newPassword = `Earrr-${crypto.randomUUID()}`;
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Save new password', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Practice offline', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(player(page)).toHaveCount(0);
  const recoveredLogin = await otherClient.auth.signInWithPassword({
    email,
    password: newPassword,
  });
  if (recoveredLogin.error) throw recoveredLogin.error;
  expect(recoveredLogin.data.user?.id).toBe(users[0]);
  console.log('PASS actual recovery codes change the password and preserve cloud progress');
  expect(failures).toEqual([]);
} finally {
  try {
    if (context) await close();
    const removed = await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
    if (removed.some((result) => result.error))
      throw new Error('An isolated verification account could not be removed.');
  } finally {
    await stopServer();
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

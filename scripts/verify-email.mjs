import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, expect } from '@playwright/test';

loadEnvFile('.env');
const recipient = 'delivered@resend.dev';
const fixture = crypto.randomUUID();
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const started = Date.now();
let userId;
let browser;

async function resend(path) {
  const response = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Mail inspection failed (${response.status}).`);
  return response.json();
}

async function delivered(subject) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = await resend('/emails?limit=20');
    const item = list.data.find(
      (email) =>
        email.to.includes(recipient) &&
        email.subject === subject &&
        Date.parse(email.created_at) >= started - 1000,
    );
    if (item) {
      const email = await resend(`/emails/${item.id}`);
      assert.match(email.from, /hello@earrr\.app/i);
      if (email.last_event === 'delivered') {
        assert.equal(typeof email.html, 'string');
        assert.ok(!email.html.includes('{{ .Token }}'));
        const token = /letter-spacing:\s*8px[^>]*>\s*(\d{6})\s*</.exec(email.html)?.[1];
        assert.ok(token, 'The delivered template did not contain a rendered verification code.');
        return { email, token };
      }
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error('The SMTP email did not reach the Resend simulated-delivery state.');
}

async function render(name, html, token) {
  for (const width of [640, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    try {
      await page.setContent(html.replaceAll(token, '123456'), { waitUntil: 'networkidle' });
      await expect(page.getByRole('img', { name: 'Earrr', exact: true })).toBeVisible();
      await expect
        .poll(() => page.locator('img').evaluate((image) => image.naturalWidth))
        .toBeGreaterThan(0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: `test-results\\smtp-${name}-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    } finally {
      await page.close();
    }
  }
}

try {
  const existing = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (existing.error) throw existing.error;
  assert.ok(
    !existing.data.users.some((user) => user.email?.toLowerCase() === recipient),
    'The test recipient already owns an account; no existing account will be changed.',
  );
  const signup = await client.auth.signUp({
    email: recipient,
    password: `Earrr-${crypto.randomUUID()}`,
    options: {
      data: { first_name: 'Email', last_name: 'Verification', earrr_smtp_fixture: fixture },
    },
  });
  if (signup.error) throw signup.error;
  assert.ok(signup.data.user);
  userId = signup.data.user.id;
  const confirmation = await delivered('Your Earrr verification code');
  const verified = await client.auth.verifyOtp({
    email: recipient,
    token: confirmation.token,
    type: 'signup',
  });
  if (verified.error) throw verified.error;
  assert.ok(verified.data.session);
  const recovery = await client.auth.resetPasswordForEmail(recipient, {
    redirectTo: 'https://earrr.app/auth/callback',
  });
  if (recovery.error) throw recovery.error;
  const reset = await delivered('Your Earrr password reset code');
  const checked = await client.auth.verifyOtp({
    email: recipient,
    token: reset.token,
    type: 'recovery',
  });
  if (checked.error) throw checked.error;
  assert.ok(checked.data.session);
  mkdirSync('test-results', { recursive: true });
  browser = await chromium.launch({ headless: true });
  await render('confirmation', confirmation.email.html, confirmation.token);
  await render('recovery', reset.email.html, reset.token);
  console.log(
    JSON.stringify({
      sender: 'hello@earrr.app',
      smtpTransport: 'Supabase to Resend',
      recipientKind: 'Resend simulated delivery, not a human inbox',
      confirmation: { id: confirmation.email.id, delivered: true, actualCodeVerified: true },
      recovery: { id: reset.email.id, delivered: true, actualCodeVerified: true },
      renderedWidths: [640, 390],
    }),
  );
} finally {
  await browser?.close();
  if (userId) {
    const owned = await admin.auth.admin.getUserById(userId);
    if (owned.error) throw owned.error;
    assert.equal(owned.data.user.user_metadata.earrr_smtp_fixture, fixture);
    const removed = await admin.auth.admin.deleteUser(userId);
    if (removed.error) throw removed.error;
  }
}

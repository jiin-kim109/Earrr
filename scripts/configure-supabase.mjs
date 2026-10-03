import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { loadEnvFile } from 'node:process';
import { createClient } from '@supabase/supabase-js';

const project = 'smxezziivohyldytykzv';
const cli = process.env.SUPABASE_CLI ?? 'supabase';
let keys;
try {
  keys = JSON.parse(
    execFileSync(cli, ['projects', 'api-keys', '--project-ref', project, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch {
  throw new Error('The signed-in CLI could not retrieve this project’s keys.');
}
const publicKey =
  keys.find((key) => key.type === 'publishable')?.api_key ??
  keys.find((key) => key.name === 'anon')?.api_key;
const serviceKey = keys.find((key) => key.name === 'service_role')?.api_key;
if (!publicKey || !serviceKey)
  throw new Error('The project keys required for Auth/storage are not available.');

const environment = resolve('.env');
let source = existsSync(environment) ? readFileSync(environment, 'utf8') : '';
const assign = (name, value) => {
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  const line = `${name}=${value}`;
  source = pattern.test(source)
    ? source.replace(pattern, () => line)
    : `${source.replace(/\s*$/, '')}\n${line}\n`;
};
assign('SUPABASE_URL', `https://${project}.supabase.co`);
assign('SUPABASE_PUBLISHABLE_KEY', publicKey);
assign('SUPABASE_SERVICE_ROLE_KEY', serviceKey);
assign('SUPABASE_PROJECT_REF', project);
assign('SUPABASE_DB_HOST', `db.${project}.supabase.co`);
assign('SUPABASE_DB_PORT', '5432');
assign('SUPABASE_DB_NAME', 'postgres');
assign('SUPABASE_DB_USER', 'postgres');
assign('SUPABASE_POOLER_HOST', 'aws-0-us-west-1.pooler.supabase.com');
assign('SUPABASE_POOLER_USER', `postgres.${project}`);
if (!/^LEARNING_SAVE_KEY=.+$/m.test(source))
  assign('LEARNING_SAVE_KEY', randomBytes(32).toString('base64'));
writeFileSync(environment, source);

let managementToken = process.env.SUPABASE_ACCESS_TOKEN;
if (!managementToken) {
  const { Entry } = await import('@napi-rs/keyring');
  for (const name of ['access-token', 'supabase', 'default']) {
    try {
      const value = new Entry('Supabase CLI', name).getPassword();
      if (value) {
        managementToken = value.startsWith('go-keyring-base64:')
          ? Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
          : value;
        break;
      }
    } catch {
      /* The CLI supports absent credential entries before its file fallback. */
    }
  }
}
if (!managementToken && process.platform === 'win32') {
  const source = `
import ctypes, ctypes.wintypes as w, re, sys, base64
class Credential(ctypes.Structure):
  _fields_=[('Flags',w.DWORD),('Type',w.DWORD),('TargetName',w.LPWSTR),('Comment',w.LPWSTR),('LastWritten',w.FILETIME),('CredentialBlobSize',w.DWORD),('CredentialBlob',ctypes.POINTER(w.BYTE)),('Persist',w.DWORD),('AttributeCount',w.DWORD),('Attributes',ctypes.c_void_p),('TargetAlias',w.LPWSTR),('UserName',w.LPWSTR)]
item=ctypes.POINTER(Credential)()
read=ctypes.windll.advapi32.CredReadW
read.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.POINTER(ctypes.POINTER(Credential))]
if not read('Supabase CLI:supabase',1,0,ctypes.byref(item)): sys.exit(2)
try:
  value=ctypes.string_at(item.contents.CredentialBlob,item.contents.CredentialBlobSize).decode('utf-8').strip()
  if value.startswith('go-keyring-base64:'): value=base64.b64decode(value.split(':',1)[1]).decode()
  if not re.fullmatch(r'sbp_(?:oauth_|v0_)?[a-f0-9]{40}',value): sys.exit(3)
  sys.stdout.write(value)
finally: ctypes.windll.advapi32.CredFree(item)
`;
  try {
    managementToken = execFileSync('python', ['-c', source], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    managementToken = undefined;
  }
}
if (!managementToken) {
  const path = resolve(
    process.env.SUPABASE_HOME ?? resolve(homedir(), '.supabase'),
    'access-token',
  );
  if (existsSync(path)) managementToken = readFileSync(path, 'utf8').trim();
}
if (!managementToken)
  throw new Error(
    'Project keys were saved privately, but the CLI management credential could not be loaded for Auth configuration.',
  );
const response = await fetch(`https://api.supabase.com/v1/projects/${project}/config/auth`, {
  headers: { Authorization: `Bearer ${managementToken}` },
});
if (!response.ok)
  throw new Error(`Project Auth configuration could not be inspected (${response.status}).`);
const auth = await response.json();
console.log(
  JSON.stringify({
    project,
    keysSavedPrivately: true,
    emailEnabled: auth.external_email_enabled,
    confirmationRequired: !auth.mailer_autoconfirm,
    customSmtpConfigured: Boolean(auth.smtp_host),
    googleEnabled: Boolean(auth.external_google_enabled),
    signupDisabled: Boolean(auth.disable_signup),
    captchaEnabled: Boolean(auth.captcha_enabled),
  }),
);
if (process.argv.includes('--apply-email')) {
  loadEnvFile('.env');
  const argument = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const requestedDomain = argument('--domain');
  if (!requestedDomain) throw new Error('Specify the verified sending domain with --domain.');
  const resend = process.env.RESEND_API_KEY;
  if (!resend) throw new Error('RESEND_API_KEY must be configured before applying email settings.');
  const domainsResponse = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${resend}` },
  });
  if (!domainsResponse.ok)
    throw new Error(`Sending domain lookup failed (${domainsResponse.status}).`);
  const domains = await domainsResponse.json();
  const domain = domains.data.find(
    (item) => item.name === requestedDomain && item.status === 'verified',
  );
  if (!domain) throw new Error('A verified Resend sending domain is required.');
  const sender = argument('--sender') || `hello@${domain.name}`;
  if (sender.split('@').at(-1)?.toLowerCase() !== domain.name.toLowerCase())
    throw new Error('The sender must belong to the explicitly selected verified domain.');
  const origin = new URL(argument('--origin') || `https://${requestedDomain}`);
  if (
    origin.protocol !== 'https:' ||
    origin.hostname !== requestedDomain ||
    origin.pathname !== '/'
  )
    throw new Error('The public origin must be the selected HTTPS domain without a path.');
  assign('RESEND_FROM_EMAIL', sender);
  writeFileSync(environment, source);
  const storage = createClient(`https://${project}.supabase.co`, serviceKey, {
    auth: { persistSession: false },
  }).storage;
  const buckets = await storage.listBuckets();
  if (buckets.error) throw new Error('Email branding storage could not be inspected.');
  if (!buckets.data.some((bucket) => bucket.id === 'earrr-brand')) {
    const created = await storage.createBucket('earrr-brand', {
      public: true,
      allowedMimeTypes: ['image/png'],
      fileSizeLimit: 1_000_000,
    });
    if (created.error) throw new Error('Email branding storage could not be created.');
  }
  const uploaded = await storage
    .from('earrr-brand')
    .upload(
      'wordmark.png',
      readFileSync(resolve('frontend', 'public', 'brand', 'earrr-wordmark-512.png')),
      { contentType: 'image/png', upsert: true },
    );
  if (uploaded.error) throw new Error('Email branding could not be uploaded.');
  const allow = new Set(
    String(auth.uri_allow_list ?? '')
      .split(',')
      .filter(Boolean),
  );
  allow.add('http://127.0.0.1:3000/**');
  allow.add('http://localhost:3000/**');
  allow.add(`${origin.origin}/**`);
  const settings = {
    external_email_enabled: true,
    site_url: origin.origin,
    mailer_autoconfirm: false,
    mailer_otp_length: 6,
    smtp_host: 'smtp.resend.com',
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_pass: resend,
    smtp_admin_email: sender,
    smtp_sender_name: 'Earrr',
    rate_limit_email_sent: 30,
    password_min_length: 8,
    uri_allow_list: [...allow].join(','),
    mailer_subjects_confirmation: 'Your Earrr verification code',
    mailer_templates_confirmation_content: readFileSync(
      resolve('supabase', 'templates', 'confirmation.html'),
      'utf8',
    ),
    mailer_subjects_recovery: 'Your Earrr password reset code',
    mailer_templates_recovery_content: readFileSync(
      resolve('supabase', 'templates', 'recovery.html'),
      'utf8',
    ),
  };
  const updated = await fetch(`https://api.supabase.com/v1/projects/${project}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${managementToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!updated.ok)
    throw new Error(`Earrr email configuration could not be updated (${updated.status}).`);
  const checked = await updated.json();
  console.log(
    JSON.stringify({
      emailConfigured: true,
      sender,
      senderName: checked.smtp_sender_name,
      confirmationRequired: !checked.mailer_autoconfirm,
      otpLength: checked.mailer_otp_length,
      templatesUseCodes: checked.mailer_templates_confirmation_content?.includes('{{ .Token }}'),
    }),
  );
}

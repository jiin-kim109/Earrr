import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { azure, isMain, readConfig, run } from './lib.mjs';

const runtimeEnvironmentNames = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_REALTIME_DEPLOYMENT',
  'AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_GOOGLE_ENABLED',
  'LEARNING_SAVE_KEY',
];

export function loadRuntimeEnvironment(file) {
  // The file, not a stale shell override, owns the existing encryption key.
  for (const name of runtimeEnvironmentNames) delete process.env[name];
  loadEnvFile(file);
  return Object.fromEntries(
    runtimeEnvironmentNames
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

export function runtimeSettings(config, env) {
  for (const name of [
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_REALTIME_DEPLOYMENT',
    'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'LEARNING_SAVE_KEY',
  ]) {
    if (!env[name]?.trim()) throw new Error(`The private operator environment is missing ${name}.`);
  }
  if (Buffer.from(env.LEARNING_SAVE_KEY, 'base64').length !== 32)
    throw new Error('LEARNING_SAVE_KEY must retain its existing base64-encoded 32-byte value.');
  return {
    NODE_ENV: 'production',
    PORT: '8080',
    EARRR_LISTEN_HOST: '0.0.0.0',
    PUBLIC_ORIGIN: config.publicOrigin,
    EARRR_ALLOWED_ORIGINS: config.allowedOrigins.join(','),
    AZURE_OPENAI_ENDPOINT: env.AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_REALTIME_DEPLOYMENT: env.AZURE_OPENAI_REALTIME_DEPLOYMENT,
    AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT ?? '',
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_GOOGLE_ENABLED: env.SUPABASE_GOOGLE_ENABLED === 'true' ? 'true' : 'false',
    SCM_DO_BUILD_DURING_DEPLOY: 'false',
    ENABLE_ORYX_BUILD: 'false',
    WEBSITE_RUN_FROM_PACKAGE: '1',
    ...Object.fromEntries(
      Object.entries(config.secrets).map(([name, secretName]) => [
        name,
        `@Microsoft.KeyVault(SecretUri=${config.keyVault.uri}secrets/${secretName})`,
      ]),
    ),
  };
}

export function syncRuntime(config, env) {
  const settings = runtimeSettings(config, env);
  const directory = mkdtempSync(join(tmpdir(), 'earrr-keyvault-'));
  const files = [];
  try {
    if (process.platform === 'win32') {
      const identity = run('whoami', [], { capture: true }).trim();
      run('icacls', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], {
        capture: true,
      });
    } else run('chmod', ['700', directory], { capture: true });
    for (const [name, secretName] of Object.entries(config.secrets)) {
      const file = join(directory, `${secretName}.txt`);
      files.push(file);
      writeFileSync(file, env[name], { mode: 0o600 });
      azure(
        config,
        [
          'keyvault',
          'secret',
          'set',
          '--vault-name',
          config.keyVault.name,
          '--name',
          secretName,
          '--file',
          file,
          '--encoding',
          'utf-8',
          '--content-type',
          'text/plain',
          '--output',
          'none',
        ],
        { sensitive: true },
      );
      const restored = JSON.parse(
        azure(
          config,
          [
            'keyvault',
            'secret',
            'show',
            '--vault-name',
            config.keyVault.name,
            '--name',
            secretName,
            '--query',
            'value',
            '--output',
            'json',
          ],
          { sensitive: true },
        ),
      );
      const expected = Buffer.from(env[name], 'utf8');
      const actual = Buffer.from(restored, 'utf8');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new Error(
          `${name} was not preserved exactly; application settings were not updated.`,
        );
      console.log(`Preserved and verified ${name} in Key Vault.`);
    }
    const settingsFile = join(directory, 'app-settings.json');
    files.push(settingsFile);
    writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    azure(
      config,
      [
        'webapp',
        'config',
        'appsettings',
        'set',
        '--resource-group',
        config.resourceGroup,
        '--name',
        config.webapp.name,
        '--settings',
        `@${settingsFile}`,
        '--output',
        'none',
      ],
      { sensitive: true },
    );
    console.log(
      'Applied public runtime configuration and three Key Vault references; no management credentials uploaded.',
    );
  } finally {
    for (const file of files) {
      try {
        unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    rmdirSync(directory);
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { env: { type: 'string', default: '.env' } },
    strict: true,
  });
  const file = resolve(values.env);
  syncRuntime(readConfig(), loadRuntimeEnvironment(file));
}

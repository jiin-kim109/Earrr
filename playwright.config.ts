import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const port = Number(process.env.EARRR_E2E_PORT ?? 3101);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('EARRR_E2E_PORT must be a valid TCP port.');
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: join('tests', 'e2e'),
  outputDir: join('test-results', 'browser'),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: origin,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      process.env.EARRR_E2E_DEV === '1'
        ? `node --import tsx "${join('server', 'main.ts')}"`
        : `node "${process.env.EARRR_E2E_SERVER_ENTRY ?? join('dist', 'server', 'main.js')}"`,
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(port),
      NODE_ENV: 'test',
      EARRR_LISTEN_HOST: '127.0.0.1',
      PUBLIC_ORIGIN: '',
      EARRR_ALLOWED_ORIGINS: '',
      RELEASE_ID: '',
      COMMIT_SHA: '',
      DATABASE_PATH: ':memory:',
      DATABASE_URL: '',
      SUPABASE_URL: '',
      EARRR_LEGACY_STORAGE: '1',
      AZURE_OPENAI_API_KEY: '',
      AZURE_OPENAI_ENDPOINT: '',
    },
  },
});

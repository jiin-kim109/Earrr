import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { loadConfig } from './config/environment.js';
import { createApp } from './app.js';
import { Store } from './db/database.js';
import { WorkspaceDirectory } from './services/storage/workspace.js';
import { defaultSettings } from './repositories/user.repository.js';

import express from 'express';

if (existsSync('.env')) loadEnvFile('.env');
const production = import.meta.url.includes('/dist/server/');
const releaseEnvironment: NodeJS.ProcessEnv = {};
const releaseFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'release.json');
if (production && existsSync(releaseFile)) {
  const release: unknown = JSON.parse(readFileSync(releaseFile, 'utf8'));
  if (
    !release ||
    typeof release !== 'object' ||
    !('releaseId' in release) ||
    typeof release.releaseId !== 'string' ||
    !('commitSha' in release) ||
    typeof release.commitSha !== 'string'
  )
    throw new Error('The packaged release metadata is invalid.');
  releaseEnvironment.RELEASE_ID = release.releaseId;
  releaseEnvironment.COMMIT_SHA = release.commitSha;
}
const config = loadConfig({ ...process.env, ...releaseEnvironment });
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor! < 22 || (nodeMajor === 22 && nodeMinor! < 19))
  throw new Error('Earrr requires Node.js 22.19 or newer, including built-in node:sqlite.');
if (production && !config.supabaseUrl && process.env.EARRR_LEGACY_STORAGE !== '1')
  throw new Error(
    'Configure Supabase and LEARNING_SAVE_KEY before starting the production app. EARRR_LEGACY_STORAGE=1 is only for isolated single-user test storage.',
  );
const storage = config.supabaseUrl
  ? new WorkspaceDirectory(config)
  : await Store.open(config.databaseUrl ?? config.databasePath);
const { app } =
  storage instanceof Store ? await createApp(config, storage) : await createApp(config, storage);
const http = createServer(app);
const entrySettings = `<script id="earrr-entry-settings" type="application/json">${JSON.stringify({
  instrument: defaultSettings.instrument,
  volume: defaultSettings.volume,
})}</script>`;
const withEntrySettings = (html: string) => html.replace('</head>', `${entrySettings}</head>`);

if (production) {
  const client = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'client');
  let html = readFileSync(resolve(client, 'index.html'), 'utf8');
  if (config.publicOrigin) {
    html = html
      .replaceAll('content="/brand/', `content="${config.publicOrigin}/brand/`)
      .replace(
        '</head>',
        `<link rel="canonical" href="${config.publicOrigin}/"><meta property="og:url" content="${config.publicOrigin}/"></head>`,
      );
  }
  app.use(express.static(client, { dotfiles: 'deny', index: false }));
  app.get('/{*path}', (_req, res) => res.type('html').send(withEntrySettings(html)));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    plugins: [{ name: 'earrr-entry-settings', transformIndexHtml: withEntrySettings }],
    server: {
      middlewareMode: true,
      ws: { server: http },
      allowedHosts: ['localhost', '127.0.0.1'],
    },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const listenHost = config.listenHost ?? '127.0.0.1';
http.listen(config.port, listenHost, () => {
  console.log(`Earrr is listening at http://${listenHost}:${config.port}`);
  console.log(
    `Storage: ${storage instanceof WorkspaceDirectory ? 'browser guest / Supabase account' : storage.db.kind === 'sqlite' ? config.databasePath : 'PostgreSQL configured'}`,
  );
  console.log(
    `Coach: ${config.configured ? `${config.deployment} configured` : 'not configured; add server credentials to .env'}. Learning state uses the configured workspace storage.`,
  );
});
http.on('error', async (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${config.port} is in use. Change PORT in .env, then restart.`
      : `The server could not start: ${error.message}`,
  );
  await storage.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () =>
    http.close(async () => {
      await storage.close();
      process.exit(0);
    }),
  );
}

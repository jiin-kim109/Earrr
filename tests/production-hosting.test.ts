import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config/environment.js';
import { ownOriginApiOnly } from '../server/middleware.js';
import { requestErrors } from '../server/errors/handler.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/db/database.js';

const publicEnvironment = {
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://earrr.app',
  EARRR_ALLOWED_ORIGINS: 'https://www.earrr.app,https://earrr-test.azurewebsites.net',
};

function api(environment: NodeJS.ProcessEnv = {}) {
  const config = loadConfig(environment);
  const app = express();
  app.use('/api', ownOriginApiOnly(config));
  app.all('/api/example', (_req, res) => res.json({ ok: true }));
  app.use(requestErrors(config));
  return app;
}

describe('configured production hosting', () => {
  it('keeps local listeners private and honors the platform port in production', () => {
    expect(loadConfig({}).listenHost).toBe('127.0.0.1');
    expect(loadConfig({ EARRR_LISTEN_HOST: '' }).listenHost).toBe('127.0.0.1');
    const config = loadConfig({ ...publicEnvironment, PORT: '8080' });
    expect(config.port).toBe(8080);
    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.allowedOrigins).toEqual([
      'https://earrr.app',
      'https://www.earrr.app',
      'https://earrr-test.azurewebsites.net',
    ]);
    expect(loadConfig({ EARRR_LISTEN_HOST: '127.0.0.1' }).listenHost).toBe('127.0.0.1');
    expect(() => loadConfig({ EARRR_LISTEN_HOST: 'arbitrary.example' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/requires PUBLIC_ORIGIN/);
  });

  it.each([
    'http://earrr.app',
    'https://earrr.app/path',
    'https://earrr.app?extra=1',
    'https://earrr.app#extra',
    'https://user:password@earrr.app',
    'https://*.earrr.app',
    'https://earrr.app,',
  ])('rejects unsafe or malformed configured public origins: %s', (origin) => {
    expect(() => loadConfig({ ...publicEnvironment, EARRR_ALLOWED_ORIGINS: origin })).toThrow();
  });

  it.each(['earrr.app', 'www.earrr.app', 'earrr-test.azurewebsites.net'])(
    'accepts only same-origin requests for the configured host %s',
    async (host) => {
      const app = api(publicEnvironment);
      await request(app).get('/api/example').set('Host', host).expect(200);
      await request(app)
        .post('/api/example')
        .set('Host', host)
        .set('Origin', `https://${host}`)
        .set('x-earrr-client', '1')
        .expect(200);
      await request(app).post('/api/example').set('Host', host).expect(403);
      await request(app)
        .post('/api/example')
        .set('Host', host)
        .set('Origin', 'https://evil.example')
        .set('x-earrr-client', '1')
        .expect(403);
    },
  );

  it.each([
    'evil.example',
    'earrr.app.evil.example',
    'www.earrr.app.evil.example',
    'other.azurewebsites.net',
    'earrr.app:444',
    'localhost',
    '127.0.0.1',
  ])('does not allow unconfigured public hosts or proxy overrides: %s', async (host) => {
    await request(api(publicEnvironment))
      .get('/api/example')
      .set('Host', host)
      .set('X-Forwarded-Host', 'earrr.app')
      .set('X-Forwarded-Proto', 'https')
      .expect(403);
  });

  it('does not treat two owned domains as the same browser origin', async () => {
    const result = await request(api(publicEnvironment))
      .get('/api/example')
      .set('Host', 'earrr.app')
      .set('Origin', 'https://earrr-test.azurewebsites.net')
      .expect(403);
    expect(result.body.error.code).toBe('cross_origin');
    await request(api(publicEnvironment))
      .get('/api/example')
      .set('Host', 'www.earrr.app')
      .set('Origin', 'https://earrr.app')
      .expect(403);
    await request(api(publicEnvironment))
      .get('/api/example')
      .set('Host', 'earrr.app')
      .set('Origin', 'https://www.earrr.app')
      .expect(403);
    await request(api(publicEnvironment))
      .get('/api/example')
      .set('Host', 'earrr.app')
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-Host', 'evil.example')
      .set('X-Forwarded-Proto', 'https')
      .expect(403);
  });

  it('preserves local own-origin and marked-mutation protections', async () => {
    const app = api();
    await request(app)
      .post('/api/example')
      .set('Host', '127.0.0.1:3000')
      .set('Origin', 'http://127.0.0.1:3000')
      .set('x-earrr-client', '1')
      .expect(200);
    await request(app).get('/api/example').set('Host', 'localhost:3000').expect(200);
    await request(app)
      .get('/api/example')
      .set('Host', 'localhost:3000')
      .set('Origin', 'http://localhost:3001')
      .expect(403);
    await request(app)
      .post('/api/example')
      .set('Host', '127.0.0.1:3000')
      .set('Origin', 'null')
      .set('x-earrr-client', '1')
      .expect(403);
    await request(api({ PUBLIC_ORIGIN: 'https://earrr.app' }))
      .get('/api/example')
      .set('Host', '127.0.0.1:3000')
      .set('Origin', 'http://127.0.0.1:3000')
      .expect(200);
  });

  it('fails explicitly rather than sending unresolved Key Vault references to providers', () => {
    expect(() =>
      loadConfig({ AZURE_OPENAI_API_KEY: '@Microsoft.KeyVault(VaultName=example;SecretName=key)' }),
    ).toThrow(/unresolved Key Vault reference/);
  });

  it('validates matching non-secret release identifiers', () => {
    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    expect(
      loadConfig({ RELEASE_ID: '20261003T010203Z-01234567', COMMIT_SHA: commitSha }),
    ).toMatchObject({ releaseId: '20261003T010203Z-01234567', commitSha });
    expect(() => loadConfig({ RELEASE_ID: 'v1.0.0', COMMIT_SHA: commitSha })).toThrow();
    expect(() => loadConfig({ COMMIT_SHA: commitSha })).toThrow(/same packaged commit/);
    expect(() =>
      loadConfig({ RELEASE_ID: '20261003T010203Z-deadbeef', COMMIT_SHA: commitSha }),
    ).toThrow(/same packaged commit/);
  });
});

describe('public health metadata', () => {
  let store: Store | undefined;
  afterEach(async () => store?.close());

  it('reports the immutable release and runtime without private credentials', async () => {
    const config = loadConfig({
      ...publicEnvironment,
      AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
      AZURE_OPENAI_API_KEY: 'fixture-private-key',
      RELEASE_ID: '20261003T010203Z-01234567',
      COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    });
    store = await Store.open(':memory:');
    const { app } = await createApp(config, store);
    const result = await request(app).get('/api/health').set('Host', 'earrr.app').expect(200);
    expect(result.body).toEqual({
      ok: true,
      configured: true,
      deployment: config.deployment,
      releaseId: config.releaseId,
      commitSha: config.commitSha,
      nodeVersion: process.versions.node,
    });
    expect(JSON.stringify(result.body)).not.toContain(config.apiKey);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-robots-tag']).toBe('noindex');
  });
});

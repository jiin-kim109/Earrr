import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertEnvironment,
  assertDeploymentAuthorized,
  assertIsolatedOutput,
  assertPackageTree,
  assertSourceCommit,
  assertUnreleased,
  healthMatches,
  projectRoot,
  readConfig,
  readMetadata,
  referenceStatuses,
  releaseFor,
  runtimeManifest,
  verifyArtifact,
  verifyHealth,
  verifyPublicSite,
} from '../lib.mjs';
import { loadRuntimeEnvironment, runtimeSettings } from '../sync-runtime.mjs';
import { copyRuntimeBuild } from '../package.mjs';
import { deploy } from '../deploy.mjs';
import { publishRelease } from '../release.mjs';

const commitSha = '0123456789abcdef0123456789abcdef01234567';
const release = releaseFor(commitSha, new Date('2026-10-03T01:02:03.456Z'));
const config = readConfig();
const metadata = {
  schemaVersion: 1,
  ...release,
  buildPlatform: 'linux',
  artifactSha256: 'a'.repeat(64),
};
const healthy = {
  ok: true,
  configured: true,
  deployment: 'fixture-realtime',
  releaseId: release.releaseId,
  commitSha,
  nodeVersion: '22.19.0',
};

test('release identifiers are UTC date plus sha8, never semantic versions', () => {
  assert.equal(release.releaseId, '20261003T010203Z-01234567');
  assert.throws(() => releaseFor('deadbeef'), /40-character/);
  assert.throws(() => releaseFor(commitSha, new Date('invalid')), /timestamp/);
});

test('production cannot overwrite the running local dist', () => {
  assert.throws(() => assertIsolatedOutput(projectRoot), /separate build/);
  assert.throws(() => assertIsolatedOutput(join(projectRoot, 'dist')), /separate build/);
  assert.throws(() => assertIsolatedOutput(join(projectRoot, 'dist', 'client')), /separate build/);
});

test('deployment authorization fails closed until the user chooses an eligible purpose and subscription', () => {
  const paused = {
    ...config,
    deploymentAuthorization: { status: 'paused', explicitUserApproval: false },
  };
  assert.throws(
    () => assertDeploymentAuthorized(paused, {}),
    /paused pending explicit user approval/,
  );
  assert.throws(
    () => assertDeploymentAuthorized(paused, { AZURE_DEPLOYMENT_AUTHORIZED: 'true' }),
    /paused pending explicit user approval/,
  );
  const approved = {
    ...config,
    deploymentAuthorization: {
      status: 'approved',
      explicitUserApproval: true,
      purpose: 'production',
      subscriptionId: config.subscriptionId,
    },
  };
  assert.throws(
    () => assertDeploymentAuthorized(approved, {}),
    /explicitly acknowledge the subscription guidance/,
  );
  const acknowledged = {
    ...approved,
    deploymentAuthorization: {
      ...approved.deploymentAuthorization,
      productionUseAcknowledged: true,
    },
  };
  assert.deepEqual(
    assertDeploymentAuthorized(acknowledged, {}),
    acknowledged.deploymentAuthorization,
  );
  const eligible = {
    ...approved,
    subscriptionAssessment: { productionEligible: true },
  };
  assert.deepEqual(assertDeploymentAuthorized(eligible, {}), eligible.deploymentAuthorization);
  assert.throws(
    () => assertDeploymentAuthorized(eligible, { GITHUB_ACTIONS: 'true' }),
    /authorization switch is disabled/,
  );
  assertDeploymentAuthorized(eligible, {
    GITHUB_ACTIONS: 'true',
    AZURE_DEPLOYMENT_AUTHORIZED: 'true',
  });
  assert.throws(
    () =>
      assertDeploymentAuthorized(
        {
          ...eligible,
          deploymentAuthorization: {
            ...eligible.deploymentAuthorization,
            subscriptionId: 'unapproved-target',
          },
        },
        {},
      ),
    /paused pending explicit user approval/,
  );
  const demo = {
    ...approved,
    deploymentAuthorization: {
      ...approved.deploymentAuthorization,
      purpose: 'dev-test-demo',
    },
  };
  assert.equal(assertDeploymentAuthorized(demo, {}).purpose, 'dev-test-demo');
});

test('paused manual deployment and release stop before reading artifacts or calling providers', async () => {
  const paused = {
    ...config,
    deploymentAuthorization: { status: 'paused', explicitUserApproval: false },
  };
  await assert.rejects(
    deploy(paused, { artifact: 'missing.zip', metadataFile: 'missing.json' }),
    /paused pending explicit user approval/,
  );
  await assert.rejects(
    publishRelease(paused, { artifact: 'missing.zip', metadataFile: 'missing.json', metadata }),
    /paused pending explicit user approval/,
  );
});

test('an artifact cannot claim a different commit or uncommitted source changes', () => {
  assertSourceCommit(commitSha, (_command, args) =>
    args.includes('rev-parse') ? `${commitSha}\n` : '',
  );
  assert.throws(
    () => assertSourceCommit(commitSha, () => 'f'.repeat(40)),
    /checked-out source commit/,
  );
  assert.throws(
    () =>
      assertSourceCommit(commitSha, (_command, args) =>
        args.includes('rev-parse') ? commitSha : ' M server/main.ts',
      ),
    /Commit all/,
  );
});

test('the runtime package has no development or provider-management scripts', () => {
  const manifest = runtimeManifest({
    name: 'earrr',
    version: '0.2.0',
    dependencies: { express: 'fixture' },
    devDependencies: { '@napi-rs/keyring': 'fixture' },
    scripts: {
      'test:auth': 'operator-script',
      build: 'development-script',
      'configure:dns': 'node deploy/provider-management.mjs',
      'configure:supabase': 'node scripts/configure-supabase.mjs',
    },
    engines: { node: '>=22.19.0' },
  });
  assert.deepEqual(manifest.scripts, { start: 'node dist/server/main.js' });
  assert.equal(manifest.devDependencies, undefined);
});

test('metadata and immutable ZIP digests are verified before deployment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'earrr-delivery-test-'));
  try {
    const zip = join(directory, 'app.zip');
    const file = join(directory, 'release.json');
    writeFileSync(zip, 'fixture artifact');
    const digest = createHash('sha256').update('fixture artifact').digest('hex');
    writeFileSync(file, JSON.stringify({ ...metadata, artifactSha256: digest }));
    const parsed = readMetadata(file, commitSha);
    assert.equal(verifyArtifact(zip, parsed), digest);
    assert.throws(() => readMetadata(file, 'f'.repeat(40)), /checked-out/);
    writeFileSync(zip, 'changed artifact');
    assert.throws(() => verifyArtifact(zip, parsed), /checksum/);
    writeFileSync(file, JSON.stringify({ ...metadata, buildPlatform: 'win32' }));
    assert.throws(() => readMetadata(file, commitSha), /Linux artifact/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the package allowlist refuses secrets, state and operator files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'earrr-package-test-'));
  try {
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'package.json'), '{}');
    assertPackageTree(directory);
    writeFileSync(join(directory, 'dist', '.env'), 'fixture, not a key');
    assert.throws(() => assertPackageTree(directory), /Private\/operator/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime staging excludes current and future deploy/scripts provider helpers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'earrr-provider-exclusion-test-'));
  const source = join(directory, 'source');
  const stage = join(directory, 'stage');
  try {
    for (const name of ['client', 'server', 'shared', 'prompts']) {
      const runtime = join(source, 'dist', name);
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, 'runtime.js'), 'fixture runtime');
      writeFileSync(join(runtime, 'runtime.js.map'), 'fixture source map');
    }
    for (const path of [
      join(source, 'deploy'),
      join(source, 'scripts'),
      join(source, 'dist', 'deploy'),
      join(source, 'dist', 'scripts'),
    ]) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'provider-management.mjs'), 'fixture operator helper');
    }
    writeFileSync(join(source, 'scripts', 'configure-supabase.mjs'), 'fixture SMTP helper');
    copyRuntimeBuild(join(source, 'dist'), stage);
    assert.deepEqual(readdirSync(stage), ['dist']);
    assert.deepEqual(readdirSync(join(stage, 'dist')).sort(), [
      'client',
      'prompts',
      'server',
      'shared',
    ]);
    assert.ok(existsSync(join(stage, 'dist', 'server', 'runtime.js')));
    assert.equal(existsSync(join(stage, 'dist', 'server', 'runtime.js.map')), false);
    assert.equal(existsSync(join(stage, 'deploy')), false);
    assert.equal(existsSync(join(stage, 'scripts')), false);
    assert.equal(existsSync(join(stage, 'dist', 'deploy')), false);
    assert.equal(existsSync(join(stage, 'dist', 'scripts')), false);
    assertPackageTree(stage);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package validation rejects provider folders if a future packaging change includes them', () => {
  for (const folder of ['deploy', 'scripts', join('dist', 'deploy'), join('dist', 'scripts')]) {
    const directory = mkdtempSync(join(tmpdir(), 'earrr-provider-guard-test-'));
    try {
      mkdirSync(join(directory, 'dist'));
      mkdirSync(join(directory, folder), { recursive: true });
      writeFileSync(join(directory, folder, 'provider-management.mjs'), 'fixture operator helper');
      assert.throws(
        () => assertPackageTree(directory),
        /Unexpected (?:deployment root|runtime build) entry/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('runtime settings contain only public configuration and vault references', () => {
  const key = Buffer.alloc(32, 9).toString('base64');
  const settings = runtimeSettings(config, {
    AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com',
    AZURE_OPENAI_API_KEY: 'fixture-private-azure',
    AZURE_OPENAI_REALTIME_DEPLOYMENT: 'fixture-realtime',
    AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT: 'fixture-whisper',
    SUPABASE_URL: 'https://fixture.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'fixture-public-publishable',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-private-supabase',
    LEARNING_SAVE_KEY: key,
    RESEND_API_KEY: 'fixture-provider-management-key',
    SUPABASE_ACCESS_TOKEN: 'fixture-provider-management-token',
    AZURE_OPENAI_SUMMARY_API_KEY: 'fixture-unused-summary-key',
  });
  const serialized = JSON.stringify(settings);
  for (const value of [
    'fixture-private-azure',
    'fixture-private-supabase',
    key,
    'fixture-provider-management-key',
    'fixture-provider-management-token',
    'fixture-unused-summary-key',
  ])
    assert.ok(!serialized.includes(value));
  assert.equal(settings.PUBLIC_ORIGIN, 'https://earrr.app');
  assert.equal(settings.SUPABASE_GOOGLE_ENABLED, 'false');
  assert.match(settings.LEARNING_SAVE_KEY, /@Microsoft\.KeyVault\(SecretUri=/);
  assert.throws(() => runtimeSettings(config, {}), /missing AZURE_OPENAI_ENDPOINT/);
});

test('dotenv loading preserves the file save key rather than a stale shell override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'earrr-env-test-'));
  const previous = { ...process.env };
  const file = join(directory, '.env');
  const key = Buffer.alloc(32, 7).toString('base64');
  try {
    writeFileSync(file, `LEARNING_SAVE_KEY=${key}\nRESEND_API_KEY=fixture-operator-only\n`);
    process.env.LEARNING_SAVE_KEY = 'stale-shell-value';
    const environment = loadRuntimeEnvironment(file);
    assert.equal(environment.LEARNING_SAVE_KEY, key);
    assert.equal(environment.RESEND_API_KEY, undefined);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in previous)) delete process.env[name];
    }
    Object.assign(process.env, previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deployment cannot silently point at another subscription, app or branch', () => {
  assertEnvironment(config, {});
  assert.throws(
    () => assertEnvironment(config, { AZURE_SUBSCRIPTION_ID: 'wrong' }),
    /does not match/,
  );
  assert.throws(
    () => assertEnvironment(config, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature' }),
    /restricted to main/,
  );
  assert.throws(
    () =>
      assertEnvironment(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'fork/Earrr',
      }),
    /owned repository/,
  );
});

test('actual ARM reference collections must resolve through the owned system identity and secrets', () => {
  const collection = {
    value: Object.entries(config.secrets).map(([name, secretName]) => ({
      name,
      properties: {
        status: 'Resolved',
        vaultName: config.keyVault.name,
        secretName,
        identityType: 'SystemAssigned',
      },
    })),
  };
  assert.deepEqual(referenceStatuses(config, collection), {
    AZURE_OPENAI_API_KEY: 'Resolved',
    SUPABASE_SERVICE_ROLE_KEY: 'Resolved',
    LEARNING_SAVE_KEY: 'Resolved',
  });
  assert.throws(() => referenceStatuses(config, { properties: {} }), /ARM resource collection/);
  for (const patch of [
    { status: 'AccessToKeyVaultDenied' },
    { vaultName: 'unowned-vault' },
    { secretName: 'unowned-secret' },
    { identityType: 'UserAssigned' },
  ]) {
    const invalid = structuredClone(collection);
    Object.assign(invalid.value[0].properties, patch);
    assert.throws(() => referenceStatuses(config, invalid), /not resolved/);
  }
});

test('health requires the exact artifact commit and a supported runtime, without extra fields', () => {
  assert.equal(healthMatches(healthy, metadata), true);
  for (const body of [
    { ...healthy, configured: false },
    { ...healthy, commitSha: 'f'.repeat(40) },
    { ...healthy, releaseId: '20261003T010204Z-01234567' },
    { ...healthy, nodeVersion: '22.18.0' },
    { ...healthy, privateKey: 'fixture' },
  ])
    assert.equal(healthMatches(body, metadata), false);
});

test('a stale health response is bounded and never treated as deployment success', async () => {
  let requests = 0;
  await assert.rejects(
    verifyHealth(config, metadata, {
      attempts: 2,
      pauseMs: 0,
      logger: () => {},
      fetcher: async () => {
        requests++;
        return Response.json({ ...healthy, releaseId: 'old-release' });
      },
    }),
    /No release published/,
  );
  assert.equal(requests, 2);
  const result = await verifyHealth(config, metadata, {
    attempts: 1,
    fetcher: async () => Response.json(healthy),
  });
  assert.deepEqual(result, healthy);
});

test('first-deploy health and client checks use only the owned Azure default URL', async () => {
  const requests = [];
  const result = await verifyPublicSite(config, metadata, {
    attempts: 1,
    fetcher: async (url, init) => {
      requests.push(url);
      assert.equal(new URL(url).origin, config.webapp.defaultUrl);
      assert.equal(init.redirect, 'manual');
      if (init.headers?.Origin || init.method === 'POST')
        return new Response(null, { status: 403 });
      const path = new URL(url).pathname;
      if (path === '/api/health') return Response.json(healthy);
      if (path === '/')
        return new Response(
          `<link rel="canonical" href="${config.publicOrigin}/"><script id="earrr-entry-settings"></script>`,
          { headers: { 'Content-Type': 'text/html' } },
        );
      if (path === '/brand/earrr-mark.svg')
        return new Response('<svg></svg>', {
          headers: { 'Content-Type': 'image/svg+xml' },
        });
      if (path === '/api/config')
        return Response.json({
          auth: {
            enabled: true,
            guestStorage: true,
            publishableKey: 'fixture-public-publishable',
            url: 'https://fixture.supabase.co',
          },
        });
      throw new Error('An unexpected validation endpoint was requested.');
    },
  });
  assert.deepEqual(result, healthy);
  assert.equal(requests.length, 6);
  assert.ok(requests.every((url) => !url.startsWith(config.publicOrigin)));
});

test('health redirects cannot silently move the gate to an unready canonical certificate', async () => {
  const requests = [];
  await assert.rejects(
    verifyHealth(config, metadata, {
      attempts: 1,
      logger: () => {},
      fetcher: async (url, init) => {
        requests.push(url);
        assert.equal(init.redirect, 'manual');
        return new Response(null, {
          status: 302,
          headers: { Location: `${config.publicOrigin}/api/health` },
        });
      },
    }),
    /HTTP 302/,
  );
  assert.deepEqual(requests, [`${config.webapp.defaultUrl}/api/health`]);
});

test('already successful release tags cannot be deployed again with a reused identifier', async () => {
  await assertUnreleased(config, metadata, async () => new Response(null, { status: 404 }));
  await assert.rejects(
    assertUnreleased(config, metadata, async () => Response.json({ ref: 'fixture' })),
    /already exists/,
  );
  await assert.rejects(
    assertUnreleased(config, metadata, async () => new Response(null, { status: 403 })),
    /GitHub HTTP 403/,
  );
});

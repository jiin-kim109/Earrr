import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const configFile = join(projectRoot, 'deploy', 'config.json');

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && fileURLToPath(metaUrl) === resolve(process.argv[1]);
}

export function run(command, args, options = {}) {
  const { cwd = projectRoot, sensitive = false, capture = false, env = process.env } = options;
  let executable = command;
  let arguments_ = args;
  if (process.platform === 'win32' && ['az', 'gh', 'npm'].includes(command)) {
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    executable = 'powershell.exe';
    arguments_ = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `& ${quote(command)} @(${args.map(quote).join(',')}); exit $LASTEXITCODE`,
    ];
  }
  const result = spawnSync(executable, arguments_, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: sensitive || capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error)
    throw new Error(`${command} could not start: ${result.error.code ?? 'unknown error'}`);
  if (result.status !== 0) {
    if (!sensitive && capture && result.stderr) process.stderr.write(result.stderr);
    const category =
      sensitive && /Forbidden|AuthorizationFailed|AccessDenied/i.test(result.stderr ?? '')
        ? '; authorization denied'
        : '';
    throw new Error(`${command} failed (exit ${result.status ?? 'unknown'}${category}).`);
  }
  return result.stdout ?? '';
}

export function readConfig(path = configFile) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (
    config.schemaVersion !== 1 ||
    config.repository !== 'jiin-kim109/Earrr' ||
    !config.subscriptionId ||
    !config.tenantId ||
    !config.webapp?.id ||
    !config.webapp?.defaultUrl ||
    !config.keyVault?.id ||
    !config.deploymentIdentity?.clientId
  )
    throw new Error('The hosting deployment configuration is invalid.');
  const url = new URL(config.webapp.defaultUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== config.webapp.defaultHostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('The configured Azure verification URL is invalid.');
  return config;
}

export function azure(config, args, options = {}) {
  return run('az', [...args, '--subscription', config.subscriptionId], options);
}

export function assertEnvironment(config, env = process.env) {
  for (const [name, expected] of Object.entries({
    AZURE_SUBSCRIPTION_ID: config.subscriptionId,
    AZURE_TENANT_ID: config.tenantId,
    AZURE_CLIENT_ID: config.deploymentIdentity.clientId,
    AZURE_RESOURCE_GROUP: config.resourceGroup,
    AZURE_WEBAPP_NAME: config.webapp.name,
    AZURE_WEBAPP_URL: config.webapp.defaultUrl,
  })) {
    if (env[name] && env[name] !== expected)
      throw new Error(`${name} does not match the owned hosting deployment configuration.`);
  }
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Production deployment is restricted to main.');
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY !== config.repository)
    throw new Error('Production deployment is restricted to the owned repository.');
}

export function assertDeploymentAuthorized(config, env = process.env) {
  const authorization = config.deploymentAuthorization;
  if (
    authorization?.status !== 'approved' ||
    authorization.explicitUserApproval !== true ||
    authorization.subscriptionId !== config.subscriptionId ||
    !['production', 'dev-test-demo'].includes(authorization.purpose)
  )
    throw new Error(
      'Deployment/publication is paused pending explicit user approval of a production-capable subscription or temporary dev/test demo.',
    );
  if (
    authorization.purpose === 'production' &&
    config.subscriptionAssessment?.productionEligible !== true &&
    authorization.productionUseAcknowledged !== true
  )
    throw new Error(
      'Production target approval must explicitly acknowledge the subscription guidance when eligibility has not been independently verified.',
    );
  if (env.GITHUB_ACTIONS === 'true' && env.AZURE_DEPLOYMENT_AUTHORIZED !== 'true')
    throw new Error('The repository deployment authorization switch is disabled.');
  return authorization;
}

export function referenceStatuses(config, collection) {
  if (!Array.isArray(collection.value))
    throw new Error('The Key Vault reference endpoint did not return an ARM resource collection.');
  const references = new Map(
    collection.value.map((entry) => {
      if (typeof entry.name !== 'string' || !entry.properties)
        throw new Error('The Key Vault reference collection contains an invalid entry.');
      return [entry.name, entry.properties];
    }),
  );
  if (references.size !== collection.value.length)
    throw new Error('The Key Vault reference collection contains duplicate settings.');
  const statuses = {};
  for (const [name, secretName] of Object.entries(config.secrets)) {
    const reference = references.get(name);
    statuses[name] = reference?.status ?? 'Missing';
    if (
      reference?.status !== 'Resolved' ||
      reference.vaultName !== config.keyVault.name ||
      reference.secretName !== secretName ||
      reference.identityType !== 'SystemAssigned'
    )
      throw new Error(
        `Key Vault reference ${name} is not resolved through the owned system identity/secret (${statuses[name]}).`,
      );
  }
  return statuses;
}

export function releaseFor(commitSha, now = new Date()) {
  if (!/^[a-f0-9]{40}$/.test(commitSha))
    throw new Error('Packaging requires a full, lowercase 40-character Git commit SHA.');
  if (!Number.isFinite(now.getTime())) throw new Error('The release timestamp is invalid.');
  const timestamp = now.toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 15);
  return {
    releaseId: `${timestamp}Z-${commitSha.slice(0, 8)}`,
    commitSha,
    createdAt: now.toISOString(),
  };
}

export function assertSourceCommit(commitSha, runner = run) {
  const head = runner('git', ['--no-pager', 'rev-parse', '--verify', 'HEAD'], {
    capture: true,
  }).trim();
  if (head !== commitSha)
    throw new Error('The requested artifact commit is not the checked-out source commit.');
  const changes = runner(
    'git',
    [
      '--no-pager',
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--',
      'server',
      'shared',
      'frontend',
      'prompts',
      'scripts',
      'tests',
      'deploy',
      '.github',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.server.json',
      'vite.config.ts',
      'playwright.config.ts',
    ],
    { capture: true },
  ).trim();
  if (changes)
    throw new Error(
      'Commit all runtime/build/test/workflow source changes before creating a production artifact.',
    );
}

export function readMetadata(path, expectedCommit = process.env.GITHUB_SHA) {
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  if (
    metadata.schemaVersion !== 1 ||
    !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(metadata.releaseId ?? '') ||
    !/^[a-f0-9]{40}$/.test(metadata.commitSha ?? '') ||
    !metadata.releaseId.endsWith(`-${metadata.commitSha.slice(0, 8)}`) ||
    !/^[a-f0-9]{64}$/.test(metadata.artifactSha256 ?? '') ||
    metadata.buildPlatform !== 'linux'
  )
    throw new Error('The Linux artifact metadata is invalid.');
  if (expectedCommit && metadata.commitSha !== expectedCommit)
    throw new Error('The artifact commit differs from the checked-out CI commit.');
  return metadata;
}

export function verifyArtifact(path, metadata) {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== metadata.artifactSha256)
    throw new Error('The immutable deployment ZIP checksum does not match its metadata.');
  return digest;
}

export function runtimeManifest(source) {
  return {
    name: source.name,
    version: source.version,
    private: true,
    type: 'module',
    engines: source.engines,
    scripts: { start: 'node dist/server/main.js' },
    dependencies: source.dependencies,
  };
}

export const runtimeBuildDirectories = Object.freeze(['client', 'server', 'shared', 'prompts']);

export function assertIsolatedOutput(path) {
  const output = resolve(path);
  const liveDist = resolve(projectRoot, 'dist');
  const relation = relative(liveDist, output);
  if (
    output === projectRoot ||
    output === liveDist ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  )
    throw new Error('Use a separate build directory, never the running app or its dist directory.');
  if (existsSync(output) && readdirSync(output).length !== 0)
    throw new Error('The isolated build directory must be new or empty.');
  return output;
}

export function assertPackageTree(root) {
  const allowed = new Set(['dist', 'node_modules', 'package.json', 'package-lock.json']);
  for (const name of readdirSync(root)) {
    if (!allowed.has(name)) throw new Error(`Unexpected deployment root entry: ${name}`);
  }
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        /^\.env(?:\.|$)/i.test(entry.name) ||
        ['.npmrc', '.git', '.azure', '.supabase'].includes(entry.name)
      )
        throw new Error(`Private/operator files are forbidden in deployment: ${entry.name}`);
      if (entry.isSymbolicLink()) {
        const target = resolve(path, '..', readlinkSync(path));
        const linkRelation = relative(root, target);
        if (
          linkRelation.startsWith(`..${sep}`) ||
          linkRelation === '..' ||
          isAbsolute(linkRelation)
        )
          throw new Error('A deployment symlink points outside its immutable package.');
      } else if (entry.isDirectory()) inspect(path);
      else if (!lstatSync(path).isFile())
        throw new Error('Only regular files, directories and internal symlinks may be packaged.');
    }
  }
  inspect(root);
  const dist = join(root, 'dist');
  if (existsSync(dist)) {
    const allowedBuildEntries = new Set([...runtimeBuildDirectories, 'release.json']);
    for (const name of readdirSync(dist)) {
      if (!allowedBuildEntries.has(name))
        throw new Error(`Unexpected runtime build entry: ${name}`);
    }
  }
}

export async function assertUnreleased(config, metadata, fetcher = fetch) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetcher(
    `https://api.github.com/repos/${config.repository}/git/ref/tags/${metadata.releaseId}`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (response.status === 404) return;
  if (response.ok)
    throw new Error(
      'This successful release tag already exists. Run fresh CI to create a new release.',
    );
  throw new Error(`Could not check the production release tag (GitHub HTTP ${response.status}).`);
}

function nodeCompatible(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) return false;
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export function healthMatches(body, metadata) {
  return (
    body !== null &&
    typeof body === 'object' &&
    Object.keys(body).every((key) =>
      ['ok', 'configured', 'deployment', 'releaseId', 'commitSha', 'nodeVersion'].includes(key),
    ) &&
    body.ok === true &&
    body.configured === true &&
    typeof body.deployment === 'string' &&
    body.deployment.length > 0 &&
    body.releaseId === metadata.releaseId &&
    body.commitSha === metadata.commitSha &&
    nodeCompatible(body.nodeVersion)
  );
}

export async function verifyHealth(
  config,
  metadata,
  { fetcher = fetch, attempts = 36, pauseMs = 10_000, logger = console.error } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error('Health verification requires at least one bounded attempt.');
  let failure = 'no response';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(`${config.webapp.defaultUrl}/api/health`, {
        headers: { 'Cache-Control': 'no-cache' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) failure = `HTTP ${response.status}`;
      else {
        const body = await response.json();
        if (healthMatches(body, metadata)) return body;
        failure = 'release, commit, configured state or supported Node runtime does not match';
      }
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !(error instanceof SyntaxError) &&
        !(error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
      )
        throw error;
      failure = `${error.name} while requesting a JSON health response`;
    }
    logger(`Production health attempt ${attempt}/${attempts}: ${failure}.`);
    if (attempt < attempts) await delay(pauseMs);
  }
  throw new Error(
    `Production health failed for ${metadata.releaseId}: ${failure}. No release published.`,
  );
}

export async function verifyPublicSite(config, metadata, options = {}) {
  const health = await verifyHealth(config, metadata, options);
  const fetcher = options.fetcher ?? fetch;
  const request = (path, init = {}) =>
    fetcher(`${config.webapp.defaultUrl}${path}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  const [entry, mark, auth, foreignOrigin, unmarkedMutation] = await Promise.all([
    request('/'),
    request('/brand/earrr-mark.svg'),
    request('/api/config'),
    request('/api/health', { headers: { Origin: 'https://example.invalid' } }),
    request('/api/config', { method: 'POST' }),
  ]);
  if (!entry.ok || !entry.headers.get('content-type')?.includes('text/html'))
    throw new Error('The deployed client entry did not return HTML.');
  const html = await entry.text();
  if (
    !html.includes('earrr-entry-settings') ||
    !html.includes(`rel="canonical" href="${config.publicOrigin}/"`)
  )
    throw new Error('The deployed HTML is missing its public bootstrap or canonical origin.');
  if (!mark.ok || !mark.headers.get('content-type')?.includes('image/svg+xml'))
    throw new Error('The deployed original brand asset is unavailable.');
  if (!auth.ok) throw new Error(`Public auth bootstrap failed (HTTP ${auth.status}).`);
  const bootstrap = await auth.json();
  if (
    bootstrap.auth?.enabled !== true ||
    bootstrap.auth?.guestStorage !== true ||
    typeof bootstrap.auth?.publishableKey !== 'string' ||
    bootstrap.auth.publishableKey.length < 10 ||
    typeof bootstrap.auth?.url !== 'string' ||
    !bootstrap.auth.url.startsWith('https://')
  )
    throw new Error('The deployed Supabase/browser-guest runtime bootstrap is not configured.');
  if (foreignOrigin.status !== 403 || unmarkedMutation.status !== 403)
    throw new Error(
      'The deployed API did not preserve its own-origin and client-header protections.',
    );
  return health;
}

import { resolve } from 'node:path';
import { z } from 'zod';

export interface Config {
  port: number;
  listenHost?: '127.0.0.1' | '0.0.0.0';
  databasePath: string;
  databaseUrl?: string;
  publicOrigin?: string;
  allowedOrigins?: readonly string[];
  releaseId?: string;
  commitSha?: string;
  azureEndpoint: string;
  apiKey: string;
  deployment: string;
  transcriptionDeployment: string;
  configured: boolean;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  supabaseServiceKey?: string;
  learningSaveKey?: string;
  googleEnabled?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(env.PORT ?? 3000);
  const listenHost = z
    .enum(['127.0.0.1', '0.0.0.0'])
    .parse(
      env.EARRR_LISTEN_HOST?.trim() || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    );
  const releaseId = env.RELEASE_ID?.trim() || undefined;
  const commitSha = env.COMMIT_SHA?.trim() || undefined;
  if (releaseId)
    z.string()
      .regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/)
      .parse(releaseId);
  if (commitSha)
    z.string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(commitSha);
  if (
    Boolean(releaseId) !== Boolean(commitSha) ||
    (releaseId && commitSha && !releaseId.endsWith(`-${commitSha.slice(0, 8)}`))
  )
    throw new Error('RELEASE_ID and COMMIT_SHA must identify the same packaged commit.');
  for (const name of [
    'AZURE_OPENAI_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'LEARNING_SAVE_KEY',
  ] as const) {
    if (env[name]?.startsWith('@Microsoft.KeyVault('))
      throw new Error(`${name} has an unresolved Key Vault reference.`);
  }
  const endpoint = (env.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/+$/, '');
  const apiKey = env.AZURE_OPENAI_API_KEY?.trim() ?? '';
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl && !/^postgres(?:ql)?:\/\//.test(databaseUrl))
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  function parseOrigin(value: string, name: string) {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.hostname.includes('*') ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        `${name} must be an HTTP(S) origin without credentials, wildcards or a path; production requires HTTPS.`,
      );
    return parsed.origin;
  }
  const publicOrigin = env.PUBLIC_ORIGIN?.trim()
    ? parseOrigin(env.PUBLIC_ORIGIN.trim(), 'PUBLIC_ORIGIN')
    : undefined;
  const allowedOrigins = [
    ...new Set([
      ...(publicOrigin ? [publicOrigin] : []),
      ...(env.EARRR_ALLOWED_ORIGINS?.trim()
        ? env.EARRR_ALLOWED_ORIGINS.split(',').map((value) =>
            parseOrigin(value.trim(), 'EARRR_ALLOWED_ORIGINS'),
          )
        : []),
    ]),
  ];
  if (env.NODE_ENV === 'production' && allowedOrigins.length === 0)
    throw new Error('Production requires PUBLIC_ORIGIN or EARRR_ALLOWED_ORIGINS.');
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      !['.cognitiveservices.azure.com', '.openai.azure.com', '.services.ai.azure.com'].some(
        (suffix) => url.hostname.endsWith(suffix),
      ) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        'AZURE_OPENAI_ENDPOINT must be the HTTPS base URL of your Azure resource, without a path or credentials.',
      );
    }
  }
  return {
    port,
    listenHost,
    databasePath:
      env.DATABASE_PATH === ':memory:'
        ? ':memory:'
        : resolve(env.DATABASE_PATH ?? 'data', ...(env.DATABASE_PATH ? [] : ['earrr.sqlite'])),
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(allowedOrigins.length ? { allowedOrigins } : {}),
    ...(releaseId ? { releaseId, commitSha } : {}),
    azureEndpoint: endpoint,
    apiKey,
    deployment: env.AZURE_OPENAI_REALTIME_DEPLOYMENT?.trim() || 'gpt-realtime-2.1',
    transcriptionDeployment: env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT?.trim() || '',
    configured: Boolean(endpoint && apiKey),
    ...(env.SUPABASE_URL
      ? {
          supabaseUrl: z.url().parse(env.SUPABASE_URL),
          supabasePublishableKey: z.string().min(10).parse(env.SUPABASE_PUBLISHABLE_KEY),
          supabaseServiceKey: z.string().min(10).parse(env.SUPABASE_SERVICE_ROLE_KEY),
          learningSaveKey: z.string().min(40).parse(env.LEARNING_SAVE_KEY),
          googleEnabled: env.SUPABASE_GOOGLE_ENABLED === 'true',
        }
      : {}),
  };
}

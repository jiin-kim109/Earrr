import { parseArgs } from 'node:util';
import {
  assertUnreleased,
  assertDeploymentAuthorized,
  isMain,
  readConfig,
  readMetadata,
  run,
  verifyArtifact,
  verifyPublicSite,
} from './lib.mjs';

export async function publishRelease(config, { artifact, metadataFile, metadata }) {
  const authorization = assertDeploymentAuthorized(config);
  verifyArtifact(artifact, metadata);
  await verifyPublicSite(config, metadata, { attempts: 3 });
  await assertUnreleased(config, metadata);
  run('gh', [
    'release',
    'create',
    metadata.releaseId,
    artifact,
    metadataFile,
    '--repo',
    config.repository,
    '--target',
    metadata.commitSha,
    '--title',
    metadata.releaseId,
    '--notes',
    [
      `Verified Earrr ${authorization.purpose === 'production' ? 'production' : 'temporary dev/test demo'} deployment: ${metadata.releaseId}`,
      `Commit: ${metadata.commitSha}`,
      `Artifact SHA-256: ${metadata.artifactSha256}`,
      `Azure validation URL: ${config.webapp.defaultUrl}`,
      `Canonical origin: ${config.publicOrigin}`,
      'Release created only after successful application health, client/bootstrap and own-origin checks.',
    ].join('\n'),
  ]);
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { artifact: { type: 'string' }, metadata: { type: 'string' } },
    strict: true,
  });
  if (!values.artifact || !values.metadata) throw new Error('Specify --artifact and --metadata.');
  const config = readConfig();
  assertDeploymentAuthorized(config);
  await publishRelease(config, {
    artifact: values.artifact,
    metadataFile: values.metadata,
    metadata: readMetadata(values.metadata),
  });
}

import { parseArgs } from 'node:util';
import {
  assertEnvironment,
  assertDeploymentAuthorized,
  assertUnreleased,
  azure,
  isMain,
  readConfig,
  readMetadata,
  verifyArtifact,
} from './lib.mjs';
import { verifyDeployment, verifyInfrastructure } from './verify.mjs';
import { publishRelease } from './release.mjs';

export async function deploy(config, { artifact, metadataFile, publish = false }) {
  assertDeploymentAuthorized(config);
  assertEnvironment(config);
  const metadata = readMetadata(metadataFile);
  verifyArtifact(artifact, metadata);
  await assertUnreleased(config, metadata);
  verifyInfrastructure(config);
  azure(config, [
    'webapp',
    'deploy',
    '--resource-group',
    config.resourceGroup,
    '--name',
    config.webapp.name,
    '--src-path',
    artifact,
    '--type',
    'zip',
    '--clean',
    'false',
    '--restart',
    'true',
    '--async',
    'false',
    '--track-status',
    'true',
    '--timeout',
    '1200000',
    '--output',
    'none',
  ]);
  const verified = await verifyDeployment(config, metadata);
  console.log(JSON.stringify(verified, null, 2));
  if (publish) await publishRelease(config, { artifact, metadataFile, metadata });
  return metadata;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      artifact: { type: 'string' },
      metadata: { type: 'string' },
      'publish-release': { type: 'boolean' },
    },
    strict: true,
  });
  if (!values.artifact || !values.metadata) throw new Error('Specify --artifact and --metadata.');
  await deploy(readConfig(), {
    artifact: values.artifact,
    metadataFile: values.metadata,
    publish: values['publish-release'] === true,
  });
}

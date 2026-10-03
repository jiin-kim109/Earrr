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

export async function submitAndVerifyDeployment(
  config,
  artifact,
  metadata,
  { runAzure = azure, verify = verifyDeployment } = {},
) {
  const receipt = JSON.parse(
    runAzure(
      config,
      [
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
        'false',
        '--timeout',
        '1200000',
        '--output',
        'json',
      ],
      { capture: true, timeout: 1_260_000 },
    ),
  );
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(receipt.id) ||
    receipt.status !== 4 ||
    receipt.complete === false
  )
    throw new Error('Azure did not return a completed successful Kudu deployment receipt.');
  const verified = await verify(config, metadata);
  return { ...verified, deployment: { id: receipt.id, status: receipt.status } };
}

export async function deploy(config, { artifact, metadataFile, publish = false }) {
  assertDeploymentAuthorized(config);
  assertEnvironment(config);
  const metadata = readMetadata(metadataFile);
  verifyArtifact(artifact, metadata);
  await assertUnreleased(config, metadata);
  verifyInfrastructure(config);
  const verified = await submitAndVerifyDeployment(config, artifact, metadata);
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

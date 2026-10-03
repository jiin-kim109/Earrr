import { parseArgs } from 'node:util';
import {
  assertEnvironment,
  azure,
  isMain,
  readConfig,
  readMetadata,
  referenceStatuses,
  verifyPublicSite,
} from './lib.mjs';

export function verifyInfrastructure(config) {
  assertEnvironment(config);
  const site = JSON.parse(
    azure(
      config,
      [
        'webapp',
        'show',
        '--resource-group',
        config.resourceGroup,
        '--name',
        config.webapp.name,
        '--query',
        '{id:id,state:state,httpsOnly:httpsOnly,defaultHostName:defaultHostName,identity:identity}',
        '--output',
        'json',
      ],
      { capture: true },
    ),
  );
  const settings = JSON.parse(
    azure(
      config,
      [
        'webapp',
        'config',
        'show',
        '--resource-group',
        config.resourceGroup,
        '--name',
        config.webapp.name,
        '--query',
        '{alwaysOn:alwaysOn,linuxFxVersion:linuxFxVersion,appCommandLine:appCommandLine,minTlsVersion:minTlsVersion,scmMinTlsVersion:scmMinTlsVersion,ftpsState:ftpsState,healthCheckPath:healthCheckPath}',
        '--output',
        'json',
      ],
      { capture: true },
    ),
  );
  if (
    site.httpsOnly !== true ||
    site.defaultHostName !== config.webapp.defaultHostname ||
    site.identity?.principalId !== config.webapp.managedIdentityPrincipalId ||
    settings.alwaysOn !== true ||
    settings.linuxFxVersion !== 'NODE|22-lts' ||
    settings.appCommandLine !== 'node dist/server/main.js' ||
    settings.minTlsVersion !== '1.2' ||
    settings.scmMinTlsVersion !== '1.2' ||
    settings.ftpsState !== 'Disabled' ||
    settings.healthCheckPath !== '/api/health'
  )
    throw new Error(
      'The owned App Service hosting/security configuration does not match production.',
    );
  for (const policy of ['ftp', 'scm']) {
    const body = JSON.parse(
      azure(
        config,
        [
          'rest',
          '--method',
          'get',
          '--url',
          `https://management.azure.com${config.webapp.id}/basicPublishingCredentialsPolicies/${policy}?api-version=2024-11-01`,
          '--output',
          'json',
        ],
        { capture: true },
      ),
    );
    if (body.properties?.allow !== false)
      throw new Error(`${policy} basic publishing authentication is not disabled.`);
  }
  const references = JSON.parse(
    azure(
      config,
      [
        'rest',
        '--method',
        'get',
        '--url',
        `https://management.azure.com${config.webapp.id}/config/configreferences/appsettings?api-version=2022-03-01`,
        '--output',
        'json',
      ],
      { sensitive: true },
    ),
  );
  const statuses = referenceStatuses(config, references);
  return {
    webapp: config.webapp.name,
    state: site.state,
    defaultUrl: config.webapp.defaultUrl,
    runtime: settings.linuxFxVersion,
    alwaysOn: settings.alwaysOn,
    httpsOnly: site.httpsOnly,
    basicPublishingAuth: 'disabled',
    keyVaultReferences: statuses,
  };
}

export async function verifyDeployment(config, metadata) {
  const infrastructure = verifyInfrastructure(config);
  const health = await verifyPublicSite(config, metadata);
  return { ...infrastructure, health };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { infrastructure: { type: 'boolean' }, metadata: { type: 'string' } },
    strict: true,
  });
  const config = readConfig();
  if (!values.infrastructure && !values.metadata)
    throw new Error('Specify --infrastructure or --metadata with a Linux artifact release.json.');
  const result = values.infrastructure
    ? verifyInfrastructure(config)
    : await verifyDeployment(config, readMetadata(values.metadata));
  console.log(JSON.stringify(result, null, 2));
}

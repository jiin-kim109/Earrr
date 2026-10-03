import { assertDeploymentAuthorized, assertEnvironment, readConfig } from './lib.mjs';

const config = readConfig();
const authorization = assertDeploymentAuthorized(config);
assertEnvironment(config);
console.log(`Explicit user authorization verified for ${authorization.purpose}.`);

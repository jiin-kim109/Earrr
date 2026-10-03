import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const directory of ['server', 'shared', 'prompts']) {
  rmSync(resolve('dist', directory), { recursive: true, force: true });
}
const result = spawnSync(
  process.execPath,
  [resolve('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.server.json'],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0)
  cpSync(resolve('prompts'), resolve('dist', 'prompts'), { recursive: true });

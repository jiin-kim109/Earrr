import { cpSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertIsolatedOutput, isMain, projectRoot, run } from './lib.mjs';

export function build(outputPath) {
  const output = assertIsolatedOutput(outputPath);
  const dist = join(output, 'dist');
  mkdirSync(output, { recursive: true });
  const tsc = join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '--noEmit']);
  run(process.execPath, [
    join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build',
    '--outDir',
    join(dist, 'client'),
    '--emptyOutDir',
  ]);
  run(process.execPath, [tsc, '-p', join(projectRoot, 'tsconfig.server.json'), '--outDir', dist]);
  cpSync(join(projectRoot, 'prompts'), join(dist, 'prompts'), { recursive: true });
  console.log(`Isolated production build: ${dist}`);
  return dist;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true });
  if (!values.output) throw new Error('Specify --output with a new isolated directory.');
  build(resolve(values.output));
}

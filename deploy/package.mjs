import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  assertPackageTree,
  assertIsolatedOutput,
  assertSourceCommit,
  isMain,
  projectRoot,
  releaseFor,
  run,
  runtimeBuildDirectories,
  runtimeManifest,
} from './lib.mjs';

export function copyRuntimeBuild(dist, stage) {
  for (const name of runtimeBuildDirectories) {
    const source = join(resolve(dist), name);
    if (!existsSync(source)) throw new Error(`The production build is missing dist/${name}.`);
    cpSync(source, join(stage, 'dist', name), {
      recursive: true,
      filter: (path) => !path.endsWith('.map'),
    });
  }
}

export function packageApp({ commit, output, dist = join(projectRoot, 'dist') }) {
  if (process.platform !== 'linux')
    throw new Error(
      'Production ZIPs must install dependencies on Linux. Use the Ubuntu GitHub CI job.',
    );
  const release = releaseFor(commit);
  assertSourceCommit(commit);
  const outputDirectory = assertIsolatedOutput(output);
  mkdirSync(outputDirectory, { recursive: true });
  const archive = join(outputDirectory, 'app.zip');
  const metadataFile = join(outputDirectory, 'release.json');
  if (existsSync(archive) || existsSync(metadataFile))
    throw new Error(
      'Use a new artifact output directory; existing immutable artifacts are not overwritten.',
    );
  run('zip', ['--version'], { capture: true });
  const stage = mkdtempSync(join(outputDirectory, '.earrr-stage-'));
  try {
    copyRuntimeBuild(dist, stage);
    const sourceManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    writeFileSync(
      join(stage, 'package.json'),
      `${JSON.stringify(runtimeManifest(sourceManifest), null, 2)}\n`,
    );
    cpSync(join(projectRoot, 'package-lock.json'), join(stage, 'package-lock.json'));
    writeFileSync(join(stage, 'dist', 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: stage,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'await Promise.all(["express", "@supabase/supabase-js", "nunjucks", "node:sqlite"].map(name => import(name)))',
      ],
      {
        cwd: stage,
      },
    );
    assertPackageTree(stage);
    run(
      'zip',
      ['-q', '-r', '-y', archive, 'dist', 'node_modules', 'package.json', 'package-lock.json'],
      {
        cwd: stage,
      },
    );
    const metadata = {
      schemaVersion: 1,
      ...release,
      buildPlatform: process.platform,
      buildNodeVersion: process.versions.node,
      artifactSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    };
    writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`Packaged ${metadata.releaseId} (${metadata.artifactSha256}).`);
    return metadata;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { commit: { type: 'string' }, output: { type: 'string' }, dist: { type: 'string' } },
    strict: true,
  });
  if (!values.commit || !values.output) throw new Error('Specify --commit and --output.');
  packageApp(values);
}

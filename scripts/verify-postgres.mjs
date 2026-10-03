import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Pool } from 'pg';

const binaryDirectory =
  process.env.PG_BIN ??
  (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\17\\bin' : '');
const binary = (name) =>
  binaryDirectory
    ? join(binaryDirectory, `${name}${process.platform === 'win32' ? '.exe' : ''}`)
    : name;
mkdirSync(resolve('test-results'), { recursive: true });
const directory = mkdtempSync(resolve('test-results', 'postgres-earrr-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((done) => probe.close(done));
let server;
try {
  const init = spawnSync(
    binary('initdb'),
    ['-D', directory, '-U', 'earrr_test', '-A', 'trust', '--encoding=UTF8', '--no-locale'],
    { encoding: 'utf8' },
  );
  if (init.status !== 0)
    throw new Error(
      `Isolated PostgreSQL initialization failed: ${init.error?.message ?? init.stderr}`,
    );
  server = spawn(
    binary('postgres'),
    ['-D', directory, '-h', '127.0.0.1', '-p', String(port), '-c', 'fsync=off'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let output = '';
  server.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const url = `postgresql://earrr_test@127.0.0.1:${port}/postgres`;
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 500 });
  let ready = false;
  for (let count = 0; count < 60; count++) {
    if (server.exitCode !== null) throw new Error(`Isolated PostgreSQL exited: ${output}`);
    try {
      await pool.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  await pool.end();
  if (!ready) throw new Error(`Isolated PostgreSQL was not ready: ${output}`);
  const tests = spawn(
    process.execPath,
    [
      resolve('node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'tests\\storage.test.ts',
      '--reporter=dot',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, EARRR_TEST_POSTGRES_URL: url, EARRR_TEST_POSTGRES_ISOLATED: '1' },
    },
  );
  const [code] = await once(tests, 'exit');
  if (code !== 0) throw new Error(`Storage parity tests failed (${code}).`);
  console.log('PASS shared SQLite/PostgreSQL storage, transactions, checkpoints and concurrency.');
} finally {
  if (server && server.exitCode === null) {
    const result = spawnSync(binary('pg_ctl'), ['-D', directory, 'stop', '-m', 'fast', '-w'], {
      encoding: 'utf8',
    });
    if (result.status !== 0)
      throw new Error(`Could not stop the isolated cluster at ${directory}: ${result.stderr}`);
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}

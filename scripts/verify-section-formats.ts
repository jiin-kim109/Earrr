import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { Store } from '../server/db/database.js';
import { loadConfig } from '../server/config/environment.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { createExercise } from '../server/services/exercise/generator.js';
import { skills } from '../server/services/exercise/catalog.js';
import type { Exercise, ExerciseTarget } from '../server/types/exercise.types.js';
import type { Snapshot, ToolResult } from '../server/types/agent.types.js';
import type { SkillId } from '../shared/types/course.js';
import { audioEvidenceScript } from '../tests/browser-audio.js';
import { verifyLessonNavigation } from './verify-lesson-navigation.js';
import {
  realtimeTraceScript,
  expectOneSpokenReply,
  turnMarker,
} from '../tests/browser-realtime.js';

loadEnvFile('.env');
const config = loadConfig(process.env);
if (!config.configured)
  throw new Error('Native section verification needs configured Azure credentials.');
const serverArg = process.argv.indexOf('--server');
if (serverArg < 0 || !process.argv[serverArg + 1])
  throw new Error('Pass an isolated built server path with --server.');
const serverEntry = resolve(process.argv[serverArg + 1]!);
if (!serverEntry.startsWith(resolve('test-results') + sep))
  throw new Error(
    'Use a built server inside this project test-results directory, not the live server.',
  );
mkdirSync('test-results', { recursive: true });
const directory = mkdtempSync(resolve('test-results', 'section-native-'));
const database = join(directory, 'learning.sqlite');
const origin = 'http://127.0.0.1:3119';
const cases: Array<{
  skill: SkillId;
  target: ExerciseTarget;
  answer: (exercise: Exercise) => string;
  kind: string;
}> = [
  {
    skill: 'progressions',
    target: { format: 'complete', length: 4, gapCount: 2 },
    answer: (exercise) =>
      `I think the missing functions are ${exercise.expected.progression![1]} then ${exercise.expected.progression![2]}.`,
    kind: 'progression',
  },
  {
    skill: 'cadences',
    target: { format: 'complete', length: 3 },
    answer: (exercise) => `The missing function is ${exercise.expected.degree}.`,
    kind: 'progression',
  },
  {
    skill: 'extensions',
    target: { format: 'compare', quality: 'dominant9' },
    answer: () => 'The second chord is a dominant ninth.',
    kind: 'piano',
  },
  {
    skill: 'modes',
    target: { format: 'compare', scale: 'lydian' },
    answer: () => 'The second scale sounds like Lydian.',
    kind: 'scale',
  },
];
let server: ChildProcess | null = null;
let browser: Browser | null = null;
let store: Store | null = null;

try {
  store = await Store.open(database);
  const game = await AgentService.create(store, true, config.deployment);
  for (const skill of skills) {
    await store.progress.completeLesson(skill.id, new Date().toISOString());
    if (skill.id !== 'triads') await store.progress.finishIntroduction(skill.id, 'skipped');
  }
  await store.progress.finishIntroduction('welcome', 'finished');
  const sessionId = (
    await game.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'coach', focus: cases[0]!.skill },
    })
  ).snapshot.session!.id;
  const exercises = new Map<SkillId, Exercise>();
  for (const item of cases) {
    await game.execute({
      callId: randomUUID(),
      sessionId,
      name: 'select_lesson',
      arguments: { skillId: item.skill },
    });
    await game.execute({ callId: randomUUID(), sessionId, name: 'start_practice', arguments: {} });
    const round = (await store.progress.round(item.skill))!;
    const target = { root: 0, ...item.target };
    round.remaining[0]!.target = target;
    await store.progress.saveRound(round);
    const exercise: Exercise = {
      ...createExercise({
        id: randomUUID(),
        seed: 19,
        skillId: item.skill,
        settings: await store.user.getSettings(),
        now: new Date().toISOString(),
        target,
      }),
      roundId: round.id,
      roundTargetId: round.remaining[0]!.id,
    };
    await store.exercises.save(exercise, sessionId);
    await store.sessions.save({
      ...(await store.sessions.get(sessionId))!,
      currentExerciseId: exercise.id,
    });
    exercises.set(item.skill, exercise);
  }
  await game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'select_lesson',
    arguments: { skillId: cases[0]!.skill },
  });
  await store.close();
  store = null;
  server = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: '3119',
      DATABASE_PATH: database,
      DATABASE_URL: '',
      SUPABASE_URL: '',
      PUBLIC_ORIGIN: '',
      NODE_ENV: 'test',
      EARRR_LEGACY_STORAGE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  server.stderr!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`The isolated server stopped: ${output}`);
    try {
      if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })).ok) {
        ready = true;
        break;
      }
    } catch (error) {
      if (attempt === 99) throw error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready) throw new Error('The isolated native server did not start.');
  browser = await chromium.launch({ headless: true });
  for (const item of process.argv.includes('--navigation-only') ? [] : cases) {
    const selected = await fetch(`${origin}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-earrr-client': '1' },
      body: JSON.stringify({
        callId: randomUUID(),
        sessionId,
        name: 'select_lesson',
        arguments: { skillId: item.skill },
      }),
    });
    expect(selected.ok).toBe(true);
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone'],
    });
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await page.addInitScript({ content: audioEvidenceScript + realtimeTraceScript });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Start training', exact: true }).click();
    const player = page.getByRole('region', { name: 'Exercise player', exact: true });
    await expect(player).toHaveAttribute('data-phase', 'listening', { timeout: 60_000 });
    await expect(player.getByTestId('question-diagram')).toBeVisible();
    await expect(player.getByTestId('musical-diagram')).toHaveCount(0);
    const exercise = exercises.get(item.skill)!;
    const marker = await turnMarker(page);
    const response = page.waitForResponse(
      (result) =>
        result.url().endsWith('/api/agent/tools') &&
        result.request().postDataJSON()?.name === 'submit_answer',
      { timeout: 45_000 },
    );
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(item.answer(exercise));
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const scored: ToolResult = await (await response).json();
    expect(scored.grade?.verdict).toBe('correct');
    expect(scored.gradedExerciseId).toBe(exercise.id);
    const figure = player.getByTestId(item.kind === 'piano' ? 'piano-diagram' : 'musical-diagram');
    if (item.kind !== 'piano') await expect(figure).toHaveAttribute('data-diagram-kind', item.kind);
    await expect(figure).toHaveAttribute('data-example-id', exercise.id);
    await expectOneSpokenReply(
      page,
      marker,
      `${item.skill}: natural answer reaches deterministic grading`,
    );
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'earrrAudioEvidence').voicePeak))
      .toBeGreaterThan(0.001);
    await expect(player).toHaveAttribute('data-phase', 'listening', { timeout: 45_000 });
    const state: Snapshot = await (await fetch(`${origin}/api/state`)).json();
    expect(state.course.round.answers).toHaveLength(1);
    expect(state.current?.id).not.toBe(exercise.id);
    if (item.kind === 'progression' || item.kind === 'melody')
      expect(state.current?.question?.kind).toBe('sequence');
    else expect(state.current?.required).toEqual(item.kind === 'scale' ? ['scale'] : ['quality']);
    expect(failures).toEqual([]);
    await page.close();
    console.log(
      `PASS native ${item.skill} format, spoken feedback and next-question handoff; no production progress touched.`,
    );
  }
  await verifyLessonNavigation(browser, origin, sessionId);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise<void>((done) => server!.once('exit', () => done()));
    server.kill('SIGTERM');
    await stopped;
  }
  await store?.close();
  await rm(directory, { recursive: true, force: true });
}

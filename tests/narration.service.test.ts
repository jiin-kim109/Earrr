import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { NarrationService } from '../server/services/narration.service.js';
import { createApp } from '../server/app.js';
import type { ToolResult } from '../server/types/agent.types.js';
import request from 'supertest';

let directory: string;
let store: Store;
let game: AgentService;
let cache: NarrationService;
let welcome: ToolResult;
beforeEach(async () => {
  directory = await mkdtemp(resolve('test-results', 'narration-test-'));
  store = await Store.open(':memory:');
  game = await AgentService.create(store, true, 'test-model');
  const started = await game.execute({
    callId: crypto.randomUUID(),
    name: 'start_session',
    arguments: { mode: 'coach', welcome: true },
  });
  welcome = await game.execute({
    callId: crypto.randomUUID(),
    sessionId: started.snapshot.session!.id,
    name: 'play_exercise',
    arguments: {},
  });
  cache = new NarrationService({ deployment: 'test-model', narrationCachePath: directory });
});
afterEach(async () => {
  await cache.close();
  await store.close();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const pcm = Buffer.alloc(48000, 12).toString('base64');
async function capture(result: ToolResult = welcome) {
  const prepared = await cache.prepare(result);
  const narration = prepared.agent.presentation!.narration!;
  const send = vi.fn();
  const observe = cache.observer(send);
  observe({
    type: 'session.updated',
    session: { model: 'test-model', audio: { output: { speed: narration.speed } } },
  });
  const response = {
    id: 'response',
    status: 'completed',
    metadata: { earrr_narration: narration.key },
    audio: { output: { voice: narration.voice, format: { type: 'audio/pcm', rate: 24000 } } },
    output: [
      {
        id: 'item',
        role: 'assistant',
        type: 'message',
        content: [{ type: 'output_audio', transcript: narration.text }],
      },
    ],
  };
  observe({ type: 'response.created', response });
  observe({ type: 'response.done', response });
  return { narration, send, observe };
}

describe('shared recordings of server-owned narration', () => {
  it('keeps already-open legacy tabs on the original narration protocol', async () => {
    const app = await createApp(
      {
        port: 0,
        databasePath: ':memory:',
        apiKey: 'fixture',
        azureEndpoint: '',
        configured: true,
        deployment: 'test-model',
        transcriptionDeployment: '',
        narrationCachePath: directory,
      },
      store,
    );
    try {
      const body = () => ({
        callId: crypto.randomUUID(),
        sessionId: welcome.snapshot.session!.id,
        name: 'replay_exercise',
        arguments: {},
      });
      const legacy = await request(app.app)
        .post('/api/tools')
        .set('x-earrr-client', '1')
        .send(body())
        .expect(200);
      expect(legacy.body.agent.presentation.narration).toBeUndefined();
      expect(legacy.body.agent.presentation.context.parts[0].kind).toBe('teaching');
      const current = await request(app.app)
        .post('/api/tools')
        .set('x-earrr-client', '1')
        .set('x-earrr-narration', '1')
        .send(body())
        .expect(200);
      expect(current.body.agent.presentation.narration.text).toContain('Welcome to ear training.');
      expect(current.body.agent.presentation.instructions).toContain('quoted script');
    } finally {
      await app.calls.close();
      await app.narration.close();
    }
  });

  it('extracts an exact completed provider recording once and reuses it across workspaces and restarts', async () => {
    const { narration, observe, send } = await capture();
    expect(narration.audio).toBeUndefined();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'conversation.item.retrieve',
      item_id: 'item',
      event_id: 'earrr-cache:item',
    });
    observe({
      type: 'conversation.item.retrieved',
      item: {
        id: 'item',
        role: 'assistant',
        content: [{ type: 'output_audio', transcript: narration.text, audio: pcm }],
      },
    });
    const entry = await cache.get(narration.key);
    expect(entry?.audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(entry?.audio.subarray(44).toString('base64')).toBe(pcm);
    expect(entry?.seconds).toBe(1);
    const differentSession = structuredClone(welcome);
    differentSession.snapshot.session!.id = crypto.randomUUID();
    differentSession.snapshot.totalAnswers = 20;
    const repeated = await cache.prepare(differentSession);
    expect(repeated.agent.presentation?.narration?.audio?.url).toBe(
      `/api/narration/${narration.key}`,
    );
    expect(repeated.snapshot).toEqual(differentSession.snapshot);
    await cache.close();
    const fresh = new NarrationService({ deployment: 'test-model', narrationCachePath: directory });
    expect((await fresh.get(narration.key))?.audio).toEqual(entry?.audio);
    await fresh.close();
  });

  it('never extracts unknown, cancelled, wrong-voice, wrong-speed or altered-script responses', async () => {
    const prepared = await cache.prepare(welcome);
    const narration = prepared.agent.presentation!.narration!;
    for (const mismatch of ['unknown', 'cancelled', 'voice', 'speed', 'script', 'format']) {
      const send = vi.fn();
      const observe = cache.observer(send);
      observe({
        type: 'session.updated',
        session: {
          model: 'test-model',
          audio: { output: { speed: mismatch === 'speed' ? 0.9 : 1.2 } },
        },
      });
      const response = {
        id: mismatch,
        status: mismatch === 'cancelled' ? 'cancelled' : 'completed',
        metadata: { earrr_narration: mismatch === 'unknown' ? 'b'.repeat(64) : narration.key },
        audio: {
          output: {
            voice: mismatch === 'voice' ? 'ash' : 'sage',
            format: { type: 'audio/pcm', rate: mismatch === 'format' ? 16000 : 24000 },
          },
        },
        output: [
          {
            id: 'item',
            role: 'assistant',
            type: 'message',
            content: [
              {
                type: 'output_audio',
                transcript:
                  mismatch === 'script'
                    ? `${narration.text} Private user content.`
                    : narration.text,
              },
            ],
          },
        ],
      };
      observe({ type: 'response.created', response });
      observe({ type: 'response.done', response });
      expect(send, mismatch).not.toHaveBeenCalled();
    }
    expect(await cache.get(narration.key)).toBeNull();
  });

  it('rejects a truncated or unsolicited retrieval instead of caching an incomplete explanation', async () => {
    const { narration, observe } = await capture();
    for (const [id, transcript] of [
      ['unsolicited', narration.text],
      ['item', narration.text.slice(0, 35)],
    ]) {
      observe({
        type: 'conversation.item.retrieved',
        item: {
          id,
          role: 'assistant',
          content: [{ type: 'output_audio', transcript, audio: pcm }],
        },
      });
    }
    expect(await cache.get(narration.key)).toBeNull();
  });

  it('separates voice and speed variants and does not change model-facing grading or UI state', async () => {
    const first = await cache.prepare(welcome);
    const before = structuredClone(welcome);
    const changed = structuredClone(welcome);
    changed.snapshot.settings.voiceSpeed = 1.35;
    const faster = await cache.prepare(changed);
    changed.snapshot.settings.voice = 'ash';
    const otherVoice = await cache.prepare(changed);
    expect(
      new Set(
        [first, faster, otherVoice].map((result) => result.agent.presentation!.narration!.key),
      ).size,
    ).toBe(3);
    expect(first.agent.context).toEqual(welcome.agent.context);
    expect(welcome).toEqual(before);
    expect(await cache.prepare(welcome, 'review_answer')).toBe(welcome);
    expect(await cache.prepare(welcome, 'inspect_progress')).toBe(welcome);
  });

  it('treats a corrupted persisted clip or inaccessible storage as an optional cache miss', async () => {
    const { narration, observe } = await capture();
    observe({
      type: 'conversation.item.retrieved',
      item: {
        id: 'item',
        role: 'assistant',
        content: [{ type: 'output_audio', transcript: narration.text, audio: pcm }],
      },
    });
    await cache.close();
    const file = join(directory, `${narration.key}.json`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...saved, text: 'Not the approved narration.' }));
    const fresh = new NarrationService({ deployment: 'test-model', narrationCachePath: directory });
    expect(await fresh.get(narration.key)).toBeNull();
    await writeFile(
      file,
      JSON.stringify({ ...saved, pcm: Buffer.alloc(48000, 13).toString('base64') }),
    );
    expect(await fresh.get(narration.key)).toBeNull();
    expect(await fresh.get('..\\outside')).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unavailable = new NarrationService({
      deployment: 'test-model',
      narrationCachePath: file,
    });
    expect(
      (await unavailable.prepare(welcome)).agent.presentation?.narration?.audio,
    ).toBeUndefined();
  });
});

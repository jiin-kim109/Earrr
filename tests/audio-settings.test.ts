import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { settingsSchema } from '../shared/schemas/user.js';

describe('one speaker volume and two sampled instruments', () => {
  it('rejects removed sound options and preserves zero as a master volume', async () => {
    const store = await Store.open(':memory:');
    try {
      expect(Object.keys(await store.user.getSettings()).sort()).toEqual([
        'instrument',
        'timezone',
        'voice',
        'volume',
      ]);
      for (const instrument of ['sine', 'felt', 'electric'])
        expect(
          settingsSchema.safeParse({ ...(await store.user.getSettings()), instrument }).success,
        ).toBe(false);
      expect(
        settingsSchema.safeParse({ ...(await store.user.getSettings()), autoAdvance: false })
          .success,
      ).toBe(false);
      await store.user.saveSettings({ ...(await store.user.getSettings()), volume: 0 });
      expect((await store.user.getSettings()).volume).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('changes the instrument without changing the current pitches or ground truth', async () => {
    const store = await Store.open(':memory:');
    try {
      const agent = await AgentService.create(store, false, 'test');
      const sessionId = (
        await agent.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!.id;
      const first = await agent.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      const expected = (await store.exercises.get(first.snapshot.current!.id))!.expected;
      await store.user.saveSettings({ ...(await store.user.getSettings()), instrument: 'guitar' });
      const replay = await agent.execute({
        callId: randomUUID(),
        sessionId,
        name: 'replay_exercise',
        arguments: {},
      });
      expect(replay.audio?.instrument).toBe('guitar');
      expect(replay.audio?.events).toEqual(first.audio?.events);
      expect(replay.snapshot.current?.id).toBe(first.snapshot.current?.id);
      expect((await store.exercises.get(first.snapshot.current!.id))?.expected).toEqual(expected);
    } finally {
      await store.close();
    }
  });

  it('migrates legacy audio settings while preserving an active question and rewards', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'audio-settings-'));
    const path = join(directory, 'practice.sqlite');
    let store = await Store.open(path);
    try {
      let agent = await AgentService.create(store, false, 'test');
      const sessionId = (
        await agent.execute({
          callId: randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        })
      ).snapshot.session!.id;
      const result = await agent.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      await store.db.prepare('UPDATE settings SET data = ?').run(
        JSON.stringify({
          instrument: 'electric',
          varyTimbre: true,
          voiceVolume: 0.45,
          musicVolume: 0.1,
          autoAdvance: false,
          inputMode: 'text',
          dailyGoal: 12,
          voice: 'sage',
          timezone: 'UTC',
          defaultFocus: 'pitch-direction',
        }),
      );
      await store.db
        .prepare("UPDATE exercises SET data = json_set(data, '$.audio.instrument', 'electric')")
        .run();
      await store.db.exec('PRAGMA user_version = 4');
      await store.close();
      store = await Store.open(path);
      agent = await AgentService.create(store, false, 'test');
      expect((await agent.snapshot()).settings).toEqual({
        instrument: 'piano',
        volume: 0.45,
        voice: 'sage',
        timezone: 'UTC',
      });
      expect((await agent.snapshot()).current?.id).toBe(result.snapshot.current?.id);
      expect((await agent.snapshot()).totalAnswers).toBe(0);
      expect(
        (
          await agent.execute({
            callId: randomUUID(),
            sessionId,
            name: 'replay_exercise',
            arguments: {},
          })
        ).audio?.instrument,
      ).toBe('piano');
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

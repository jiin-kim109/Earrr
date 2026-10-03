import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';

describe('retiring XP while retaining learning history', () => {
  it('removes reward columns, JSON fields and bookkeeping without changing answers or checkpoints', async () => {
    mkdirSync(resolve('test-results'), { recursive: true });
    const directory = mkdtempSync(resolve('test-results', 'retire-xp-'));
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
      const played = await agent.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
      await agent.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      });
      const next = await agent.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: {},
      });
      const before = await agent.snapshot();
      await store.db.exec(`
        ALTER TABLE attempts ADD COLUMN xp INTEGER NOT NULL DEFAULT 15;
        UPDATE attempts SET data = json_set(data, '$.grade.xp', 15);
        UPDATE sessions SET data = json_set(data, '$.xp', 15);
        UPDATE session_checkpoints SET state = json_set(state, '$.session.xp', 15, '$.feedback.grade.xp', 15);
        CREATE TABLE achievements (id TEXT PRIMARY KEY, earned_at TEXT NOT NULL);
        INSERT INTO achievements VALUES ('first-listen', '2026-09-29T12:00:00Z');
        PRAGMA user_version = 5;
      `);
      await store.close();
      store = await Store.open(path);
      agent = await AgentService.create(store, false, 'test');
      const after = await agent.snapshot();
      expect(after.totalAnswers).toBe(before.totalAnswers);
      expect(after.progress).toEqual(before.progress);
      expect(after.course).toEqual(before.course);
      expect(after.current?.id).toBe(next.snapshot.current!.id);
      expect(after.session?.answered).toBe(before.session?.answered);
      expect(after.session?.correct).toBe(before.session?.correct);
      expect(after).not.toHaveProperty('totalXp');
      expect(after).not.toHaveProperty('achievements');
      expect(after.session).not.toHaveProperty('xp');
      expect(after.recentAttempts[0]?.grade).not.toHaveProperty('xp');
      expect(
        (await store.db.prepare('PRAGMA table_info(attempts)').all()).some(
          (column) => column.name === 'xp',
        ),
      ).toBe(false);
      expect(
        await store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'achievements'").get(),
      ).toBeUndefined();
      const current = (await store.exercises.get(after.current!.id))!;
      const graded = await agent.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: current.id, answer: current.expected },
      });
      expect(graded.grade?.verdict).toBe('correct');
      expect(graded.snapshot.totalAnswers).toBe(before.totalAnswers + 1);
      expect(graded.agent.context.grade).not.toHaveProperty('xp');
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

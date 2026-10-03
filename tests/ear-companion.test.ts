import { describe, expect, it } from 'vitest';
import { companionRank } from '../frontend/components/EarCompanion.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { Store } from '../server/db/database.js';

describe('chapter-based cosmetic ear titles', () => {
  it('does not invent rank progress from partial lessons or clicks', async () => {
    const store = await Store.open(':memory:');
    try {
      const agent = await AgentService.create(store, false, 'test');
      const curriculum = agent.exercises.curriculum();
      const before = (await agent.snapshot()).course;
      const original = structuredClone(before);
      expect(companionRank(curriculum, before)).toMatchObject({ name: 'Rookie Ear', tier: 0 });
      await store.progress.completeLesson('pitch-direction', new Date().toISOString());
      expect(companionRank(curriculum, (await agent.snapshot()).course).tier).toBe(0);
      for (const lesson of curriculum.lessons.filter((lesson) => lesson.chapter === 1)) {
        await store.progress.completeLesson(lesson.id, new Date().toISOString());
      }
      expect(companionRank(curriculum, (await agent.snapshot()).course)).toMatchObject({
        name: 'Pitch Scout',
        tier: 1,
      });
      expect(before).toEqual(original);
      expect((await agent.snapshot()).totalAnswers).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('reaches Ear Master only when all chapters are complete', async () => {
    const store = await Store.open(':memory:');
    try {
      const agent = await AgentService.create(store, false, 'test');
      const curriculum = agent.exercises.curriculum();
      for (const lesson of curriculum.lessons)
        await store.progress.completeLesson(lesson.id, new Date().toISOString());
      expect(companionRank(curriculum, (await agent.snapshot()).course)).toMatchObject({
        name: 'Ear Master',
        tier: 5,
      });
      expect(await agent.snapshot()).not.toHaveProperty('totalXp');
    } finally {
      await store.close();
    }
  });
});

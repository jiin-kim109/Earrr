import { describe, expect, it } from 'vitest';
import { companionRank } from '../frontend/components/EarCompanion.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import { Store } from '../server/db/database.js';

describe('passed-lesson cosmetic ear titles', () => {
  it('grows after the first passed lesson without requiring a complete chapter', async () => {
    const store = await Store.open(':memory:');
    try {
      const agent = await AgentService.create(store, false, 'test');
      const curriculum = agent.exercises.curriculum();
      const before = (await agent.snapshot()).course;
      const original = structuredClone(before);
      expect(companionRank(curriculum, before)).toMatchObject({ name: 'Rookie Ear', tier: 0 });
      await store.progress.completeLesson('pitch-direction', new Date().toISOString());
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

  it('reaches Ear Master only when all active lessons are passed', async () => {
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

  it('uses distinct active lesson checks, regardless of chapter, order, attempts or repeated passes', async () => {
    const store = await Store.open(':memory:');
    try {
      const agent = await AgentService.create(store, false, 'test');
      const curriculum = agent.exercises.curriculum();
      const course = (await agent.snapshot()).course;
      const inProgress = structuredClone(course);
      for (const lesson of inProgress.lessons) {
        lesson.status = 'in_progress';
        lesson.answered = 100;
      }
      expect(companionRank(curriculum, inProgress).tier).toBe(0);
      for (const [count, tier] of [
        [1, 1],
        [7, 1],
        [8, 2],
        [15, 3],
        [22, 4],
        [28, 4],
        [29, 5],
      ] as const) {
        const next = structuredClone(course);
        for (const lesson of next.lessons.slice(-count)) lesson.status = 'completed';
        next.completedLessons = 999;
        next.lessons.push({ ...next.lessons.at(-1)! });
        expect(companionRank(curriculum, next).tier, `${count} passed lessons`).toBe(tier);
      }
      const historical = structuredClone(course);
      historical.lessons.push({
        skillId: 'jazz-progressions',
        status: 'completed',
        completedAt: new Date().toISOString(),
        answered: 8,
        unlocked: true,
      });
      expect(companionRank(curriculum, historical).tier).toBe(0);
      expect(companionRank({ ...curriculum, lessons: [] }, course).tier).toBe(0);
      expect((await agent.snapshot()).course).toEqual(course);
    } finally {
      await store.close();
    }
  });
});

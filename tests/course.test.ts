import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roundRule } from '../server/services/exercise/rounds.js';
import { AgentService as Game } from '../server/services/agent/agent.service.js';
import { Store } from '../server/db/database.js';
import { agentRequest } from '../server/controllers/agent.controller.js';
import { realtimeParameters } from '../server/services/agent/presentation.js';
import { skills } from '../server/services/exercise/catalog.js';

let store: Store;
let game: Game;
beforeEach(async () => {
  store = await Store.open(':memory:');
  game = await Game.create(store, false, 'test');
});
afterEach(async () => await store.close());

async function begin() {
  return (
    await game.execute({ callId: randomUUID(), name: 'start_session', arguments: { mode: 'solo' } })
  ).snapshot.session!.id;
}
async function play(sessionId: string) {
  const result = await game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'play_exercise',
    arguments: {},
  });
  return (await store.exercises.get(result.snapshot.current!.id))!;
}
describe('one-lesson course and honest checkpoints', () => {
  it('can complete every lesson using genuine varied generated exercises, including reference-pitch naming', async () => {
    const sessionId = await begin();
    for (const skill of skills) {
      await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'select_lesson',
        arguments: { skillId: skill.id },
      });
      let passed = false;
      for (let index = 0; index < 80 && !passed; index++) {
        const exercise = await play(sessionId);
        const result = await game.execute({
          callId: randomUUID(),
          sessionId,
          name: 'submit_answer',
          arguments: { exerciseId: exercise.id, answer: exercise.expected },
        });
        passed = result.lessonCompleted === true;
      }
      expect(passed, `${skill.id} should have an achievable checkpoint`).toBe(true);
    }
    expect((await game.snapshot()).course.completedLessons).toBe(skills.length);
    expect((await game.snapshot()).course.nextLesson).toBeNull();
    expect((await game.snapshot()).course.lessons.every((lesson) => lesson.unlocked)).toBe(true);
  }, 15_000);

  it('makes every lesson available without fabricating passed checkpoints', async () => {
    const state = await game.snapshot();
    expect(state.course.selectedLesson).toBe('pitch-direction');
    expect(
      state.course.lessons.filter((lesson) => lesson.unlocked).map((lesson) => lesson.skillId),
    ).toEqual(skills.map((skill) => skill.id));
    expect(state.course.completedLessons).toBe(0);
    expect(state.course.lessons.every((lesson) => lesson.status === 'not_started')).toBe(true);
    expect(
      game.exercises.curriculum().lessons.every((lesson) => lesson.prerequisites.length === 0),
    ).toBe(true);
    expect(state.settings.instrument).toBe('piano');
  });

  it('uses one explicit 8/10 rule for every lesson, without hidden diversity gates', () => {
    expect(roundRule).toEqual({ questions: 10, correct: 8 });
    for (const lesson of game.exercises.curriculum().lessons) {
      expect(lesson.checkpoint).toEqual(roundRule);
      expect(lesson.checkpointDescription).not.toMatch(/registers|categories|roots|last 10/i);
    }
  });

  it('freely selects advanced lessons while preventing an implicit lesson change through a play tool', async () => {
    const sessionId = await begin();
    for (const name of ['select_lesson', 'adjust_session'] as const) {
      const result = await game.execute({
        callId: randomUUID(),
        sessionId,
        name,
        arguments: name === 'select_lesson' ? { skillId: 'extensions' } : { focus: 'extensions' },
      });
      expect(result.snapshot.course.selectedLesson).toBe('extensions');
      expect(result.snapshot.course.completedLessons).toBe(0);
    }
    await expect(
      game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'play_exercise',
        arguments: { skillId: 'triads' },
      }),
    ).rejects.toThrow('Stay in the selected lesson');
    expect((await game.snapshot()).course.selectedLesson).toBe('extensions');
  });

  it.each(['coach', 'solo'] as const)(
    'starts %s directly in an advanced lesson without passing the basics',
    async (mode) => {
      const started = await game.execute({
        callId: randomUUID(),
        name: 'start_session',
        arguments: { mode, focus: 'upper-alterations' },
      });
      expect(started.snapshot.course.selectedLesson).toBe('upper-alterations');
      expect(started.snapshot.course.completedLessons).toBe(0);
      expect(started.snapshot.session?.phase).toBe(mode === 'coach' ? 'teaching' : 'practice');
      expect(started.snapshot.course.lessons.every((lesson) => lesson.unlocked)).toBe(true);
      const sessionId = started.snapshot.session!.id;
      if (mode === 'coach')
        await game.execute({
          callId: randomUUID(),
          sessionId,
          name: 'start_practice',
          arguments: {},
        });
      expect((await play(sessionId)).skillId).toBe('upper-alterations');
      expect((await game.snapshot()).course.completedLessons).toBe(0);
    },
  );

  it('can move to the next lesson immediately after failing without a completion check', async () => {
    const sessionId = await begin();
    for (let index = 0; index < 3; index++) {
      const exercise = await play(sessionId);
      await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: {
          exerciseId: exercise.id,
          answer: {
            direction: exercise.expected.direction === 'up' ? 'down' : 'up',
          },
        },
      });
    }
    const before = await game.snapshot();
    expect(before.course.round.previous?.passed).toBe(false);
    expect(before.course.lessons[0]?.status).toBe('in_progress');
    expect(before.course.completedLessons).toBe(0);
    await game.execute({
      callId: randomUUID(),
      sessionId,
      name: 'select_lesson',
      arguments: { skillId: before.course.nextLesson },
    });
    expect((await play(sessionId)).skillId).toBe('intervals-foundation');
    expect((await game.snapshot()).course.completedLessons).toBe(0);
  });

  it('locks every new random question to the selected lesson and pauses at a passed checkpoint', async () => {
    const sessionId = await begin();
    let complete = false;
    for (let index = 0; index < 60 && !complete; index++) {
      const exercise = await play(sessionId);
      expect(exercise.skillId).toBe('pitch-direction');
      const result = await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer: exercise.expected },
      });
      complete = result.lessonCompleted === true;
    }
    expect(complete).toBe(true);
    const state = await game.snapshot();
    expect(state.course.selectedLesson).toBe('pitch-direction');
    expect(state.course.lessons[0]?.status).toBe('completed');
    expect(state.course.lessons[1]?.unlocked).toBe(true);
    expect(state.session?.awaitingRoundChoice).toBe(true);
    const stopped = await game.execute({
      callId: randomUUID(),
      sessionId,
      name: 'play_exercise',
      arguments: {},
    });
    expect(stopped.audio).toBeUndefined();
    expect(stopped.message).toContain('Wait');
    await game.execute({
      callId: randomUUID(),
      sessionId,
      name: 'select_lesson',
      arguments: { skillId: state.course.nextLesson },
    });
    expect((await play(sessionId)).skillId).toBe('intervals-foundation');
    expect((await game.snapshot()).course.lessons[0]?.status).toBe('completed');
  });

  it('counts each correct answer once while tracking hint use separately for mastery', async () => {
    const sessionId = await begin();
    for (let index = 0; index < 8; index++) {
      const exercise = await play(sessionId);
      await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'give_hint',
        arguments: { exerciseId: exercise.id },
      });
      for (let replay = 0; replay < 2; replay++)
        await game.execute({
          callId: randomUUID(),
          sessionId,
          name: 'replay_exercise',
          arguments: {},
        });
      const args = { exerciseId: exercise.id, answer: exercise.expected };
      await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: args,
      });
      await game.execute({
        callId: randomUUID(),
        sessionId,
        name: 'submit_answer',
        arguments: args,
      });
    }
    const state = await game.snapshot();
    expect(state.totalAnswers).toBe(8);
    expect(state.course.round.correct).toBe(0);
    expect(state.course.lessons[0]?.status).toBe('completed');
    expect(state.course.round.answers).toHaveLength(0);
    expect(state.course.round.previous).toMatchObject({
      number: 1,
      correct: 8,
      answered: 8,
      passed: true,
    });
    expect(
      state.progress.find((item) => item.skillId === 'pitch-direction')?.unassistedCorrect,
    ).toBe(0);
    expect(state.course.lessons[1]?.unlocked).toBe(true);
  });
});

describe('realtime argument boundary', () => {
  it('omits schema-only format metadata from provider definitions while retaining server validation', async () => {
    const schema = realtimeParameters('submit_answer');
    expect(JSON.stringify(schema)).not.toContain('"format"');
    expect(JSON.stringify(schema)).not.toContain('"$schema"');
    expect(JSON.stringify(schema)).toContain('"additionalProperties":false');
    await expect(
      game.execute({
        callId: randomUUID(),
        name: 'give_hint',
        arguments: { exerciseId: 'not-a-uuid' },
      }),
    ).rejects.toThrow();
  });

  it('normalizes only the observed schema-metadata mistake, grades correctly, and records the repair', async () => {
    const sessionId = await begin();
    const exercise = await play(sessionId);
    const input = {
      callId: randomUUID(),
      sessionId,
      name: 'submit_answer',
      arguments: {
        format: 'json',
        exerciseId: exercise.id,
        answer: { ...exercise.expected, format: 'json' },
      },
    };
    const result = await game.execute(await agentRequest(input, store));
    expect(result.grade?.verdict).toBe('correct');
    expect(result.snapshot.totalAnswers).toBe(1);
    expect((await store.sessions.diagnostics())[0]?.code).toBe('schema_metadata_removed');
    expect(JSON.stringify(await store.sessions.diagnostics())).not.toContain('"answer":');
    await expect(
      game.execute(
        await agentRequest(
          { ...input, callId: randomUUID(), arguments: { ...input.arguments, awardXp: 500 } },
          store,
        ),
      ),
    ).rejects.toThrow();
  });
});

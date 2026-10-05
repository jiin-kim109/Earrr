import { randomUUID } from 'node:crypto';
import { decodeRecord } from '../../db/database.js';
import type { Store } from '../../db/database.js';
import type { ActionOutcome } from '../../types/agent.types.js';
import type { Exercise } from '../../types/exercise.types.js';
import type { LessonPosition } from '../../types/session.types.js';
import { essentialIntervals } from './catalog.js';
import { createExercise } from './generator.js';

const lessons = ['intervals-foundation', 'intervals-harmonic'] as const;

export async function restoreIntervalRevision(store: Store) {
  const pending = (
    await store.db.all<Exercise>(
      `SELECT data FROM exercises
       WHERE ${store.db.jsonText('data', 'skillId')} IN (?, ?)
         AND ${store.db.jsonText('data', 'status')}='unanswered'`,
      ...lessons,
    )
  ).filter((exercise) => exercise.expected.interval === 5);
  const retired = new Set(pending.map((exercise) => exercise.id));
  const replacements = new Map<string, Exercise>();
  const settings = await store.user.getSettings();
  for (const lessonId of lessons) {
    const round = await store.progress.round(lessonId);
    if (!round || !round.remaining.some((item) => item.target.interval === 5)) continue;
    const counts = new Map<number, number>(
      essentialIntervals.map((interval) => [
        interval,
        round.remaining.filter((item) => item.target.interval === interval).length,
      ]),
    );
    for (const item of round.remaining) {
      if (item.target.interval !== 5) continue;
      const interval = essentialIntervals.reduce((best, candidate) =>
        counts.get(candidate)! < counts.get(best)! ? candidate : best,
      );
      counts.set(interval, counts.get(interval)! + 1);
      const previous = pending.find(
        (exercise) => exercise.roundId === round.id && exercise.roundTargetId === item.id,
      );
      item.id = randomUUID();
      item.target = { ...item.target, interval };
      if (previous) {
        const sessionId = await store.exercises.sessionId(previous.id);
        if (!sessionId) throw new Error('The retired interval question has no owning session.');
        const replacement: Exercise = {
          ...createExercise({
            id: randomUUID(),
            skillId: lessonId,
            seed: previous.seed,
            target: { ...item.target, root: previous.root },
            now: previous.createdAt,
            settings,
          }),
          roundId: round.id,
          roundTargetId: item.id,
        };
        await store.exercises.save(replacement, sessionId);
        replacements.set(previous.id, replacement);
      }
    }
    await store.progress.saveRound(round);
  }

  const restoreId = (id: string | null) =>
    id && retired.has(id) ? (replacements.get(id)?.id ?? null) : id;
  const restorePosition = <T extends LessonPosition>(position: T): T => ({
    ...position,
    currentExerciseId: restoreId(position.currentExerciseId),
    previousExerciseId: restoreId(position.previousExerciseId),
    playedTutorialSteps: position.playedTutorialSteps?.filter((step) => step !== 'perfect-fourth'),
  });
  for (const lessonId of lessons) {
    for (const mode of ['coach', 'solo'] as const) {
      const position = await store.sessions.lessonPosition(lessonId, mode);
      if (!position) continue;
      const restored = restorePosition(position);
      if (JSON.stringify(restored) !== JSON.stringify(position))
        await store.sessions.saveLessonPosition(lessonId, mode, restored);
    }
  }
  const active = await store.sessions.active();
  if (active) {
    const restored = {
      ...active,
      currentExerciseId: restoreId(active.currentExerciseId),
      previousExerciseId: restoreId(active.previousExerciseId),
      ...(lessons.some((lesson) => lesson === active.focus)
        ? {
            playedTutorialSteps: active.playedTutorialSteps?.filter(
              (step) => step !== 'perfect-fourth',
            ),
          }
        : {}),
    };
    if (JSON.stringify(restored) !== JSON.stringify(active)) await store.sessions.save(restored);
  }
  for (const row of await store.db.prepare('SELECT id,data FROM tool_calls').all()) {
    const cached = decodeRecord<ActionOutcome>(row);
    if (
      cached.teaching &&
      !cached.teaching.section &&
      lessons.some((lesson) => lesson === cached.teaching?.lessonId)
    ) {
      await store.db.prepare('DELETE FROM tool_calls WHERE id=?').run(row.id!);
    } else if (cached.playbackExerciseId && retired.has(cached.playbackExerciseId)) {
      const { audio: _audio, playbackExerciseId: _playback, nextQuestion: _next, ...kept } = cached;
      const replacement = replacements.get(cached.playbackExerciseId);
      const restored = replacement
        ? { ...cached, audio: replacement.audio, playbackExerciseId: replacement.id }
        : kept;
      await store.db
        .prepare('UPDATE tool_calls SET data=? WHERE id=?')
        .run(JSON.stringify(restored), row.id!);
    }
  }
}

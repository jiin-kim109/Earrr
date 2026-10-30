import { randomBytes, randomUUID } from 'node:crypto';
import type { Store } from '../../db/database.js';
import type { SkillId } from '../../../shared/types/course.js';
import { skills } from './catalog.js';
import { roundPlan } from './rounds.js';
import { newTeachingProgress, newWelcomeProgress } from './exercise.service.js';
import { restoreIntervalRevision } from './interval-revision.js';
import { decodeRecord } from '../../db/database.js';
import type { ActionOutcome } from '../../types/agent.types.js';

const redirects: Partial<Record<SkillId, SkillId>> = {
  'intervals-chromatic': 'intervals-harmonic',
  'reference-pitch': 'intervals-harmonic',
  melodies: 'scales',
  'jazz-progressions': 'cadences',
  'scale-degrees': 'scales',
  'chord-roots': 'triad-inversions',
};
const unchanged: readonly SkillId[] = [
  'pitch-direction',
  'intervals-foundation',
  'intervals-harmonic',
  'triads',
];

export async function restoreCourseRevision(store: Store) {
  const row = await store.db.prepare('SELECT skill_id, revision FROM course WHERE id=1').get();
  if (!row) throw new Error('The course state is missing.');
  const revision = Number(row.revision);
  if (revision === 4) return;
  if (![1, 2, 3].includes(revision))
    throw new Error('The saved curriculum revision is not supported.');
  await store.transaction(async () => {
    if (revision === 1) await restoreOriginalCourseRevision(store, String(row.skill_id) as SkillId);
    if (revision < 3) await restoreIntervalRevision(store);
    await restoreCourseLayout(store);
    await store.db.prepare('UPDATE course SET revision=4 WHERE id=1').run();
  });
}

async function restoreOriginalCourseRevision(store: Store, selectedRaw: SkillId) {
  await store.transaction(async () => {
    const selected = redirects[selectedRaw] ?? selectedRaw;
    if (!skills.some((skill) => skill.id === selected))
      throw new Error('The saved lesson cannot be mapped to this course.');
    for (const skill of skills) {
      if (unchanged.includes(skill.id)) continue;
      const round = await store.progress.round(skill.id);
      if (round) {
        await store.progress.saveRound({
          ...round,
          id: randomUUID(),
          answers: [],
          remaining: roundPlan(skill.id, round.number, randomBytes(4).readUInt32LE()).map(
            (target) => ({ id: randomUUID(), target }),
          ),
        });
      }
      await store.db.prepare('DELETE FROM lesson_introductions WHERE skill_id=?').run(skill.id);
      for (const mode of ['coach', 'solo'] as const) {
        if (await store.sessions.lessonPosition(skill.id, mode)) {
          await store.sessions.saveLessonPosition(skill.id, mode, {
            phase: mode === 'coach' ? 'teaching' : 'practice',
            teaching: mode === 'coach' ? newTeachingProgress(skill.id) : null,
            currentExerciseId: null,
            previousExerciseId: null,
            playedTutorialSteps: [],
          });
        }
      }
    }
    const session = await store.sessions.active();
    if (session) {
      const oldFocus = session.focus === 'adaptive' ? selectedRaw : session.focus;
      const focus = redirects[oldFocus] ?? oldFocus;
      if (session.teaching?.section === 'welcome') {
        await store.sessions.save({
          ...session,
          focus,
          teaching: newWelcomeProgress(focus),
          currentExerciseId: null,
          previousExerciseId: null,
        });
      } else if (!unchanged.includes(oldFocus) || focus !== oldFocus) {
        const waiting = focus === oldFocus && (await store.progress.round(focus))?.awaitingChoice;
        await store.sessions.save({
          ...session,
          focus,
          phase: waiting || session.mode === 'solo' ? 'practice' : 'teaching',
          teaching: !waiting && session.mode === 'coach' ? newTeachingProgress(focus) : null,
          currentExerciseId: waiting ? session.currentExerciseId : null,
          previousExerciseId: waiting ? session.previousExerciseId : null,
          awaitingRoundChoice: Boolean(waiting),
          playedTutorialSteps: [],
        });
      }
    }
    await store.db.prepare('UPDATE course SET skill_id=?, revision=2 WHERE id=1').run(selected);
  });
}

async function restoreCourseLayout(store: Store) {
  const row = await store.db.prepare('SELECT skill_id FROM course WHERE id=1').get();
  const selectedRaw = String(row?.skill_id) as SkillId;
  const selected = redirects[selectedRaw] ?? selectedRaw;
  await store.progress.selectLesson(selected);
  for (const mode of ['coach', 'solo'] as const) {
    const pitch = await store.sessions.lessonPosition('pitch-direction', mode);
    if (pitch?.phase === 'teaching')
      await store.sessions.saveLessonPosition('pitch-direction', mode, {
        ...pitch,
        phase: 'practice',
        teaching: null,
      });
  }
  const active = await store.sessions.active();
  if (active) {
    const focusRaw = active.focus === 'adaptive' ? selectedRaw : active.focus;
    const focus = redirects[focusRaw] ?? focusRaw;
    if (active.teaching?.section === 'welcome') {
      await store.sessions.save({
        ...active,
        focus,
        teaching: { ...active.teaching, lessonId: focus },
      });
    } else if (focus !== focusRaw) {
      const saved = await store.sessions.lessonPosition(focus, active.mode);
      const awaitingRoundChoice = Boolean((await store.progress.round(focus))?.awaitingChoice);
      const teaching =
        !saved &&
        active.mode === 'coach' &&
        !(await store.progress.introductionSeen(focus)) &&
        !awaitingRoundChoice;
      await store.sessions.save({
        ...active,
        focus,
        ...(saved ?? {
          phase: teaching ? ('teaching' as const) : ('practice' as const),
          teaching: teaching ? newTeachingProgress(focus) : null,
          currentExerciseId: null,
          previousExerciseId: null,
          playedTutorialSteps: [],
        }),
        awaitingRoundChoice,
      });
    } else if (focus === 'pitch-direction' && active.phase === 'teaching') {
      await store.sessions.save({ ...active, phase: 'practice', teaching: null });
    }
  }
  // Cached presentations belong to the old lesson layout, not to the preserved grades.
  await store.db.exec(
    `DELETE FROM tool_calls WHERE ${store.db.jsonText('data', 'teaching')} IS NOT NULL`,
  );
  const cached = await store.db
    .prepare(
      `
    SELECT c.id,c.data FROM tool_calls c JOIN exercises e
      ON e.id=${store.db.jsonText('c.data', 'playbackExerciseId')}
    WHERE ${store.db.jsonText('e.data', 'skillId')} IN ('scale-degrees','chord-roots')
  `,
    )
    .all();
  for (const row of cached) {
    const outcome = decodeRecord<ActionOutcome>(row);
    if (outcome.review) continue;
    const { audio: _audio, playbackExerciseId: _playback, nextQuestion: _next, ...kept } = outcome;
    await store.db
      .prepare('UPDATE tool_calls SET data=? WHERE id=?')
      .run(JSON.stringify(kept), row.id!);
  }
}

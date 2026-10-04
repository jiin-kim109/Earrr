import { randomBytes, randomUUID } from 'node:crypto';
import type { Store } from '../../db/database.js';
import type { SkillId } from '../../../shared/types/course.js';
import { skills } from './catalog.js';
import { roundPlan } from './rounds.js';
import { newTeachingProgress } from './exercise.service.js';

const redirects: Partial<Record<SkillId, SkillId>> = {
  'intervals-chromatic': 'intervals-harmonic',
  'reference-pitch': 'intervals-harmonic',
  melodies: 'scale-degrees',
  'jazz-progressions': 'cadences',
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
  if (Number(row.revision) === 2) return;
  if (Number(row.revision) !== 1)
    throw new Error('The saved curriculum revision is not supported.');
  await store.transaction(async () => {
    const selectedRaw = String(row.skill_id) as SkillId;
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
          teaching: { ...newTeachingProgress(focus, 0, null, false), section: 'welcome' },
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

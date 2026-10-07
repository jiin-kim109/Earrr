import type { Database } from './database.js';
import { skills } from '../services/exercise/catalog.js';
import { ProgressService } from '../services/progress.service.js';
import { newTeachingProgress } from '../services/exercise/exercise.service.js';
import type { Store } from './database.js';
import { learningEventTypes } from '../types/conversation.types.js';

export async function initializeSchema(db: Database): Promise<number> {
  const version = Number((await db.prepare('PRAGMA user_version').get())?.user_version ?? 0);
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS earrr_feedback (
      actor_id TEXT PRIMARY KEY,
      session_id TEXT,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
      reply_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_session
      ON sessions((1)) WHERE status <> 'ended';

    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS exercises_session ON exercises(session_id, created_at);

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      exercise_id TEXT NOT NULL UNIQUE REFERENCES exercises(id),
      session_id TEXT NOT NULL REFERENCES sessions(id),
      skill_id TEXT NOT NULL,
      day TEXT NOT NULL,
      correct INTEGER NOT NULL,
      skipped INTEGER NOT NULL,
      score REAL NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempts_day ON attempts(day);
    CREATE TABLE IF NOT EXISTS progress (skill_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS practice_rounds (skill_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playback_receipts (
      id TEXT PRIMARY KEY,
      exercise_id TEXT NOT NULL REFERENCES exercises(id)
    );
    CREATE TABLE IF NOT EXISTS course (id INTEGER PRIMARY KEY CHECK(id = 1), skill_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 3);
    CREATE TABLE IF NOT EXISTS lesson_completions (skill_id TEXT PRIMARY KEY, completed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lesson_introductions (
      skill_id TEXT PRIMARY KEY,
      disposition TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lesson_positions (
      skill_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('coach', 'solo')),
      data TEXT NOT NULL,
      PRIMARY KEY(skill_id, mode)
    );
    CREATE TABLE IF NOT EXISTS diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      code TEXT NOT NULL,
      action TEXT,
      details TEXT NOT NULL
    );
  `);
  return version;
}

export async function migrateLegacyData(store: Store, version: number, now: () => Date) {
  if (version < 5) {
    await store.transaction(async () => {
      await store.db.exec(`
        UPDATE settings SET data = json_object(
          'instrument', CASE WHEN json_extract(data, '$.instrument') = 'guitar' THEN 'guitar' ELSE 'piano' END,
          'volume', COALESCE(json_extract(data, '$.volume'), json_extract(data, '$.voiceVolume'), 0.8),
          'voice', COALESCE(json_extract(data, '$.voice'), 'sage'),
          'timezone', COALESCE(json_extract(data, '$.timezone'), 'UTC')
        );
        UPDATE exercises SET data = json_set(data, '$.audio.instrument', 'piano')
        WHERE json_extract(data, '$.audio.instrument') IN ('sine', 'felt', 'electric');
        UPDATE tool_calls SET data = json_set(data, '$.audio.instrument', 'piano')
        WHERE json_extract(data, '$.audio.instrument') IN ('sine', 'felt', 'electric');
      `);
    });
  }
  if (version < 4) {
    await store.transaction(async () => {
      const retiredLesson = 'intervals-comparison';
      await store.db
        .prepare("UPDATE course SET skill_id = 'intervals-foundation' WHERE skill_id = ?")
        .run(retiredLesson);

      const session = await store.sessions.active();
      const current = session?.currentExerciseId
        ? await store.exercises.get(session.currentExerciseId)
        : null;
      if (
        session &&
        [session.focus, session.teaching?.lessonId, current?.skillId].some(
          (skill) => String(skill) === retiredLesson,
        )
      ) {
        const teaching = session.mode === 'coach' && session.phase === 'teaching';
        await store.sessions.save({
          ...session,
          focus: 'intervals-foundation',
          currentExerciseId: null,
          previousExerciseId: null,
          awaitingRoundChoice: false,
          phase: teaching ? 'teaching' : 'practice',
          teaching: teaching ? newTeachingProgress('intervals-foundation') : null,
        });
      }
      // Cached comparison audio is obsolete; attempts and learning history remain intact.
      await store.db.exec(`
        DELETE FROM tool_calls
        WHERE json_type(data, '$.playback') IS NOT NULL
           OR json_type(data, '$.reference') IS NOT NULL
      `);
    });
  }

  if (version < 2) {
    await store.transaction(async () => {
      const settings = await store.user.getSettings();
      await store.user.saveSettings({
        ...settings,
        instrument: 'piano',
      });

      const active = await store.sessions.active();
      if (active) {
        await store.sessions.save({ ...active, status: 'ended', endedAt: now().toISOString() });
      }

      const progress = new ProgressService(store, now);
      const next = (await progress.course()).lessons.find(
        (lesson) => lesson.status !== 'completed',
      );
      await store.db
        .prepare('UPDATE course SET skill_id = ? WHERE id = 1')
        .run(next?.skillId ?? skills[0]!.id);
      await store.db.exec('PRAGMA user_version = 2');
    });
  }

  if (version < 3) {
    await store.transaction(async () => {
      const session = await store.sessions.active();
      if (session && session.phase === undefined) {
        const teaching = session.mode === 'coach';
        await store.sessions.save({
          ...session,
          phase: teaching ? 'teaching' : 'practice',
          teaching: teaching ? newTeachingProgress(await store.progress.selectedLesson()) : null,
        });
      }
      await store.db.exec('PRAGMA user_version = 3');
    });
  }
  if (version < 6) {
    await store.transaction(async () => {
      const columns = await store.db.prepare('PRAGMA table_info(attempts)').all();
      if (columns.some((column) => column.name === 'xp')) {
        await store.db.exec('ALTER TABLE attempts DROP COLUMN xp');
      }
      await store.db.exec(`
        UPDATE sessions SET data = json_remove(data, '$.xp');
        UPDATE attempts SET data = json_remove(data, '$.grade.xp');
        UPDATE tool_calls SET data = json_remove(data, '$.grade.xp');
        UPDATE session_checkpoints SET state = json_remove(state, '$.session.xp', '$.feedback.grade.xp');
        UPDATE conversation_events SET payload = json_remove(payload, '$.result.grade.xp');
        DROP TABLE IF EXISTS achievements;
        PRAGMA user_version = 6;
      `);
    });
  }
  if (version < 7) {
    await store.transaction(async () => {
      const session = await store.sessions.active();
      const teaching = session?.teaching;
      if (session && teaching?.lessonId === 'pitch-direction') {
        // The retired unison was step 3; the old final invitation was step 4.
        const lastDemoIndex = teaching.lastDemoIndex === 3 ? 2 : teaching.lastDemoIndex;
        const retiredStep = teaching.index === 3 || teaching.index === 4;
        if (retiredStep || lastDemoIndex !== teaching.lastDemoIndex) {
          await store.sessions.save({
            ...session,
            teaching: retiredStep
              ? newTeachingProgress('pitch-direction', 3, lastDemoIndex, false)
              : { ...teaching, lastDemoIndex },
          });
        }
      }
      await store.db.exec('PRAGMA user_version = 7');
    });
  }
  if (version < 8) {
    await store.transaction(async () => {
      const session = await store.sessions.active();
      const current = session?.currentExerciseId
        ? await store.exercises.get(session.currentExerciseId)
        : null;
      // Preserve old questions in history, but do not mix them into a newly planned round.
      if (session && current && !current.roundId) {
        await store.sessions.save({
          ...session,
          currentExerciseId: null,
          previousExerciseId: null,
        });
      }
      await store.db.exec('DELETE FROM tool_calls; PRAGMA user_version = 8');
    });
  }
  if (version < 9) {
    await store.transaction(async () => {
      await store.db.exec(`
        UPDATE sessions SET data = json_set(
          json_remove(data, '$.awaitingLessonChoice'),
          '$.awaitingRoundChoice',
          json(CASE WHEN COALESCE(json_extract(data, '$.awaitingRoundChoice'), json_extract(data, '$.awaitingLessonChoice'), 0)
            THEN 'true' ELSE 'false' END)
        );
        UPDATE practice_rounds SET data = json_set(data, '$.previous.answered', json_extract(data, '$.previous.questions'))
        WHERE json_type(data, '$.previous') = 'object' AND json_type(data, '$.previous.answered') IS NULL;
        UPDATE practice_rounds SET data = json_set(data, '$.awaitingChoice',
          json(CASE WHEN json_type(data, '$.previous') = 'object' AND json_array_length(data, '$.answers') = 0 THEN 'true' ELSE 'false' END));
        DELETE FROM tool_calls;
      `);
      const progress = new ProgressService(store, now);
      for (const skill of skills) {
        const ended = await progress.closeResolvedRound(skill.id);
        const session = await store.sessions.active();
        if (ended && session?.focus === skill.id) {
          await store.sessions.save({
            ...session,
            currentExerciseId: null,
            previousExerciseId: null,
            awaitingRoundChoice: true,
          });
        }
        const active = await store.sessions.active();
        if (active) {
          const round = await store.progress.round(await store.progress.selectedLesson());
          if (round?.awaitingChoice) {
            await store.sessions.save({
              ...active,
              currentExerciseId: null,
              previousExerciseId: null,
              awaitingRoundChoice: true,
            });
          }
        }
      }
      await store.db.exec('PRAGMA user_version = 9');
    });
  }
  if (version < 10) await store.db.exec('DELETE FROM tool_calls; PRAGMA user_version = 10');
  if (version < 11) {
    const kinds = learningEventTypes.map((kind) => `'${kind}'`).join(',');
    await store.transaction(() =>
      store.db.exec(`
        DELETE FROM session_checkpoints WHERE event_sequence IN (
          SELECT sequence FROM conversation_events WHERE kind NOT IN (${kinds})
        );
        DELETE FROM conversation_events WHERE kind NOT IN (${kinds});
        UPDATE session_checkpoints SET state = json_remove(state, '$.messages');
        UPDATE tool_calls SET data = json_remove(
          data, '$.snapshot', '$.messages', '$.transcript', '$.recentConversation'
        );
        PRAGMA user_version = 11;
      `),
    );
  }
  if (version < 12) {
    await store.transaction(async () => {
      await store.conversations.initialize();
      await store.db.exec('PRAGMA user_version = 12');
    });
  }
  if (version < 13) {
    const columns = await store.db.prepare('PRAGMA table_info(course)').all();
    if (!columns.some((column) => column.name === 'revision'))
      await store.db.exec('ALTER TABLE course ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    await store.db.exec('PRAGMA user_version = 13');
  }
}

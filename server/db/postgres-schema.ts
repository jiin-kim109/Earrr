import type { Database } from './connection.js';
import { learningEventTypes } from '../types/conversation.types.js';

export async function initializePostgres(db: Database) {
  await db.transaction(async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_session ON sessions((1)) WHERE status <> 'ended';
      CREATE TABLE IF NOT EXISTS exercises (seq BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS exercises_session ON exercises(session_id,created_at);
      CREATE TABLE IF NOT EXISTS attempts (seq BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, exercise_id TEXT NOT NULL UNIQUE REFERENCES exercises(id), session_id TEXT NOT NULL REFERENCES sessions(id), skill_id TEXT NOT NULL, day TEXT NOT NULL, correct INTEGER NOT NULL, skipped INTEGER NOT NULL, score DOUBLE PRECISION NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_day ON attempts(day);
      CREATE TABLE IF NOT EXISTS progress (skill_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS practice_rounds (skill_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS playback_receipts (id TEXT PRIMARY KEY, exercise_id TEXT NOT NULL REFERENCES exercises(id));
      CREATE TABLE IF NOT EXISTS course (id INTEGER PRIMARY KEY CHECK(id=1), skill_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 3);
      CREATE TABLE IF NOT EXISTS lesson_completions (skill_id TEXT PRIMARY KEY, completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lesson_introductions (skill_id TEXT PRIMARY KEY, disposition TEXT NOT NULL, finished_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lesson_positions (skill_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('coach', 'solo')), data TEXT NOT NULL, PRIMARY KEY(skill_id,mode));
      CREATE TABLE IF NOT EXISTS diagnostics (id BIGSERIAL PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, code TEXT NOT NULL, action TEXT, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcripts (seq BIGSERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS transcript_order ON transcripts((data::jsonb ->> 'createdAt'),seq);
      CREATE TABLE IF NOT EXISTS conversation_events (sequence BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(session_id,event_id));
      CREATE INDEX IF NOT EXISTS conversation_thread ON conversation_events(session_id,sequence);
      CREATE TABLE IF NOT EXISTS session_checkpoints (sequence BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), event_sequence BIGINT NOT NULL REFERENCES conversation_events(sequence), created_at TEXT NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS checkpoint_thread ON session_checkpoints(session_id,sequence DESC);
      INSERT INTO schema_version(id, version) VALUES(1,13) ON CONFLICT(id) DO NOTHING;
    `);
    const version = await db.prepare('SELECT version FROM schema_version WHERE id=1').get();
    if ([9, 10].includes(Number(version?.version))) {
      const kinds = learningEventTypes.map((kind) => `'${kind}'`).join(',');
      await db.exec(`
        DELETE FROM session_checkpoints WHERE event_sequence IN (
          SELECT sequence FROM conversation_events WHERE kind NOT IN (${kinds})
        );
        DELETE FROM conversation_events WHERE kind NOT IN (${kinds});
        UPDATE session_checkpoints SET state = (state::jsonb - 'messages')::text;
        UPDATE tool_calls SET data = (data::jsonb - 'snapshot' - 'messages' - 'transcript' - 'recentConversation')::text;
      `);
    } else if (![11, 12, 13].includes(Number(version?.version)))
      throw new Error('The PostgreSQL schema version is not supported.');
    if (Number(version?.version) < 12)
      await db.exec('UPDATE schema_version SET version=12 WHERE id=1');
    if (Number(version?.version) < 13) {
      await db.exec(
        'ALTER TABLE course ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1',
      );
      await db.exec('UPDATE schema_version SET version=13 WHERE id=1');
    }
  });
}

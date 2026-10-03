import { z } from 'zod';
import type { Database } from '../db/database.js';
import type { Transcript } from '../../shared/types/user.js';
import type { ConversationEvent, SessionCheckpoint } from '../types/conversation.types.js';
import { transcriptSchema } from '../types/conversation.types.js';
import { AppError } from '../errors/app-error.js';

export class ConversationRepository {
  constructor(private readonly db: Database) {}
  async initialize() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcripts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_order
        ON transcripts(json_extract(data, '$.createdAt'), seq);
      CREATE TABLE IF NOT EXISTS conversation_events(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(session_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_thread ON conversation_events(session_id,sequence);
      CREATE TABLE IF NOT EXISTS session_checkpoints(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        event_sequence INTEGER NOT NULL REFERENCES conversation_events(sequence),
        created_at TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoint_thread ON session_checkpoints(session_id,sequence DESC);
    `);
  }

  async saveMessage(input: Transcript): Promise<void> {
    const message = transcriptSchema.parse(input);
    await this.db.transaction(async () => {
      if (!(await this.db.prepare('SELECT id FROM sessions WHERE id=?').get(message.sessionId)))
        throw AppError.create('session_not_found');
      const existing = await this.db
        .prepare('SELECT session_id FROM transcripts WHERE id=?')
        .get(message.id);
      if (existing && existing.session_id !== message.sessionId)
        throw AppError.create(
          'call_id_reused',
          'This message identifier is already saved for a different session.',
        );
      await this.db
        .prepare(
          `INSERT INTO transcripts(id,session_id,data) VALUES(?,?,?)
           ON CONFLICT(id) DO UPDATE SET data=excluded.data
           WHERE transcripts.session_id=excluded.session_id AND transcripts.data<>excluded.data`,
        )
        .run(message.id, message.sessionId, JSON.stringify(message));
    });
  }

  async messages(limit = 100): Promise<Transcript[]> {
    const count = z.number().int().min(0).max(100).parse(limit);
    const records = await this.db
      .prepare(
        `SELECT data FROM transcripts ORDER BY ${this.db.jsonText('data', 'createdAt')} DESC, seq DESC LIMIT ?`,
      )
      .all(count);
    return records.reverse().map((row) => transcriptSchema.parse(JSON.parse(String(row.data))));
  }

  async append(event: ConversationEvent, state: SessionCheckpoint['state']) {
    const inserted = await this.db
      .prepare(
        'INSERT INTO conversation_events(event_id,session_id,kind,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(session_id,event_id) DO NOTHING RETURNING sequence',
      )
      .get(event.id, event.sessionId, event.type, event.createdAt, JSON.stringify(event.payload));
    if (!inserted) return;
    await this.db
      .prepare(
        'INSERT INTO session_checkpoints(session_id,event_sequence,created_at,state) VALUES(?,?,?,?)',
      )
      .run(event.sessionId, inserted.sequence!, new Date().toISOString(), JSON.stringify(state));
  }

  async latest(sessionId: string): Promise<SessionCheckpoint | null> {
    const row = await this.db
      .prepare(
        'SELECT sequence,event_sequence,created_at,state FROM session_checkpoints WHERE session_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(sessionId);
    if (!row || typeof row.state !== 'string') return null;
    return {
      sequence: Number(row.sequence),
      eventSequence: Number(row.event_sequence),
      createdAt: String(row.created_at),
      state: JSON.parse(row.state) as SessionCheckpoint['state'],
    };
  }

  async events(sessionId: string, after = 0, limit = 100): Promise<ConversationEvent[]> {
    return (
      await this.db
        .prepare(
          'SELECT sequence,event_id,kind,created_at,payload FROM conversation_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(sessionId, after, Math.min(limit, 500))
    ).map((row) => ({
      sequence: Number(row.sequence),
      id: String(row.event_id),
      sessionId,
      type: String(row.kind) as ConversationEvent['type'],
      createdAt: String(row.created_at),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    }));
  }
}

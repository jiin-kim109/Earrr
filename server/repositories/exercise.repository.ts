import type { Database } from '../db/database.js';
import type { Exercise } from '../types/exercise.types.js';

export class ExerciseRepository {
  constructor(private readonly database: Database) {}

  async get(id: string): Promise<Exercise | null> {
    return await this.database.one('SELECT data FROM exercises WHERE id = ?', id);
  }

  async pendingForTarget(
    skillId: string,
    roundId: string,
    targetId: string,
  ): Promise<Exercise | null> {
    return await this.database.one(
      `
      SELECT data FROM exercises
      WHERE ${this.database.jsonText('data', 'skillId')} = ?
        AND ${this.database.jsonText('data', 'roundId')} = ?
        AND ${this.database.jsonText('data', 'roundTargetId')} = ?
        AND ${this.database.jsonText('data', 'status')} = 'unanswered'
      ORDER BY ${this.database.ordinal} DESC LIMIT 1
    `,
      skillId,
      roundId,
      targetId,
    );
  }

  async sessionId(id: string): Promise<string | null> {
    const row = await this.database
      .prepare('SELECT session_id FROM exercises WHERE id = ?')
      .get(id);
    return typeof row?.session_id === 'string' ? row.session_id : null;
  }

  async recent(): Promise<Exercise[]> {
    return await this.database.all(
      `SELECT data FROM exercises ORDER BY created_at DESC, ${this.database.ordinal} DESC LIMIT 24`,
    );
  }

  async save(exercise: Exercise, sessionId: string) {
    await this.database
      .prepare(
        `
      INSERT INTO exercises (id, session_id, created_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `,
      )
      .run(exercise.id, sessionId, exercise.createdAt, JSON.stringify(exercise));
  }
}

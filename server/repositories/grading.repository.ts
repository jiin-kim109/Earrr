import { Database, decodeRecord } from '../db/database.js';
import { dateKey } from '../services/progress.service.js';
import type { DailyActivity } from '../types/progress.types.js';
import type { Attempt } from '../types/grading.types.js';
import type { Exercise } from '../types/exercise.types.js';
import type { RoundAnswer } from '../types/progress.types.js';

export class GradingRepository {
  constructor(private readonly database: Database) {}

  async get(exerciseId: string): Promise<Attempt | null> {
    return await this.database.one('SELECT data FROM attempts WHERE exercise_id = ?', exerciseId);
  }

  async byId(id: string): Promise<Attempt | null> {
    return await this.database.one('SELECT data FROM attempts WHERE id = ?', id);
  }

  async latest(sessionId: string): Promise<Attempt | null> {
    return await this.database.one(
      `SELECT data FROM attempts WHERE session_id = ? ORDER BY ${this.database.ordinal} DESC LIMIT 1`,
      sessionId,
    );
  }

  async save(attempt: Attempt, timezone: string) {
    await this.database
      .prepare(
        `
      INSERT INTO attempts (
        id, exercise_id, session_id, skill_id, day, correct, skipped, score, created_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        attempt.id,
        attempt.exerciseId,
        attempt.sessionId,
        attempt.skillId,
        dateKey(new Date(attempt.createdAt), timezone),
        Number(attempt.grade.verdict === 'correct'),
        Number(attempt.skipped),
        attempt.grade.score,
        attempt.createdAt,
        JSON.stringify(attempt),
      );
  }

  async recent(): Promise<Array<Attempt & { label: string }>> {
    const rows = await this.database
      .prepare(
        `
      SELECT a.data, e.data AS exercise_data
      FROM attempts a JOIN exercises e ON e.id = a.exercise_id
      ORDER BY a.created_at DESC, a.${this.database.ordinal} DESC LIMIT 30
    `,
      )
      .all();
    return rows.map((row) => ({
      ...decodeRecord<Attempt>(row),
      label: decodeRecord<Exercise>({ data: row.exercise_data! }).label,
    }));
  }

  async roundAnswers(roundId: string): Promise<RoundAnswer[]> {
    const rows = await this.database
      .prepare(
        `SELECT a.id, a.correct FROM attempts a JOIN exercises e ON e.id=a.exercise_id
         WHERE ${this.database.jsonText('e.data', 'roundId')}=? AND a.skipped=0
         ORDER BY a.created_at, a.${this.database.ordinal}`,
      )
      .all(roundId);
    return rows.map((row) => ({
      attemptId: String(row.id),
      outcome: Number(row.correct) ? 'correct' : 'incorrect',
    }));
  }

  async activity(): Promise<DailyActivity[]> {
    return (
      await this.database
        .prepare(
          `
      SELECT day, COUNT(*) AS answers, SUM(correct) AS correct
      FROM attempts WHERE skipped = 0 GROUP BY day ORDER BY day DESC LIMIT 366
    `,
        )
        .all()
    ).map((row) => ({
      date: String(row.day),
      answers: Number(row.answers),
      correct: Number(row.correct),
    }));
  }

  async totals() {
    const row = (await this.database
      .prepare(
        `
      SELECT COUNT(*) AS answers FROM attempts WHERE skipped = 0
    `,
      )
      .get())!;
    return { answers: Number(row.answers) };
  }
}

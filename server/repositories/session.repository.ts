import type { Database } from '../db/database.js';
import type { Session, LessonPosition } from '../types/session.types.js';
import type { CourseSectionId } from '../../shared/types/course.js';

export class SessionRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(id: string): Promise<Session | null> {
    return await this.database.one('SELECT data FROM sessions WHERE id = ?', id);
  }

  async active(): Promise<Session | null> {
    return await this.database.one("SELECT data FROM sessions WHERE status <> 'ended' LIMIT 1");
  }

  async recent(): Promise<Session[]> {
    return await this.database.all('SELECT data FROM sessions ORDER BY started_at DESC LIMIT 12');
  }

  async save(session: Session) {
    await this.database
      .prepare(
        `
      INSERT INTO sessions (id, status, started_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data
    `,
      )
      .run(session.id, session.status, session.startedAt, JSON.stringify(session));
  }

  async lessonPosition(
    skillId: CourseSectionId,
    mode: Session['mode'],
  ): Promise<LessonPosition | null> {
    return this.database.one(
      'SELECT data FROM lesson_positions WHERE skill_id = ? AND mode = ?',
      skillId,
      mode,
    );
  }

  async saveLessonPosition(
    skillId: CourseSectionId,
    mode: Session['mode'],
    position: LessonPosition,
  ) {
    await this.database
      .prepare(
        `
      INSERT INTO lesson_positions(skill_id, mode, data) VALUES(?, ?, ?)
      ON CONFLICT(skill_id, mode) DO UPDATE SET data = excluded.data
    `,
      )
      .run(skillId, mode, JSON.stringify(position));
  }

  async recordPlayback(id: string, exerciseId: string, session: Session) {
    const inserted = await this.database
      .prepare(
        'INSERT INTO playback_receipts (id, exercise_id) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(id, exerciseId);
    if (Number(inserted.changes) > 0) {
      await this.save({ ...session, listened: session.listened + 1 });
    }
  }

  async recordDiagnostic(
    kind: 'tool' | 'audio' | 'connection',
    code: string,
    action: string | null,
    details: string[],
  ) {
    const boundedDetails = details.slice(0, 20).map((value) => value.slice(0, 160));
    await this.database
      .prepare('INSERT INTO diagnostics(at, kind, code, action, details) VALUES (?, ?, ?, ?, ?)')
      .run(
        this.now().toISOString(),
        kind,
        code.slice(0, 100),
        action,
        JSON.stringify(boundedDetails),
      );
    await this.database.exec(
      'DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 300)',
    );
  }

  async diagnostics() {
    return await this.database
      .prepare('SELECT at, kind, code, action, details FROM diagnostics ORDER BY id DESC LIMIT 80')
      .all();
  }
}

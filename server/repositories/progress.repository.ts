import { skills } from '../services/exercise/catalog.js';
import type { SkillId, CourseSectionId } from '../../shared/types/course.js';
import type { Database } from '../db/database.js';
import { emptyProgress } from '../services/progress.service.js';
import type { SkillProgress, PracticeRound } from '../types/progress.types.js';

export class ProgressRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async initialize() {
    await this.database
      .prepare('INSERT INTO course(id, skill_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING')
      .run(skills[0]!.id);
  }

  async getAll(): Promise<SkillProgress[]> {
    const saved = await this.database.all<SkillProgress>('SELECT data FROM progress');
    return skills.map(
      (skill) => saved.find((entry) => entry.skillId === skill.id) ?? emptyProgress(skill.id),
    );
  }

  async save(progress: SkillProgress) {
    await this.database
      .prepare(
        `
      INSERT INTO progress (skill_id, data) VALUES (?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET data = excluded.data
    `,
      )
      .run(progress.skillId, JSON.stringify(progress));
  }

  async round(skillId: SkillId): Promise<PracticeRound | null> {
    return await this.database.one('SELECT data FROM practice_rounds WHERE skill_id = ?', skillId);
  }

  async saveRound(round: PracticeRound) {
    await this.database
      .prepare(
        `
      INSERT INTO practice_rounds(skill_id, data) VALUES (?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET data = excluded.data
    `,
      )
      .run(round.skillId, JSON.stringify(round));
  }

  async selectedLesson(): Promise<SkillId> {
    const row = await this.database.prepare('SELECT skill_id FROM course WHERE id = 1').get();
    const skill = skills.find((item) => item.id === row?.skill_id);
    if (!skill) throw new Error('The saved course selection is invalid.');
    return skill.id;
  }

  async selectLesson(skillId: SkillId) {
    await this.database.prepare('UPDATE course SET skill_id = ? WHERE id = 1').run(skillId);
  }

  async completedLessons(): Promise<Array<{ skillId: string; completedAt: string }>> {
    return (
      await this.database.prepare('SELECT skill_id, completed_at FROM lesson_completions').all()
    )
      .filter((row) => skills.some((skill) => skill.id === row.skill_id))
      .map((row) => ({ skillId: String(row.skill_id), completedAt: String(row.completed_at) }));
  }

  async completeLesson(skillId: SkillId, completedAt: string): Promise<boolean> {
    const result = await this.database
      .prepare(
        'INSERT INTO lesson_completions(skill_id, completed_at) VALUES (?, ?) ON CONFLICT(skill_id) DO NOTHING',
      )
      .run(skillId, completedAt);
    return Number(result.changes) > 0;
  }

  async introductionSeen(skillId: CourseSectionId): Promise<boolean> {
    return Boolean(
      await this.database
        .prepare('SELECT 1 FROM lesson_introductions WHERE skill_id = ?')
        .get(skillId),
    );
  }

  async finishIntroduction(skillId: CourseSectionId, disposition: 'finished' | 'skipped') {
    await this.database
      .prepare(
        `
      INSERT INTO lesson_introductions(skill_id, disposition, finished_at) VALUES (?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE
      SET disposition = excluded.disposition, finished_at = excluded.finished_at
    `,
      )
      .run(skillId, disposition, this.now().toISOString());
  }
}

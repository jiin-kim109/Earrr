import { Database } from './connection.js';
import { SqliteDatabase } from './sqlite.js';
import { PostgresDatabase } from './postgres.js';
import { initializePostgres } from './postgres-schema.js';
import { AgentRepository } from '../repositories/agent.repository.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { GradingRepository } from '../repositories/grading.repository.js';
import { ExerciseRepository } from '../repositories/exercise.repository.js';
import { ProgressRepository } from '../repositories/progress.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { initializeSchema, migrateLegacyData } from './migrations.js';
export { Database, decodeRecord } from './connection.js';

export class Store {
  readonly sessions: SessionRepository;
  readonly exercises: ExerciseRepository;
  readonly attempts: GradingRepository;
  readonly progress: ProgressRepository;
  readonly user: UserRepository;
  readonly conversations: ConversationRepository;
  readonly agent: AgentRepository;
  private constructor(
    readonly db: Database,
    now: () => Date,
  ) {
    this.conversations = new ConversationRepository(db);
    this.user = new UserRepository(db);
    this.progress = new ProgressRepository(db, now);
    this.sessions = new SessionRepository(db, now);
    this.exercises = new ExerciseRepository(db);
    this.attempts = new GradingRepository(db);
    this.agent = new AgentRepository(db, now);
  }
  static async open(connection: string, now: () => Date = () => new Date()): Promise<Store> {
    const db = /^postgres(?:ql)?:\/\//.test(connection)
      ? new PostgresDatabase(connection)
      : new SqliteDatabase(connection);
    try {
      const version =
        db.kind === 'sqlite' ? await initializeSchema(db) : (await initializePostgres(db), 13);
      const store = new Store(db, now);
      if (db.kind === 'sqlite') await store.conversations.initialize();
      await store.user.initialize();
      await store.progress.initialize();
      if (db.kind === 'sqlite') await migrateLegacyData(store, version, now);
      return store;
    } catch (error) {
      await db.close();
      throw error;
    }
  }
  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
  async close() {
    await this.db.close();
  }
}

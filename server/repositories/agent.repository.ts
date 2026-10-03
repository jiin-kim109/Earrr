import { Database, decodeRecord } from '../db/database.js';
import type { ActionOutcome } from '../types/agent.types.js';

export class AgentRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCall(id: string): Promise<{ hash: string; payload: ActionOutcome } | null> {
    const row = await this.database
      .prepare('SELECT request_hash, data FROM tool_calls WHERE id = ?')
      .get(id);
    if (!row) return null;
    if (typeof row.request_hash !== 'string') throw new Error('Invalid stored tool invocation.');
    return { hash: row.request_hash, payload: decodeRecord<ActionOutcome>(row) };
  }

  async saveCall(id: string, hash: string, outcome: ActionOutcome) {
    await this.database
      .prepare('INSERT INTO tool_calls (id, request_hash, created_at, data) VALUES (?, ?, ?, ?)')
      .run(id, hash, this.now().toISOString(), JSON.stringify(outcome));
  }
}

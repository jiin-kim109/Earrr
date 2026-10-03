import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { Database } from './connection.js';
import type { Row, Statement, SqlValue } from './connection.js';

export function postgresParameters(sql: string): string {
  let parameter = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?/g, (token) =>
    token === '?' ? `$${++parameter}` : token,
  );
}

export class PostgresDatabase extends Database {
  readonly kind = 'postgres';
  readonly ordinal = 'seq';
  private readonly pool: Pool;
  private readonly scope = new AsyncLocalStorage<PoolClient>();
  constructor(connectionString: string) {
    super();
    this.pool = new Pool({
      connectionString,
      max: 8,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });
    this.pool.on('error', () => console.error('[earrr] An idle PostgreSQL connection was lost.'));
  }
  prepare(sql: string): Statement {
    const text = postgresParameters(sql);
    const query = (values: SqlValue[]) =>
      (this.scope.getStore() ?? this.pool).query<Row>(text, values);
    return {
      get: async (...values) => (await query(values)).rows[0],
      all: async (...values) => (await query(values)).rows,
      run: async (...values) => ({ changes: (await query(values)).rowCount ?? 0 }),
    };
  }
  async exec(sql: string) {
    await (this.scope.getStore() ?? this.pool).query(sql);
  }
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.scope.getStore()) return await work();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The app has one player. Match SQLite's single-writer ordering across server instances.
      await client.query('SELECT pg_advisory_xact_lock(1782982514)');
      const result = await this.scope.run(client, work);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

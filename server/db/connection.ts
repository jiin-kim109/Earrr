export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;
export interface Statement {
  get(...values: SqlValue[]): Promise<Row | undefined>;
  all(...values: SqlValue[]): Promise<Row[]>;
  run(...values: SqlValue[]): Promise<{ changes: number | bigint }>;
}

export function decodeRecord<T>(row: Row): T {
  if (typeof row.data !== 'string') throw new Error('A database record is missing its payload.');
  const value: unknown = JSON.parse(row.data);
  if (!value || typeof value !== 'object') throw new Error('A database record is invalid.');
  return value as T;
}

export abstract class Database {
  abstract readonly kind: 'sqlite' | 'postgres';
  abstract readonly ordinal: 'rowid' | 'seq';
  abstract prepare(sql: string): Statement;
  abstract exec(sql: string): Promise<void>;
  abstract transaction<T>(work: () => T | Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  async one<T>(query: string, ...params: SqlValue[]): Promise<T | null> {
    const row = await this.prepare(query).get(...params);
    return row ? decodeRecord<T>(row) : null;
  }
  async all<T>(query: string, ...params: SqlValue[]): Promise<T[]> {
    return (await this.prepare(query).all(...params)).map((row) => decodeRecord<T>(row));
  }
  jsonText(column: string, key: string): string {
    if (!/^\w+(?:\.\w+)?$/.test(column) || !/^\w+$/.test(key))
      throw new Error('Invalid JSON field reference.');
    return this.kind === 'sqlite'
      ? `json_extract(${column}, '$.${key}')`
      : `(${column}::jsonb ->> '${key}')`;
  }
}

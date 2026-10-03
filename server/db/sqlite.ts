import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from './connection.js';
import type { Row, Statement } from './connection.js';

export class SqliteDatabase extends Database {
  readonly kind = 'sqlite';
  readonly ordinal = 'rowid';
  private readonly connection: DatabaseSync;
  private readonly scope = new AsyncLocalStorage<{
    transaction: boolean;
    active: boolean;
    dirty: boolean;
  }>();
  private beforeCommit:
    | (() => Promise<{ committed: () => void; rolledBack: () => void } | void>)
    | null = null;
  private queue = Promise.resolve();
  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
  }
  private async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.scope.getStore()?.active) return await work();
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const scope = { transaction: false, active: true, dirty: false };
    try {
      return await this.scope.run(scope, work);
    } finally {
      scope.active = false;
      release();
    }
  }
  prepare(sql: string): Statement {
    return {
      get: (...values) =>
        this.exclusive(() => this.connection.prepare(sql).get(...values) as Row | undefined),
      all: (...values) =>
        this.exclusive(() => this.connection.prepare(sql).all(...values) as Row[]),
      run: (...values) =>
        this.exclusive(() => {
          const result = this.connection.prepare(sql).run(...values);
          if (result.changes) this.scope.getStore()!.dirty = true;
          return result;
        }),
    };
  }
  async exec(sql: string) {
    await this.exclusive(() => {
      this.connection.exec(sql);
      if (!/^\s*(?:PRAGMA|SELECT)\b/i.test(sql)) this.scope.getStore()!.dirty = true;
    });
  }
  onBeforeCommit(
    callback: () => Promise<{ committed: () => void; rolledBack: () => void } | void>,
  ) {
    this.beforeCommit = callback;
  }
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const scope = this.scope.getStore()!;
      if (scope.transaction) return await work();
      this.connection.exec('BEGIN IMMEDIATE');
      scope.transaction = true;
      const previousDirty = scope.dirty;
      scope.dirty = false;
      let committed = false;
      let prepared: { committed: () => void; rolledBack: () => void } | void = undefined;
      try {
        const result = await work();
        prepared = scope.dirty && this.beforeCommit ? await this.beforeCommit() : undefined;
        this.connection.exec('COMMIT');
        committed = true;
        prepared?.committed();
        return result;
      } catch (error) {
        if (!committed) {
          try {
            this.connection.exec('ROLLBACK');
          } finally {
            prepared?.rolledBack();
          }
        }
        throw error;
      } finally {
        scope.transaction = false;
        scope.dirty = previousDirty;
      }
    });
  }
  async close() {
    await this.exclusive(() => {
      if (this.connection.isOpen) this.connection.close();
    });
  }
}

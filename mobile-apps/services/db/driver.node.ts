/**
 * better-sqlite3 driver (tests/CI only — never imported by app code).
 * Mirrors the expo-sqlite semantics exactly so the same SQL behaves the same.
 */
import Database from 'better-sqlite3';
import type { SqlValue, SqliteDriver, StatementResult } from './driver';

export class NodeSqliteDriver implements SqliteDriver {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlValue[] = []): StatementResult {
    const result = this.db.prepare(sql).run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid != null ? Number(result.lastInsertRowid) : null,
    };
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getUserVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }) ?? 0);
  }

  setUserVersion(version: number): void {
    this.db.pragma(`user_version = ${Math.trunc(version)}`);
  }

  close(): void {
    this.db.close();
  }
}

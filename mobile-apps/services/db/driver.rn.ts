/**
 * expo-sqlite driver (production).
 */
import * as SQLite from 'expo-sqlite';
import type { SqlValue, SqliteDriver, StatementResult } from './driver';

export class ExpoSqliteDriver implements SqliteDriver {
  private db: SQLite.SQLiteDatabase;

  private constructor(db: SQLite.SQLiteDatabase) {
    this.db = db;
  }

  static async open(name = 'pocket-diary.db'): Promise<ExpoSqliteDriver> {
    const db = await SQLite.openDatabaseAsync(name, { useNewConnection: false });
    await db.execSync('PRAGMA journal_mode = WAL;');
    await db.execSync('PRAGMA foreign_keys = OFF;');
    return new ExpoSqliteDriver(db);
  }

  exec(sql: string): void {
    this.db.execSync(sql);
  }

  run(sql: string, params: SqlValue[] = []): StatementResult {
    const result = this.db.runSync(sql, params);
    return {
      changes: result.changes,
      lastInsertRowid:
        typeof result.lastInsertRowId === 'number' || typeof result.lastInsertRowId === 'bigint'
          ? Number(result.lastInsertRowId)
          : null,
    };
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return this.db.getAllSync(sql, params) as T[];
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.db.getFirstSync(sql, params) as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    let result!: T;
    this.db.withTransactionSync(() => {
      result = fn();
    });
    return result;
  }

  getUserVersion(): number {
    const row = this.db.getFirstSync('PRAGMA user_version') as { user_version?: number | bigint } | null;
    return Number(row?.user_version ?? 0);
  }

  setUserVersion(version: number): void {
    this.db.execSync(`PRAGMA user_version = ${Math.trunc(version)};`);
  }

  close(): void {
    this.db.closeSync();
  }
}

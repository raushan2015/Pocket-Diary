/**
 * SQLite driver abstraction.
 *
 * The whole domain layer (repositories, outbox, sync engine) depends on this
 * interface only. Production binds `ExpoSqliteDriver` (expo-sqlite, WAL);
 * tests bind `NodeSqliteDriver` (better-sqlite3) so every SQL code path,
 * migration and persistence guarantee runs in CI without a device.
 *
 * Both drivers are synchronous-by-design: expo-sqlite exposes a synchronous
 * API, and the outbox contract requires commit-before-return semantics
 * (a mutation is durable the moment the function returns).
 */

export type SqlValue = string | number | null;

export interface StatementResult {
  changes: number;
  lastInsertRowid: number | null;
}

export interface SqliteDriver {
  /** Execute SQL (possibly multiple statements). No parameters. */
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): StatementResult;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): T | undefined;
  /**
   * Runs `fn` inside a transaction. Implementations must guarantee:
   * all-or-nothing on throw, and an error if called while another transaction
   * of the same connection is active (programming error, not nesting).
   */
  transaction<T>(fn: () => T): T;
  getUserVersion(): number;
  setUserVersion(version: number): void;
  close(): void;
}

export const boolInt = (b: boolean): number => (b ? 1 : 0);

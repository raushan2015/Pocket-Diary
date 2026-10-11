import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';

export interface DatabaseContext {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
}

export function createDatabase(dbPath?: string): DatabaseContext {
  const resolvedPath = dbPath ?? process.env.DATABASE_PATH ?? path.resolve(process.cwd(), 'data/memo_manager.db');

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const sqlite = new Database(resolvedPath);

  // Apply required SQLite operational pragmas
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('cache_size = -64000');

  // Ensure tables and indexes are initialized
  runMigrations(sqlite);

  const db = drizzle(sqlite, { schema });

  return { sqlite, db };
}

let defaultCtx: DatabaseContext | null = null;

export function getDatabase(): DatabaseContext {
  if (!defaultCtx) {
    defaultCtx = createDatabase();
  }
  return defaultCtx;
}

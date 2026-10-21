/**
 * Database initialization & migration runner for local SQLite.
 */
import type { SqliteDriver } from './driver';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export function initializeDatabase(driver: SqliteDriver): void {
  const currentVersion = driver.getUserVersion();
  if (currentVersion < SCHEMA_VERSION) {
    driver.transaction(() => {
      driver.exec(SCHEMA_SQL);
      driver.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
      driver.setUserVersion(SCHEMA_VERSION);
    });
  }
}

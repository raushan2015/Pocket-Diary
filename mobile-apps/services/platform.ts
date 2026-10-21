/**
 * Platform service factory: initializes SQLite, PrefsStore, SecureStore, and HttpTransport.
 */
import { ExpoSqliteDriver } from './db/driver.rn';
import { initializeDatabase } from './db/database';
import { AsyncStorageStore, ExpoSecureStore } from './storage/kv.rn';
import { FetchTransport } from './api/transport.rn';
import type { SqliteDriver } from './db/driver';
import type { PrefsStore, SecureStore } from './storage/kv';
import type { HttpTransport } from './api/transport';

export interface PlatformServices {
  db: SqliteDriver;
  prefs: PrefsStore;
  secure: SecureStore;
  transport: HttpTransport;
}

let platformServicesPromise: Promise<PlatformServices> | null = null;

export async function getPlatformServices(): Promise<PlatformServices> {
  if (platformServicesPromise) return platformServicesPromise;

  platformServicesPromise = (async () => {
    const db = await ExpoSqliteDriver.open();
    initializeDatabase(db);
    const prefs = new AsyncStorageStore();
    const secure = new ExpoSecureStore();
    const transport = new FetchTransport();

    return { db, prefs, secure, transport };
  })();

  return platformServicesPromise;
}

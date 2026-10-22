/**
 * Platform service factory: initializes SQLite, PrefsStore, SecureStore,
 * HttpTransport, attachment cache, and the reminder scheduler.
 */
import { ExpoSqliteDriver } from './db/driver.rn';
import { initializeDatabase } from './db/database';
import { AsyncStorageStore, ExpoSecureStore } from './storage/kv.rn';
import { FetchTransport } from './api/transport.rn';
import { RnAttachmentCache } from './attachments/cache.rn';
import { ExpoReminderScheduler } from '@/features/reminders/notifications.rn';
import type { SqliteDriver } from './db/driver';
import type { PrefsStore, SecureStore } from './storage/kv';
import type { HttpTransport } from './api/transport';
import type { AttachmentCache } from './attachments/cache';
import type { ReminderScheduler } from '@/features/reminders/notifications';

export interface PlatformServices {
  db: SqliteDriver;
  prefs: PrefsStore;
  secure: SecureStore;
  transport: HttpTransport;
  attachments: AttachmentCache;
  reminders: ReminderScheduler;
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

    return {
      db,
      prefs,
      secure,
      transport,
      attachments: new RnAttachmentCache(),
      reminders: new ExpoReminderScheduler(),
    };
  })();

  return platformServicesPromise;
}

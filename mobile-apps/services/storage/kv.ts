/**
 * Storage abstractions.
 *
 * Two interfaces, deliberately distinct:
 *
 *  - `SecureStore` — for SECRETS (session cookie, anything credential-like).
 *    Production: expo-secure-store (iOS Keychain / Android encrypted
 *    keystore-backed). Tests: in-memory map. Nothing sensitive may ever live
 *    in AsyncStorage or SQLite.
 *
 *  - `PrefsStore` — for non-secret preferences (theme choice, active
 *    workspace per account, onboarding acknowledgment). Production:
 *    AsyncStorage-backed (documents dir, OS-standard app storage).
 *    Tests: in-memory map.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Lists keys with a prefix (used for account discovery / wipes). */
  keys(prefix: string): Promise<string[]>;
}

export type PrefsStore = KeyValueStore;
export type SecureStore = KeyValueStore;

/** Simple in-memory implementation (tests + SSR-safe defaults). */
export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** JSON helpers on top of any KeyValueStore. */
export async function readJson<T>(store: KeyValueStore, key: string): Promise<T | null> {
  const raw = await store.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(store: KeyValueStore, key: string, value: unknown): Promise<void> {
  await store.set(key, JSON.stringify(value));
}

/**
 * React Native platform implementations of the storage interfaces.
 * Only this file (and platform files below) import native modules; the rest
 * of the codebase depends on the interfaces from services/storage/kv.ts.
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValueStore } from './kv';

/**
 * Secrets store backed by expo-secure-store (Keychain / Keystore).
 * Keys must be reasonably short (Keychain service-name limits).
 */
export class ExpoSecureStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  async delete(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
  }
  async keys(prefix: string): Promise<string[]> {
    // SecureStore has no enumeration API; the app keeps an index key per
    // server (see SessionManager) so listing is by known prefix, and this
    // method is only used for the indexed keys.
    throw new Error('SecureStore.keys is not supported; account indexes are maintained explicitly.');
  }
}

/** Preferences store backed by AsyncStorage (non-secret values only). */
export class AsyncStorageStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  }
  async set(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  }
  async delete(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  }
  async keys(prefix: string): Promise<string[]> {
    const all = await AsyncStorage.getAllKeys();
    return all.filter((k) => k.startsWith(prefix));
  }
}

/**
 * Identifier generation. Production uses expo-crypto's randomUUID via
 * `makeExpoIdGen`; tests inject deterministic generators. All domain code
 * receives the generator as a dependency, so nothing outside this module
 * touches a global.
 */

export type IdGen = () => string;

/** RFC4122-ish v4 UUID without native deps (Math.random-based fallback). */
function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for exotic runtimes without crypto.randomUUID.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Default generator used by the app (Node in tests also has randomUUID). */
export const defaultIdGen: IdGen = randomUuid;
export const generateLocalId = defaultIdGen;

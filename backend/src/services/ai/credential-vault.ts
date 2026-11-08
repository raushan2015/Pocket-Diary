/**
 * AI credential vault — encrypts user-supplied provider API keys at rest.
 *
 * Design (handoff §3):
 *  - AES-256-GCM authenticated encryption with a random 12-byte nonce per
 *    record and a 16-byte auth tag. Additional authenticated data (AAD)
 *    binds every ciphertext to its (key version, user, config, provider),
 *    so a ciphertext lifted from one row can never be decrypted as another.
 *  - The master secret comes from AI_CREDENTIAL_ENCRYPTION_KEY (64 hex chars
 *    = 32 bytes), stored OUTSIDE SQLite and outside Git (.env / container
 *    secret). Rotation: the variable accepts a comma-separated list of keys;
 *    the FIRST key encrypts new records, ALL keys are tried for decryption
 *    (the per-record `encryption_key_version` selects the candidate first).
 *  - A server without a valid key must NOT crash unrelated note-taking:
 *    `isVaultConfigured()` is false and AI credential endpoints answer 503
 *    with operator guidance while the rest of the app keeps working.
 *  - The plaintext key is decrypted only inside service execution and is
 *    never returned by any API, logged, or placed into prompts.
 */
import crypto from 'node:crypto';

const VAULT_VERSION = 1;
const AAD_PREFIX = 'pd-ai-credential';

export class AiVaultError extends Error {
  statusCode = 500;
  constructor(message = 'AI credential vault is not available') {
    super(message);
    this.name = 'AiVaultError';
  }
}

export class AiVaultConfigError extends AiVaultError {
  statusCode = 503;
  operatorHint: string;
  constructor(operatorHint: string) {
    super('AI provider credentials are disabled: AI_CREDENTIAL_ENCRYPTION_KEY is not configured.');
    this.name = 'AiVaultConfigError';
    this.operatorHint = operatorHint;
  }
}

export interface EncryptedSecret {
  ciphertext: string; // base64
  nonce: string; // base64
  authTag: string; // base64
  keyVersion: number;
}

interface VaultKeys {
  /** Keys indexed by version (1-based). First entry is the active encryption key. */
  byVersion: Map<number, Buffer>;
  activeVersion: number;
}

let cachedKeys: VaultKeys | null = null;
let cachedSource: string | null = null;

function parseKeys(source: string | undefined): VaultKeys | null {
  if (!source) return null;
  const parts = source
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const byVersion = new Map<number, Buffer>();
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    let buf: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      buf = Buffer.from(raw, 'hex');
    } else if (/^[A-Za-z0-9+/=_-]{43}$/.test(raw)) {
      // Base64url/base64 32-byte secret also accepted for operator convenience.
      buf = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } else {
      return null; // malformed key material — treat as unconfigured (fail safe)
    }
    if (buf.length !== 32) return null;
    byVersion.set(i + 1, buf);
  }
  if (byVersion.size === 0) return null;
  return { byVersion, activeVersion: 1 };
}

function getVaultKeys(): VaultKeys | null {
  const source = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  if (!source) return null;
  if (cachedKeys && cachedSource === source) return cachedKeys;
  const parsed = parseKeys(source);
  cachedSource = source;
  cachedKeys = parsed;
  return parsed;
}

/** True when the server has usable key material. False = AI credentials disabled, app otherwise unaffected. */
export function isVaultConfigured(): boolean {
  return getVaultKeys() !== null;
}

/** Operator-facing hint for 503 responses (contains no secret material). */
export function vaultOperatorHint(): string {
  return [
    'Set AI_CREDENTIAL_ENCRYPTION_KEY to a high-entropy secret (64 hex characters).',
    'Generate one with: openssl rand -hex 32',
    'Store it outside SQLite and outside version control (e.g. the deployment .env or container secret).',
    'Until it is set, AI provider configurations are disabled; note-taking is unaffected.',
  ].join(' ');
}

function assertConfigured(): VaultKeys {
  const keys = getVaultKeys();
  if (!keys) {
    throw new AiVaultConfigError(vaultOperatorHint());
  }
  return keys;
}

/**
 * Encrypt a provider API key for storage.
 * AAD binds the record to (vault version, key version, user, config, provider).
 */
export function encryptSecret(userId: string, configId: string, provider: string, plaintext: string): EncryptedSecret {
  const keys = assertConfigured();
  const key = keys.byVersion.get(keys.activeVersion)!;
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(`${AAD_PREFIX}:${VAULT_VERSION}:${keys.activeVersion}:${userId}:${configId}:${provider}`);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: keys.activeVersion,
  };
}

/**
 * Decrypt a stored provider API key. Throws AiVaultError when the vault is
 * unconfigured, the key version is unknown, or authentication fails
 * (wrong key, tampered record, or AAD mismatch).
 */
export function decryptSecret(
  userId: string,
  configId: string,
  provider: string,
  record: { keyCiphertext: string; keyNonce: string; keyAuthTag: string; encryptionKeyVersion: number }
): string {
  const keys = assertConfigured();
  const key = keys.byVersion.get(record.encryptionKeyVersion);
  if (!key) {
    throw new AiVaultError(
      `Credential was encrypted with key version ${record.encryptionKeyVersion}, which is not present in AI_CREDENTIAL_ENCRYPTION_KEY. The user must re-enter the key.`
    );
  }
  const aad = Buffer.from(`${AAD_PREFIX}:${VAULT_VERSION}:${record.encryptionKeyVersion}:${userId}:${configId}:${provider}`);
  let decipher: crypto.DecipherGCM;
  try {
    decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.keyNonce, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(record.keyAuthTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.keyCiphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new AiVaultError('Stored AI credential failed authentication (wrong server key or corrupted record). The user must re-enter the key.');
  }
}

/** Masked display form for API responses: shows only the final 4 characters. */
export function maskKeyLast4(plaintext: string): string {
  const trimmed = plaintext.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : '****';
}

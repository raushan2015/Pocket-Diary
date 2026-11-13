/**
 * AI provider configuration service (BYOK, handoff §3).
 *
 *  - Configs are strictly user-owned; every query filters by the
 *    authenticated user id.
 *  - API keys are encrypted at rest (credential-vault) and are NEVER
 *    returned by any API response, log line or error message — only a
 *    masked `keyLast4`.
 *  - One default per user, enforced transactionally.
 *  - Multiple named configurations per provider are supported.
 */
import crypto from 'node:crypto';
import type { DatabaseContext } from '../../db/index.js';
import {
  encryptSecret,
  decryptSecret,
  maskKeyLast4,
  isVaultConfigured,
  vaultOperatorHint,
  AiVaultConfigError,
  AiVaultError,
} from './credential-vault.js';
import { getAdapter, PROVIDER_IDS, PROVIDER_LABELS, isProviderId } from './registry.js';
import type { ProviderId } from './provider-types.js';

export class AiConfigError extends Error {
  statusCode: number;
  code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = 'AiConfigError';
  }
}

export interface ProviderConfigDto {
  id: string;
  provider: ProviderId;
  label: string;
  modelId: string;
  keyLast4: string;
  hasKey: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

const MAX_CONFIGS_PER_USER = 20;

export function isKeylessProvider(provider: string): boolean {
  return provider === 'antigravity_cli' || provider === 'ollama';
}

function rowToDto(row: any): ProviderConfigDto {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    modelId: row.model_id,
    keyLast4: row.key_last4 ?? '',
    hasKey: !isKeylessProvider(row.provider),
    isDefault: Boolean(row.is_default),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function listConfigs(dbCtx: DatabaseContext, userId: string): ProviderConfigDto[] {
  const rows = dbCtx.sqlite
    .prepare('SELECT * FROM ai_provider_configs WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC')
    .all(userId);
  return rows.map(rowToDto);
}

function assertVaultAvailable(): void {
  if (!isVaultConfigured()) {
    throw new AiConfigError('vault_unconfigured', 'AI provider credentials are disabled on this server. Ask the operator to set AI_CREDENTIAL_ENCRYPTION_KEY.', 503);
  }
}

export function createConfig(
  dbCtx: DatabaseContext,
  userId: string,
  input: { provider: string; label: string; modelId: string; apiKey?: string; isDefault?: boolean }
): ProviderConfigDto {
  if (!isProviderId(input.provider)) {
    throw new AiConfigError('invalid_provider', `Provider must be one of: ${PROVIDER_IDS.join(', ')}`);
  }
  const keyless = isKeylessProvider(input.provider);
  if (!keyless) {
    assertVaultAvailable();
  }
  const label = String(input.label ?? '').trim().slice(0, 80) || PROVIDER_LABELS[input.provider];
  const modelId = String(input.modelId ?? '').trim().slice(0, 160);
  if (!modelId) throw new AiConfigError('invalid_model', 'A model id is required');
  let apiKey = String(input.apiKey ?? '').trim();
  if (keyless) {
    if (!apiKey) {
      apiKey = input.provider === 'antigravity_cli' ? 'oauth-cli' : 'local-cli';
    }
  } else if (apiKey.length < 8 || apiKey.length > 4096) {
    throw new AiConfigError('invalid_key', 'API key must be between 8 and 4096 characters');
  }

  const count = dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_provider_configs WHERE user_id = ?').get(userId) as { n: number };
  if (Number(count.n) >= MAX_CONFIGS_PER_USER) {
    throw new AiConfigError('too_many_configs', `At most ${MAX_CONFIGS_PER_USER} provider configurations are allowed`);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const encrypted = isVaultConfigured()
    ? encryptSecret(userId, id, input.provider, apiKey)
    : { ciphertext: '', nonce: '', authTag: '', keyVersion: 0 };
  const last4 = keyless
    ? (input.provider === 'antigravity_cli' ? 'OAuth' : 'Local')
    : maskKeyLast4(apiKey);

  dbCtx.db.transaction(() => {
    // Only one default per user: demote others when this one becomes default,
    // or automatically when it is the first configuration.
    const makeDefault = input.isDefault || Number(count.n) === 0;
    if (makeDefault) {
      dbCtx.sqlite.prepare('UPDATE ai_provider_configs SET is_default = 0 WHERE user_id = ?').run(userId);
    }
    dbCtx.sqlite
      .prepare(
        `INSERT INTO ai_provider_configs
         (id, user_id, provider, label, model_id, key_ciphertext, key_nonce, key_auth_tag, encryption_key_version, key_last4, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, userId, input.provider, label, modelId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion, last4, makeDefault ? 1 : 0, now, now);
  });

  const row = dbCtx.sqlite.prepare('SELECT * FROM ai_provider_configs WHERE id = ? AND user_id = ?').get(id, userId);
  return rowToDto(row);
}

function getOwnedConfig(dbCtx: DatabaseContext, configId: string, userId: string): any {
  const row = dbCtx.sqlite.prepare('SELECT * FROM ai_provider_configs WHERE id = ? AND user_id = ?').get(configId, userId);
  if (!row) throw new AiConfigError('not_found', 'Provider configuration not found', 404);
  return row;
}

export function updateConfig(
  dbCtx: DatabaseContext,
  configId: string,
  userId: string,
  input: { label?: string; modelId?: string; apiKey?: string; isDefault?: boolean }
): ProviderConfigDto {
  const row = getOwnedConfig(dbCtx, configId, userId);
  if (!isKeylessProvider(row.provider)) {
    assertVaultAvailable();
  }
  const now = Date.now();

  let { key_ciphertext: ciphertext, key_nonce: nonce, key_auth_tag: authTag, encryption_key_version: keyVersion, key_last4: last4 } = row;
  if (input.apiKey !== undefined && (!isKeylessProvider(row.provider) || String(input.apiKey ?? '').trim().length > 0)) {
    const apiKey = String(input.apiKey ?? '').trim();
    if (!isKeylessProvider(row.provider) && (apiKey.length < 8 || apiKey.length > 4096)) {
      throw new AiConfigError('invalid_key', 'API key must be between 8 and 4096 characters');
    }
    if (isVaultConfigured()) {
      const encrypted = encryptSecret(userId, configId, row.provider, apiKey);
      ciphertext = encrypted.ciphertext;
      nonce = encrypted.nonce;
      authTag = encrypted.authTag;
      keyVersion = encrypted.keyVersion;
    }
    last4 = isKeylessProvider(row.provider) ? last4 : maskKeyLast4(apiKey);
  }

  dbCtx.db.transaction(() => {
    if (input.isDefault === true) {
      dbCtx.sqlite.prepare('UPDATE ai_provider_configs SET is_default = 0 WHERE user_id = ?').run(userId);
    }
    dbCtx.sqlite
      .prepare(
        `UPDATE ai_provider_configs SET label = ?, model_id = ?, key_ciphertext = ?, key_nonce = ?, key_auth_tag = ?, encryption_key_version = ?, key_last4 = ?, is_default = ?, updated_at = ? WHERE id = ? AND user_id = ?`
      )
      .run(
        input.label !== undefined ? String(input.label).trim().slice(0, 80) || row.label : row.label,
        input.modelId !== undefined ? String(input.modelId).trim().slice(0, 160) || row.model_id : row.model_id,
        ciphertext,
        nonce,
        authTag,
        keyVersion,
        last4,
        input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : row.is_default,
        now,
        configId,
        userId
      );
  });

  return rowToDto(getOwnedConfig(dbCtx, configId, userId));
}

export function deleteConfig(dbCtx: DatabaseContext, configId: string, userId: string): void {
  const row = getOwnedConfig(dbCtx, configId, userId);
  dbCtx.db.transaction(() => {
    dbCtx.sqlite.prepare('DELETE FROM ai_provider_configs WHERE id = ? AND user_id = ?').run(configId, userId);
    if (row.is_default) {
      // Promote the most recently updated remaining config to default.
      dbCtx.sqlite
        .prepare(
          'UPDATE ai_provider_configs SET is_default = 1 WHERE id = (SELECT id FROM ai_provider_configs WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1)'
        )
        .run(userId);
    }
    // Conversations that referenced this config fall back to the user default at send time.
    dbCtx.sqlite.prepare('UPDATE ai_conversations SET last_provider_config_id = NULL WHERE last_provider_config_id = ?').run(configId);
  });
}

export function setDefault(dbCtx: DatabaseContext, configId: string, userId: string): ProviderConfigDto {
  getOwnedConfig(dbCtx, configId, userId);
  dbCtx.db.transaction(() => {
    dbCtx.sqlite.prepare('UPDATE ai_provider_configs SET is_default = 0 WHERE user_id = ?').run(userId);
    dbCtx.sqlite.prepare('UPDATE ai_provider_configs SET is_default = 1 WHERE id = ?').run(configId);
  });
  return rowToDto(getOwnedConfig(dbCtx, configId, userId));
}

/** Decrypt for adapter use ONLY (never returned to a client). */
export function decryptConfigKey(dbCtx: DatabaseContext, row: any, userId: string): string {
  if (Number(row.encryption_key_version) === 0 && isKeylessProvider(row.provider)) {
    return '';
  }
  return decryptSecret(userId, row.id, row.provider, {
    keyCiphertext: row.key_ciphertext,
    keyNonce: row.key_nonce,
    keyAuthTag: row.key_auth_tag,
    encryptionKeyVersion: row.encryption_key_version,
  });
}

export function getOwnedConfigRow(dbCtx: DatabaseContext, configId: string, userId: string): any {
  return getOwnedConfig(dbCtx, configId, userId);
}

export function vaultStatus(): { configured: boolean; hint?: string } {
  if (isVaultConfigured()) return { configured: true };
  return { configured: false, hint: vaultOperatorHint() };
}

export { AiVaultConfigError, AiVaultError };

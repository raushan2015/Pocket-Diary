/**
 * AI credential vault + provider configuration tests (handoff §3):
 *  - AES-256-GCM round trip, AAD binding, tamper rejection,
 *  - missing/malformed key disables AI credentials without crashing the app,
 *  - provider CRUD authorization (owner-only), one-default invariant,
 *  - keys NEVER appear in any API response, and masked display only,
 *  - connection test + model listing against a live mock provider.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import {
  encryptSecret,
  decryptSecret,
  isVaultConfigured,
  AiVaultError,
} from '../src/services/ai/credential-vault.js';
import { MockProviderServer, TEST_ENCRYPTION_KEY } from './helpers/ai-mock-provider.js';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

describe('AI credential vault', () => {
  beforeAll(() => {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });
  afterAll(() => {
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  });

  it('round-trips a secret and never stores plaintext', () => {
    const secret = 'sk-test-abcdef1234567890';
    const encrypted = encryptSecret('user-1', 'cfg-1', 'openai', secret);
    expect(encrypted.ciphertext).not.toContain('sk-test');
    expect(JSON.stringify(encrypted)).not.toContain(secret);
    const decrypted = decryptSecret('user-1', 'cfg-1', 'openai', {
      keyCiphertext: encrypted.ciphertext,
      keyNonce: encrypted.nonce,
      keyAuthTag: encrypted.authTag,
      encryptionKeyVersion: encrypted.keyVersion,
    });
    expect(decrypted).toBe(secret);
  });

  it('binds ciphertext to user/config/provider via AAD — cross-record decryption fails', () => {
    const secret = 'sk-test-abcdef1234567890';
    const encrypted = encryptSecret('user-1', 'cfg-1', 'openai', secret);
    // Wrong user
    expect(() =>
      decryptSecret('user-2', 'cfg-1', 'openai', { keyCiphertext: encrypted.ciphertext, keyNonce: encrypted.nonce, keyAuthTag: encrypted.authTag, encryptionKeyVersion: encrypted.keyVersion })
    ).toThrow(AiVaultError);
    // Wrong provider
    expect(() =>
      decryptSecret('user-1', 'cfg-1', 'gemini', { keyCiphertext: encrypted.ciphertext, keyNonce: encrypted.nonce, keyAuthTag: encrypted.authTag, encryptionKeyVersion: encrypted.keyVersion })
    ).toThrow(AiVaultError);
    // Tampered ciphertext
    const tampered = Buffer.from(encrypted.ciphertext, 'base64');
    tampered[0] ^= 0xff;
    expect(() =>
      decryptSecret('user-1', 'cfg-1', 'openai', { keyCiphertext: tampered.toString('base64'), keyNonce: encrypted.nonce, keyAuthTag: encrypted.authTag, encryptionKeyVersion: encrypted.keyVersion })
    ).toThrow(AiVaultError);
  });

  it('reports unconfigured when the key is missing or malformed (fail-safe)', () => {
    const prev = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    try {
      delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
      expect(isVaultConfigured()).toBe(false);
      process.env.AI_CREDENTIAL_ENCRYPTION_KEY = 'not-a-valid-key';
      expect(isVaultConfigured()).toBe(false);
      expect(() => encryptSecret('u', 'c', 'openai', 'secret')).toThrow();
    } finally {
      if (prev === undefined) delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.AI_CREDENTIAL_ENCRYPTION_KEY = prev;
    }
  });
});

describe('AI provider configuration API', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let mock: MockProviderServer;
  let baseUrl: string;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let bob: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    mock = new MockProviderServer();
    baseUrl = await mock.listen();
    process.env.AI_DEEPSEEK_BASE_URL = baseUrl;
    process.env.AI_OPENAI_BASE_URL = baseUrl;
  });

  afterAll(async () => {
    delete process.env.AI_DEEPSEEK_BASE_URL;
    delete process.env.AI_OPENAI_BASE_URL;
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    await mock.close();
  });

  const setup = async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    alice = await createTestUser(app, 'alice-ai@example.com', 'Alice AI');
    bob = await createTestUser(app, 'bob-ai@example.com', 'Bob AI');
  };

  const teardown = async () => {
    await app.close();
    dbCtx.sqlite.close();
    mock.clearRecorded();
  };

  it('creates a config, masks the key in responses, and enforces one default', async () => {
    await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'deepseek', label: 'Work key', modelId: 'deepseek-chat', apiKey: 'sk-mock-alice-key-0001', isDefault: true },
      });
      expect(res.statusCode).toBe(201);
      const config = res.json().config;
      expect(config.provider).toBe('deepseek');
      expect(config.keyLast4).toBe('0001');
      // The plaintext key must never appear anywhere in the response.
      expect(res.body).not.toContain('sk-mock-alice-key-0001');

      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'openai', label: 'Backup', modelId: 'gpt-4o-mini', apiKey: 'sk-mock-alice-key-0002' },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().config.isDefault).toBe(false); // first stays default

      const list = await app.inject({ method: 'GET', url: '/api/v1/ai/providers', headers: { cookie: alice.cookieHeader } });
      const configs = list.json().configs;
      expect(configs.length).toBe(2);
      expect(list.body).not.toContain('sk-mock-alice-key-0001');
      expect(list.body).not.toContain('sk-mock-alice-key-0002');
      expect(configs.filter((c: any) => c.isDefault).length).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('rejects signed-out access and cross-user access to provider configs', async () => {
    await setup();
    try {
      const anon = await app.inject({ method: 'GET', url: '/api/v1/ai/providers' });
      expect(anon.statusCode).toBe(401);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'deepseek', label: 'A', modelId: 'deepseek-chat', apiKey: 'sk-mock-alice-key-0003' },
      });
      const id = created.json().config.id;

      const bobGet = await app.inject({ method: 'PATCH', url: `/api/v1/ai/providers/${id}`, headers: { cookie: bob.cookieHeader }, payload: { label: 'Hacked' } });
      expect([403, 404]).toContain(bobGet.statusCode);
      const bobDelete = await app.inject({ method: 'DELETE', url: `/api/v1/ai/providers/${id}`, headers: { cookie: bob.cookieHeader } });
      expect([403, 404]).toContain(bobDelete.statusCode);
      const stillThere = dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_provider_configs WHERE id = ?').get(id) as { n: number };
      expect(stillThere.n).toBe(1);
    } finally {
      await teardown();
    }
  });

  it('stores the key encrypted in SQLite (no plaintext at rest)', async () => {
    await setup();
    try {
      await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'deepseek', label: 'A', modelId: 'deepseek-chat', apiKey: 'sk-mock-alice-very-secret-9999' },
      });
      const rows = dbCtx.sqlite.prepare('SELECT key_ciphertext, key_nonce, key_auth_tag, key_last4 FROM ai_provider_configs').all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].key_ciphertext).not.toContain('sk-mock');
      expect(JSON.stringify(rows[0])).not.toContain('very-secret-9999');
      expect(rows[0].key_last4).toBe('9999');
    } finally {
      await teardown();
    }
  });

  it('tests the connection against a live mock and reports auth failures safely', async () => {
    await setup();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'deepseek', label: 'A', modelId: 'mock-model-a', apiKey: 'sk-mock-ok-key-1234' },
      });
      const id = created.json().config.id;

      mock.behavior = {};
      const ok = await app.inject({ method: 'POST', url: `/api/v1/ai/providers/${id}/test`, headers: { cookie: alice.cookieHeader } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ok).toBe(true);

      mock.behavior = { status: 401 };
      const bad = await app.inject({ method: 'POST', url: `/api/v1/ai/providers/${id}/test`, headers: { cookie: alice.cookieHeader } });
      expect(bad.json().ok).toBe(false);
      expect(bad.body).not.toContain('sk-mock-ok-key-1234');
    } finally {
      await teardown();
    }
  });

  it('models-preview fetches the catalog for an unsaved key and persists nothing', async () => {
    await setup();
    try {
      mock.behavior = {};
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers/models-preview',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'deepseek', apiKey: 'sk-preview-transient-key-9876' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().models.map((m: any) => m.id)).toContain('mock-model-a');

      // No-key variant (public catalogs such as NVIDIA NIM): must not require
      // the apiKey field.
      const noKey = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers/models-preview',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'deepseek' },
      });
      expect(noKey.statusCode).toBe(200);
      expect(res.statusCode).toBe(200);
      expect(res.json().models.map((m: any) => m.id)).toContain('mock-model-a');
      // Nothing may be persisted: the configs table stays untouched and no
      // key material appears anywhere in storage.
      const rows = dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_provider_configs').get() as { n: number };
      expect(rows.n).toBe(0);
      const stored = JSON.stringify(dbCtx.sqlite.prepare('SELECT * FROM ai_provider_configs').all());
      expect(stored).not.toContain('sk-preview-transient-key-9876');
      // Auth required.
      const anon = await app.inject({ method: 'POST', url: '/api/v1/ai/providers/models-preview', payload: { provider: 'deepseek', apiKey: 'sk-x-12345678' } });
      expect(anon.statusCode).toBe(401);
    } finally {
      await teardown();
    }
  });

  it('lists models from the provider and rejects 503 when the vault is unconfigured', async () => {
    await setup();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers',
        headers: { cookie: alice.cookieHeader },
        payload: { provider: 'deepseek', label: 'A', modelId: 'mock-model-a', apiKey: 'sk-mock-models-1234' },
      });
      const id = created.json().config.id;

      mock.behavior = {};
      const models = await app.inject({ method: 'GET', url: `/api/v1/ai/providers/${id}/models`, headers: { cookie: alice.cookieHeader } });
      expect(models.statusCode).toBe(200);
      expect(models.json().models.map((m: any) => m.id)).toContain('mock-model-a');

      // Vault missing -> credential endpoints fail safe with 503, app still up.
      const prev = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
      delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
      const denied = await app.inject({ method: 'POST', url: '/api/v1/ai/providers', headers: { cookie: alice.cookieHeader }, payload: { provider: 'deepseek', label: 'x', modelId: 'm', apiKey: 'sk-abc-12345' } });
      expect(denied.statusCode).toBe(503);
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      if (prev === undefined) delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
      else process.env.AI_CREDENTIAL_ENCRYPTION_KEY = prev;
    } finally {
      await teardown();
    }
  });
});

// Prevent unused import warning for crypto in strict setups.
void crypto;

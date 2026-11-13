/**
 * Antigravity CLI (`agy`) integration & OAuth flow tests:
 *  - `extractAuthCode` accepts raw codes, callback URLs, and rejects invalid inputs
 *  - keyless `antigravity_cli` provider config works even without AI_CREDENTIAL_ENCRYPTION_KEY
 *  - interactive OAuth start -> code display -> submit -> status -> model listing -> logout
 *  - streaming chat via `antigravityCliAdapter` emits text deltas, usage, and stop reason
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { extractAuthCode, AntigravityCliError } from '../src/services/ai/antigravity-cli.service.js';
import { antigravityCliAdapter } from '../src/services/ai/providers/antigravity-cli.js';
import type { ProviderStreamEvent } from '../src/services/ai/provider-types.js';

const MOCK_AGY_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const args = process.argv.slice(2);
const home = process.env.HOME;
const tokenFile = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

if (args.includes('--version')) {
  process.stdout.write('0.9.99-mock\\n');
  process.exit(0);
}

if (args.includes('models')) {
  if (!fs.existsSync(tokenFile)) {
    process.stderr.write('Authentication required.\\n');
    process.exit(1);
  }
  process.stdout.write('Fetching available models...\\n');
  process.stdout.write('gemini-4-hydrogen-high   Gemini 4 Hydrogen High\\n');
  process.stdout.write('gemini-3.8-flash-high    Gemini 3.8 Flash High\\n');
  process.stdout.write('claude-sonnet-5-5-high   Claude Sonnet 5.5 High\\n');
  process.exit(0);
}

// Stream chat mode (-p "...")
const pIdx = args.indexOf('-p');
if (pIdx !== -1 && fs.existsSync(tokenFile)) {
  const promptText = args[pIdx + 1] || '';
  if (args.includes('--output-format')) {
    process.stdout.write(JSON.stringify({ event: 'init', session_id: 'mock-sess' }) + '\\n');
    process.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', text_delta: 'Hello from ' },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      event: 'step_update',
      step_update: {
        step_type: 'agent_response',
        text_delta: 'Antigravity!',
        usage: { input_tokens: 12, output_tokens: 5 },
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'Hello from Antigravity!',
        usage: { input_tokens: 12, output_tokens: 5 },
      },
    }) + '\\n');
  } else {
    process.stdout.write('OK (' + promptText.length + ')\\n');
  }
  process.exit(0);
}

// Interactive OAuth mode (when unauthenticated)
if (!fs.existsSync(tokenFile)) {
  process.stdout.write('Please visit the following URL to authorize:\\n');
  process.stdout.write('https://accounts.google.com/o/oauth2/auth?client_id=mock&state=AGY-LOGIN-98765&redirect_uri=https://antigravity.google/oauth-callback\\n');
  process.stdout.write('Or, paste the authorization code here and press Enter: ');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.once('line', (line) => {
    const code = String(line || '').trim();
    if (code === 'valid-auth-code-123') {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({
        token: 'ya29.mock-secret-oauth-token',
        auth_method: 'Google OAuth (Subscription)',
        id_token_email: 'subscriber@example.com',
      }), { mode: 0o600 });
      process.stdout.write('\\nAuthentication succeeded!\\n');
      process.exit(0);
    } else {
      process.stdout.write('\\nAuthentication failed: invalid_grant\\n');
      process.exit(1);
    }
  });
} else {
  process.exit(0);
}
`;

describe('extractAuthCode', () => {
  it('accepts bare auth codes and callback URLs', () => {
    expect(extractAuthCode('  4/0AeanS0MockCode  ')).toBe('4/0AeanS0MockCode');
    expect(
      extractAuthCode('https://antigravity.google/oauth-callback?state=xyz&code=4%2F0MockUrlCode&scope=email')
    ).toBe('4/0MockUrlCode');
    expect(extractAuthCode('state=abc&code=query-code-77')).toBe('query-code-77');
  });

  it('rejects empty, multiline, or code-less URLs', () => {
    expect(() => extractAuthCode('   ')).toThrowError(AntigravityCliError);
    expect(() => extractAuthCode('line1\nline2')).toThrowError(AntigravityCliError);
    expect(() => extractAuthCode('https://antigravity.google/oauth-callback?state=only')).toThrowError(AntigravityCliError);
  });
});

describe('Antigravity CLI OAuth routes & streaming adapter', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let tmpRoot: string;
  let mockBin: string;
  let homesDir: string;
  let sandboxDir: string;
  let prevEnv: Record<string, string | undefined>;
  let authHeader: { cookie: string };
  let userId: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));
    mockBin = path.join(tmpRoot, 'agy');
    homesDir = path.join(tmpRoot, 'homes');
    sandboxDir = path.join(tmpRoot, 'sandbox');
    fs.writeFileSync(mockBin, MOCK_AGY_SCRIPT, { mode: 0o755 });
    fs.mkdirSync(homesDir, { recursive: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    prevEnv = {
      AGY_BIN: process.env.AGY_BIN,
      AGY_HOMES_DIR: process.env.AGY_HOMES_DIR,
      AGY_SANDBOX_DIR: process.env.AGY_SANDBOX_DIR,
      AI_CREDENTIAL_ENCRYPTION_KEY: process.env.AI_CREDENTIAL_ENCRYPTION_KEY,
    };
    process.env.AGY_BIN = mockBin;
    process.env.AGY_HOMES_DIR = homesDir;
    process.env.AGY_SANDBOX_DIR = sandboxDir;
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;

    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    const created = await createTestUser(app, 'agy-user@example.com', 'Antigravity User');
    authHeader = { cookie: created.cookieHeader };
    userId = created.user.id;
  });

  afterAll(async () => {
    await app?.close();
    dbCtx?.sqlite.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('allows creating antigravity_cli provider config without API key or encryption vault', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/providers',
      headers: authHeader,
      payload: {
        provider: 'antigravity_cli',
        label: 'Google Plan',
        modelId: 'gemini-4-hydrogen-high',
        isDefault: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.config.provider).toBe('antigravity_cli');
    expect(body.config.modelId).toBe('gemini-4-hydrogen-high');
    expect(body.config.hasKey).toBe(false);
    expect(body.config.keyLast4).toBe('OAuth');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/ai/providers/${body.config.id}`,
      headers: authHeader,
    });
    expect(del.statusCode).toBe(200);
  });

  it('completes OAuth login challenge flow, lists models, streams chat, and logs out cleanly', async () => {
    const status0 = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/antigravity/status',
      headers: authHeader,
    });
    expect(status0.statusCode).toBe(200);
    expect(status0.json()).toMatchObject({
      installed: true,
      version: '0.9.99-mock',
      authenticated: false,
      email: null,
      authMethod: null,
      activeSession: null,
    });

    const startRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/antigravity/login/start',
      headers: authHeader,
    });
    expect(startRes.statusCode).toBe(200);
    const startBody = startRes.json();
    expect(startBody.loginCode).toBe('AGY-LOGIN-98765');
    expect(startBody.authUrl).toContain('accounts.google.com/o/oauth2/auth');
    expect(typeof startBody.sessionId).toBe('string');

    const submitRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/antigravity/login/submit',
      headers: authHeader,
      payload: {
        sessionId: startBody.sessionId,
        token: 'https://antigravity.google/oauth-callback?state=AGY-LOGIN-98765&code=valid-auth-code-123',
      },
    });
    expect(submitRes.statusCode).toBe(200);
    const submitBody = submitRes.json();
    expect(submitBody).toEqual({
      ok: true,
      authenticated: true,
      email: 'subscriber@example.com',
      authMethod: 'Google OAuth (Subscription)',
    });
    expect(JSON.stringify(submitBody)).not.toContain('ya29.mock-secret-oauth-token');

    const status1 = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/antigravity/status',
      headers: authHeader,
    });
    expect(status1.statusCode).toBe(200);
    expect(status1.json()).toMatchObject({
      installed: true,
      authenticated: true,
      email: 'subscriber@example.com',
      activeSession: null,
    });

    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/providers/models-preview',
      headers: authHeader,
      payload: { provider: 'antigravity_cli' },
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json().models.map((m: { id: string }) => m.id)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-3.8-flash-high',
      'claude-sonnet-5-5-high',
    ]);

    const events: ProviderStreamEvent[] = [];
    for await (const ev of antigravityCliAdapter.chat({
      config: { modelId: 'gemini-4-hydrogen-high', apiKey: '', userId },
      messages: [{ role: 'user', content: 'Say hi' }],
      systemPrompt: 'Be helpful.',
      thinkingEffort: 'medium',
    })) {
      events.push(ev);
    }
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('Hello from Antigravity!');
    expect(events.some((e) => e.type === 'usage' && e.inputTokens === 12 && e.outputTokens === 5)).toBe(true);
    expect(events.some((e) => e.type === 'done' && e.finishReason === 'stop')).toBe(true);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/antigravity/logout',
      headers: authHeader,
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json()).toEqual({ ok: true });

    const status2 = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/antigravity/status',
      headers: authHeader,
    });
    expect(status2.json().authenticated).toBe(false);
  });
});

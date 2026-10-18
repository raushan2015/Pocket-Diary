/**
 * Audit remediation regression suite (MEMO-SAAS-AUDIT.md).
 *
 * Verifies the fixes for:
 *  - SEC-01  SSRF protection on POST /api/v1/memos/link-preview
 *  - SEC-02  Invitation acceptance restricted to the invited email address
 *  - SEC-03  Backup telemetry restricted to instance administrators
 *  - BUG-01  Attachments of soft-deleted (trashed) memos remain accessible
 *  - MOCK-03 Full forgot-password / reset-password flow
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

describe('Audit remediation: SEC-01 SSRF guard on link preview', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let cookieHeader: string;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    ({ cookieHeader } = await createTestUser(app));
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  const postPreview = async (url: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/memos/link-preview',
      headers: { cookie: cookieHeader },
      payload: { url },
    });

  it.each([
    ['http://127.0.0.1:8080/health', 'IPv4 loopback'],
    ['http://localhost:3000/api', 'localhost hostname'],
    ['http://0.0.0.0/', 'unspecified address'],
    ['http://10.0.0.1/', 'RFC1918 10/8'],
    ['http://172.16.4.20/', 'RFC1918 172.16/12'],
    ['http://192.168.1.50/', 'RFC1918 192.168/16'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata endpoint'],
    ['http://100.64.0.7/', 'CGNAT range'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fc00::abcd]/', 'IPv6 unique-local'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://224.0.0.5/', 'multicast'],
    ['http://240.1.2.3/', 'reserved range'],
  ])('rejects internal destination %s (%s)', async (url) => {
    const res = await postPreview(url);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Private or internal IP addresses are prohibited');
  });

  it('still rejects non-http(s) URLs', async () => {
    const res = await postPreview('ftp://example.com/file');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Valid http or https URL is required');
  });

  it('accepts a public literal-IP URL without attempting a fetch when host is unreachable', { timeout: 15_000 }, async () => {
    // A routable documentation address is public per the guard; the fetch
    // itself fails and the endpoint degrades to a hostname-style preview.
    const res = await postPreview('http://93.184.216.34/some-article');
    expect([200]).toContain(res.statusCode);
    const data = res.json();
    expect(data.url).toBe('http://93.184.216.34/some-article');
    expect(data.title).toBeDefined();
  });
});

describe('Audit remediation: SEC-02 invitation email enforcement', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  it('rejects an invitation claimed by a user with a different email address', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'owner@example.com');
    await createTestUser(app, 'attacker@example.com', 'Attacker');
    await createTestUser(app, 'colleague@example.com', 'Colleague');

    const inviteRes = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.id}/invites`,
      headers: { cookie: cookieHeader },
      payload: { email: 'colleague@example.com', role: 'admin' },
    });
    expect(inviteRes.statusCode).toBe(201);
    const token = inviteRes.json().inviteUrl.split('=').pop();

    const attackerLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'attacker@example.com', password: 'Password123!' },
    });
    const attackerCookie = `memo_session=${attackerLogin.cookies.find((c: any) => c.name === 'memo_session')?.value}`;

    const hijack = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      headers: { cookie: attackerCookie },
    });
    expect(hijack.statusCode).toBe(403);
    expect(hijack.json().message).toMatch(/different email address/i);

    // The attacker must not have been added to the workspace
    const members = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspace.id}/members`,
      headers: { cookie: cookieHeader },
    });
    const emails: string[] = members.json().members.map((m: any) => m.email);
    expect(emails).not.toContain('attacker@example.com');

    // The legitimate invited user can still accept the (unused) invitation
    const colleagueLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'colleague@example.com', password: 'Password123!' },
    });
    const colleagueCookie = `memo_session=${colleagueLogin.cookies.find((c: any) => c.name === 'memo_session')?.value}`;
    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      headers: { cookie: colleagueCookie },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().workspace.id).toBe(workspace.id);
    expect(accept.json().workspace.role).toBe('admin');
  });
});

describe('Audit remediation: SEC-03 backup status admin restriction', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  it('allows the instance administrator (first registered user) and forbids everyone else', async () => {
    const admin = await createTestUser(app, 'first-admin@example.com');
    const regular = await createTestUser(app, 'regular-user@example.com');

    const adminRes = await app.inject({
      method: 'GET',
      url: '/api/v1/system/backup-status',
      headers: { cookie: admin.cookieHeader },
    });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json().lastBackupAt !== undefined).toBe(true);

    const regularRes = await app.inject({
      method: 'GET',
      url: '/api/v1/system/backup-status',
      headers: { cookie: regular.cookieHeader },
    });
    expect(regularRes.statusCode).toBe(403);
    expect(regularRes.json().message).toBe('Instance administrator access required');

    // The admin flag is exposed via /auth/me for UI gating
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: admin.cookieHeader },
    });
    expect(meRes.json().user.isInstanceAdmin).toBe(true);
    const regularMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: regular.cookieHeader },
    });
    expect(regularMe.json().user.isInstanceAdmin).toBe(false);
  });
});

describe('Audit remediation: BUG-01 trashed memo attachments', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-remediation-'));
    process.env.ATTACHMENTS_DIR = storageRoot;
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
    delete process.env.ATTACHMENTS_DIR;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('serves attachment files for soft-deleted memos but not after permanent purge', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);
    const memoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId: workspace.id, title: 'Trashed note with image', content: 'body' },
    });
    const memo = memoRes.json().memo;

    // Real PNG magic bytes: uploads are magic-byte validated (audit L-6)
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png for trash remediation test')]);
    const boundary = 'remediation-boundary';
    const uploadBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/memo/${memo.id}`,
      headers: { cookie: cookieHeader, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: uploadBody,
    });
    expect(upload.statusCode).toBe(201);
    const attachmentUrl = upload.json().attachment.url;

    // Soft delete (move to trash)
    const trash = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(trash.statusCode).toBe(200);

    // The Trash view must be able to render the thumbnail
    const fileWhileTrashed = await app.inject({
      method: 'GET',
      url: attachmentUrl,
      headers: { cookie: cookieHeader },
    });
    expect(fileWhileTrashed.statusCode).toBe(200);
    expect(fileWhileTrashed.body.toString()).toBe(png.toString());

    // Cross-tenant access is still blocked for trashed memos
    const stranger = await createTestUser(app, 'stranger@example.com');
    const strangerFile = await app.inject({
      method: 'GET',
      url: attachmentUrl,
      headers: { cookie: stranger.cookieHeader },
    });
    expect(strangerFile.statusCode).toBe(404);

    // Writes (uploads) against trashed memos remain forbidden
    const uploadToTrashed = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/memo/${memo.id}`,
      headers: { cookie: cookieHeader, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: uploadBody,
    });
    expect(uploadToTrashed.statusCode).toBe(404);

    // Permanent delete purges the attachment row (cascade) and file
    const purge = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memo.id}?permanent=true`,
      headers: { cookie: cookieHeader },
    });
    expect(purge.statusCode).toBe(200);

    const fileAfterPurge = await app.inject({
      method: 'GET',
      url: attachmentUrl,
      headers: { cookie: cookieHeader },
    });
    expect(fileAfterPurge.statusCode).toBe(404);
  });
});

describe('Audit remediation: MOCK-03 password recovery flow', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;

  const forgot = (email: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email } });

  const reset = (token: string, newPassword: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, newPassword } });

  const login = async (email: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    return res;
  };

  const insertResetToken = (userId: string, token: string, opts: { expiresAt?: number; usedAt?: number | null } = {}) => {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    dbCtx.sqlite
      .prepare(
        'INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(crypto.randomUUID(), userId, tokenHash, opts.expiresAt ?? Date.now() + 3600_000, opts.usedAt ?? null, Date.now());
  };

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  it('creates a single-use reset token for a registered email (and not for unknown addresses)', async () => {
    const { user } = await createTestUser(app, 'reset-me@example.com');

    const known = await forgot('reset-me@example.com');
    expect(known.statusCode).toBe(200);
    expect(known.json().success).toBe(true);
    expect(known.json().emailConfigured).toBe(false); // SMTP not configured in tests

    const unknown = await forgot('ghost@example.com');
    expect(unknown.statusCode).toBe(200);
    // Same shape — never reveals account existence
    expect(unknown.json().message).toBe(known.json().message);

    const rows = dbCtx.sqlite
      .prepare('SELECT user_id, used_at, expires_at FROM password_resets ORDER BY created_at')
      .all() as Array<{ user_id: string; used_at: number | null; expires_at: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(user.id);
    expect(rows[0].used_at).toBeNull();
    expect(rows[0].expires_at).toBeGreaterThan(Date.now());
  });

  it('invalidates previous pending tokens when a new request is made', async () => {
    const { user } = await createTestUser(app, 'twice@example.com');
    await forgot('twice@example.com');
    await forgot('twice@example.com');

    const rows = dbCtx.sqlite
      .prepare('SELECT used_at FROM password_resets WHERE user_id = ? ORDER BY created_at')
      .all(user.id) as Array<{ used_at: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].used_at).not.toBeNull();
    expect(rows[1].used_at).toBeNull();
  });

  it('resets the password with a valid token and revokes existing sessions', async () => {
    const { user, cookieHeader } = await createTestUser(app, 'recoverable@example.com');
    const token = 'a'.repeat(64);
    insertResetToken(user.id, token);

    // Session works before the reset
    const meBefore = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader } });
    expect(meBefore.statusCode).toBe(200);

    const resetRes = await reset(token, 'BrandNewPassword456!');
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.json().success).toBe(true);

    // Old password no longer authenticates
    const oldLogin = await login('recoverable@example.com', 'Password123!');
    expect(oldLogin.statusCode).toBe(401);

    // New password works
    const newLogin = await login('recoverable@example.com', 'BrandNewPassword456!');
    expect(newLogin.statusCode).toBe(200);

    // The pre-reset session was revoked
    const meAfter = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader } });
    expect(meAfter.statusCode).toBe(401);

    // Token is single-use
    const reuse = await reset(token, 'AnotherPassword789!');
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().message).toMatch(/already been used/i);
  });

  it('rejects invalid, expired and malformed reset requests', async () => {
    const { user } = await createTestUser(app, 'edge-cases@example.com');

    // Unknown token
    const invalid = await reset('b'.repeat(64), 'SomePassword123!');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toMatch(/Invalid or expired/i);

    // Expired token
    const expiredToken = 'c'.repeat(64);
    insertResetToken(user.id, expiredToken, { expiresAt: Date.now() - 1000 });
    const expired = await reset(expiredToken, 'SomePassword123!');
    expect(expired.statusCode).toBe(400);
    expect(expired.json().message).toMatch(/expired/i);

    // Malformed (too short) token is rejected by schema validation
    const tooShort = await reset('shorttoken', 'SomePassword123!');
    expect(tooShort.statusCode).toBe(400);

    // New password below the minimum length is rejected by schema validation
    const weakPassword = await reset('d'.repeat(64), 'abc');
    expect(weakPassword.statusCode).toBe(400);

    // A tampered token (right shape, wrong value) never matches a stored hash
    const tampered = await reset('e'.repeat(64), 'SomePassword123!');
    expect(tampered.statusCode).toBe(400);
  });

  it('forgot-password requires a non-empty email', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: '' } });
    expect(res.statusCode).toBe(400);
  });
});

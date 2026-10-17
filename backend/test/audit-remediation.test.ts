/**
 * Regression tests for the 2026-10-16 project audit (AUDIT.md §6).
 *
 * Each test pins a defect the original 99-test suite missed:
 *   H-1  spoofed X-Forwarded-For must not bypass the login rate limiter
 *   H-2  reminders notify only the user who set them — never the workspace
 *   H-4  viewers cannot reorder shared notes
 *   H-6  a password change revokes every other session
 *   H-7  session tokens are stored only as SHA-256 hashes
 *   M-1  re-inviting an expired pending invite returns a working link
 *   M-2  imported notes with legacy colors stay saveable
 *   M-3  duplicate tags no longer 500
 *   M-4  folder self-parent / cycles / cross-workspace parents are 400s
 *   M-6  blank names and duplicate slugs are 4xx, not 500
 *   M-15 a reset token cannot be consumed twice
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { hashSessionToken } from '../src/services/auth.service.js';
// normalizeTagNames lives in memo.service (audit M-3)
import { normalizeTagNames as normalizeTags } from '../src/services/memo.service.js';
import { scanDueReminders } from '../src/services/notification.service.js';
import { createInvite, hashInviteToken, acceptInvite, InviteError, INVITE_EXPIRY_MS } from '../src/services/invite.service.js';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

describe('Audit remediation regression tests', () => {
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

  // ------------------------------------------------------------------ H-1
  it('H-1: spoofed X-Forwarded-For cannot bypass the login rate limiter when the sender is not a trusted proxy', async () => {
    const untrusting = buildApp({ dbCtx, logger: false, trustProxy: false });
    await untrusting.ready();
    try {
      await createTestUser(untrusting, 'rate-victim@example.com', 'Victim');
      const attempts = 20;
      let got429 = 0;
      for (let i = 0; i < attempts; i++) {
        const res = await untrusting.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          // Each request spoofs a DIFFERENT originating IP (the audit's
          // bypass technique: 20 attempts, 20 fake XFFs, zero 429s).
          headers: { 'x-forwarded-for': `10.1.${i}.${i}` },
          payload: { email: 'rate-victim@example.com', password: 'WrongPassword1!' },
        });
        if (res.statusCode === 429) got429++;
      }
      expect(got429).toBeGreaterThan(0);
    } finally {
      await untrusting.close();
    }
  });

  it('H-1: per-account lockout kicks in after repeated failed logins for one account', async () => {
    const { cookieHeader } = await createTestUser(app, 'lockout@example.com', 'Locked');
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'lockout@example.com', password: 'StillWrong1!' },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
    // The lockout is per-account: other accounts can still sign in.
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'someone-else@example.com', password: 'Whatever1!' },
    });
    expect(other.statusCode).toBe(401); // wrong password, but NOT locked out
  });

  // ------------------------------------------------------------------ H-2
  it('H-2: a due reminder notifies only the user who set it, not the whole workspace', async () => {
    const owner = await createTestUser(app, 'reminder-owner@example.com', 'Owner');
    const other = await createTestUser(app, 'reminder-other@example.com', 'Other');
    // Shared workspace: add `other` as a member directly (fixture).
    dbCtx.sqlite
      .prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), owner.workspace.id, other.user.id, 'editor', Date.now());

    const now = Date.now();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: owner.cookieHeader },
      payload: {
        workspaceId: owner.workspace.id,
        title: 'A private reminder',
        content: 'Secret body text',
        reminderTime: now - 60_000, // already due
      },
    });
    expect(createRes.statusCode).toBe(201);
    const memoId = createRes.json().memo.id;

    const result = await scanDueReminders(dbCtx, { now: now + 1000 });
    expect(result.created).toBe(1);

    const ownerNotifs = dbCtx.sqlite
      .prepare('SELECT * FROM notifications WHERE user_id = ?')
      .all(owner.user.id) as any[];
    const otherNotifs = dbCtx.sqlite
      .prepare('SELECT * FROM notifications WHERE user_id = ?')
      .all(other.user.id) as any[];
    expect(ownerNotifs).toHaveLength(1); // the setter is notified
    expect(ownerNotifs[0].memo_id).toBe(memoId);
    expect(otherNotifs).toHaveLength(0); // workspace peer is NOT notified
  });

  it('H-2: changing a reminder reassigns it to the user who changed it', async () => {
    const owner = await createTestUser(app, 'reassign-owner@example.com', 'Owner');
    const other = await createTestUser(app, 'reassign-peer@example.com', 'Peer');
    dbCtx.sqlite
      .prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), owner.workspace.id, other.user.id, 'editor', Date.now());

    const now = Date.now();
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: owner.cookieHeader },
      payload: { workspaceId: owner.workspace.id, title: 'T', content: '', reminderTime: now - 1 },
    });
    expect(createRes.statusCode).toBe(201);
    const memo = createRes.json().memo;

    // Peer changes the reminder time → peer becomes the reminder owner
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: other.cookieHeader },
      payload: { reminderTime: now, version: memo.version },
    });
    expect(updateRes.statusCode).toBe(200);

    await scanDueReminders(dbCtx, { now: now + 2000 });
    const peerNotifs = dbCtx.sqlite
      .prepare('SELECT * FROM notifications WHERE user_id = ?')
      .all(other.user.id) as any[];
    const ownerNotifs = dbCtx.sqlite
      .prepare('SELECT * FROM notifications WHERE user_id = ?')
      .all(owner.user.id) as any[];
    expect(peerNotifs).toHaveLength(1);
    expect(ownerNotifs).toHaveLength(0);
  });

  // ------------------------------------------------------------------ H-4
  it('H-4: viewers cannot reorder notes', async () => {
    const owner = await createTestUser(app, 'reorder-owner@example.com', 'Owner');
    const viewer = await createTestUser(app, 'reorder-viewer@example.com', 'Viewer');
    dbCtx.sqlite
      .prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), owner.workspace.id, viewer.user.id, 'viewer', Date.now());

    const a = await app.inject({
      method: 'POST', url: '/api/v1/memos',
      headers: { cookie: owner.cookieHeader },
      payload: { workspaceId: owner.workspace.id, title: 'A' },
    });
    const b = await app.inject({
      method: 'POST', url: '/api/v1/memos',
      headers: { cookie: owner.cookieHeader },
      payload: { workspaceId: owner.workspace.id, title: 'B' },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/memos/reorder',
      headers: { cookie: viewer.cookieHeader },
      payload: { workspaceId: owner.workspace.id, memoIds: [b.json().memo.id, a.json().memo.id] },
    });
    expect(res.statusCode).toBe(403);

    // Editors still can
    const editor = await createTestUser(app, 'reorder-editor@example.com', 'Editor');
    dbCtx.sqlite
      .prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), owner.workspace.id, editor.user.id, 'editor', Date.now());
    const ok = await app.inject({
      method: 'POST', url: '/api/v1/memos/reorder',
      headers: { cookie: editor.cookieHeader },
      payload: { workspaceId: owner.workspace.id, memoIds: [b.json().memo.id, a.json().memo.id] },
    });
    expect(ok.statusCode).toBe(200);
  });

  // ------------------------------------------------------------------ H-6 + H-7
  it('H-6/H-7: changing the password revokes every other session; sessions are stored hashed', async () => {
    const user = await createTestUser(app, 'pwchange@example.com', 'Changer');
    // Second session (another device)
    const secondLogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'pwchange@example.com', password: 'Password123!' },
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondCookie = `memo_session=${secondLogin.cookies.find((c: any) => c.name === 'memo_session')?.value}`;

    // H-7: neither raw token appears in the sessions table
    const rawRows = dbCtx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE id IN (?, ?)')
      .get(user.cookie, secondLogin.cookies.find((c: any) => c.name === 'memo_session')?.value) as { n: number };
    expect(rawRows.n).toBe(0);
    // ...and both hashes do
    const hashRows = dbCtx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE id IN (?, ?)')
      .get(hashSessionToken(user.cookie), hashSessionToken(String(secondLogin.cookies.find((c: any) => c.name === 'memo_session')?.value))) as { n: number };
    expect(hashRows.n).toBe(2);

    // Change the password from the FIRST session
    const change = await app.inject({
      method: 'PATCH', url: '/api/v1/auth/profile',
      headers: { cookie: user.cookieHeader },
      payload: { currentPassword: 'Password123!', newPassword: 'NewSecurePassword456!' },
    });
    expect(change.statusCode).toBe(200);

    // The second session must now be revoked (audit H-6)...
    const secondMe = await app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { cookie: secondCookie },
    });
    expect(secondMe.statusCode).toBe(401);
    // ...while the session that made the change stays valid.
    const firstMe = await app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { cookie: user.cookieHeader },
    });
    expect(firstMe.statusCode).toBe(200);
  });

  // ------------------------------------------------------------------ M-1
  it('M-1: re-inviting after expiry issues a fresh token with a new expiry window', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'reinvite@example.com', 'Owner');
    const first = createInvite(dbCtx, {
      workspaceId: workspace.id,
      email: 'late@example.com',
      role: 'editor',
      invitedByUserId: (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader } })).json().user.id,
      appUrl: 'http://localhost:8080',
    });
    expect(first.invite.expiresAt).toBeGreaterThan(Date.now());

    // Simulate the pending invite going stale (expired but still 'pending').
    dbCtx.sqlite
      .prepare('UPDATE workspace_invites SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, first.invite.id);
    // The stale link must fail…
    expect(() => acceptInvite(dbCtx, first.invite.token, 'irrelevant')).toThrow(InviteError);

    // …but re-inviting must produce a WORKING link (audit M-1: the old code
    // returned the same dead token with its past expiresAt).
    const second = createInvite(dbCtx, {
      workspaceId: workspace.id,
      email: 'late@example.com',
      role: 'editor',
      invitedByUserId: (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader } })).json().user.id,
      appUrl: 'http://localhost:8080',
    });
    expect(second.invite.id).toBe(first.invite.id);
    expect(second.invite.token).not.toBe(first.invite.token);
    expect(second.invite.expiresAt).toBeGreaterThan(Date.now());
    expect(second.invite.expiresAt - Date.now()).toBeGreaterThan(INVITE_EXPIRY_MS - 60_000);

    // The fresh link is now usable (lookup finds it, and it is not expired).
    const registerRes = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'late@example.com', password: 'Password123!', name: 'Late Joiner', inviteToken: second.invite.token },
    });
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.json().joinedWorkspace?.id).toBe(workspace.id);

    // The OLD token must no longer work (only hashes are stored; a spent
    // token is dead even if leaked).
    const oldLookup = await app.inject({ method: 'GET', url: `/api/v1/invites/${first.invite.token}` });
    expect(oldLookup.statusCode).toBe(404);
  });

  // ------------------------------------------------------------------ M-2
  it('M-2: a memo imported with a legacy color stays saveable (pin-only PATCH succeeds)', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'legacy-color@example.com', 'Importer');

    // Simulate the import path storing a non-standard color (audit M-2's
    // reproduction: importLocalData previously stored any string).
    const memoId = crypto.randomUUID();
    const now = Date.now();
    dbCtx.sqlite
      .prepare(
        `INSERT INTO memos (id, workspace_id, title, content, color, note_type, status, priority, is_favorite, is_pinned,
         collaborators, checklist_data, link_previews, version, created_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, 'Imported', 'body', 'RED', 'text', 'pending', 'medium', 0, 0, '[]', '[]', '[]', 1, ?, ?, ?, NULL)`
      )
      .run(memoId, workspace.id, (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader } })).json().user.id, now, now);

    // A later PATCH that does not touch color must NOT re-validate the stored color.
    const pinRes = await app.inject({
      method: 'PATCH', url: `/api/v1/memos/${memoId}`,
      headers: { cookie: cookieHeader },
      payload: { isPinned: true, version: 1 },
    });
    expect(pinRes.statusCode).toBe(200);
    expect(pinRes.json().memo.isPinned).toBe(true);

    // Changing the color to a VALID value still works…
    const recolor = await app.inject({
      method: 'PATCH', url: `/api/v1/memos/${memoId}`,
      headers: { cookie: cookieHeader },
      payload: { color: 'red', version: 2 },
    });
    expect(recolor.statusCode).toBe(200);
    expect(recolor.json().memo.color).toBe('red');

    // …and providing an INVALID color is rejected (unchanged behavior).
    const badColor = await app.inject({
      method: 'PATCH', url: `/api/v1/memos/${memoId}`,
      headers: { cookie: cookieHeader },
      payload: { color: 'SHIMMERING', version: 3 },
    });
    expect(badColor.statusCode).toBe(400);
  });

  it('M-2: the import path itself normalizes colors to the palette', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'import-color@example.com', 'Importer');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/migration/import-local',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        memos: [
          { title: 'Keep note', content: 'x', color: 'RED' },      // valid palette name, wrong case → 'red'
          { title: 'Weird note', content: 'y', color: 'SHIMMERING' }, // unknown → 'default'
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const listRes = await app.inject({
      method: 'GET', url: `/api/v1/memos?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    const colors = listRes.json().memos.map((m: any) => m.color);
    expect(colors).toContain('red');
    expect(colors).toContain('default');
  });

  // ------------------------------------------------------------------ M-3
  it('M-3: duplicate and case-variant tags no longer 500', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'dupe-tags@example.com', 'Tagger');
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId: workspace.id, title: 'Tagged', tags: ['x', 'x', 'Work', 'work'] },
    });
    expect(createRes.statusCode).toBe(201);
    expect(new Set(createRes.json().memo.tags)).toEqual(new Set(['x', 'Work']));

    // Updates with duplicates are also safe
    const updateRes = await app.inject({
      method: 'PATCH', url: `/api/v1/memos/${createRes.json().memo.id}`,
      headers: { cookie: cookieHeader },
      payload: { tags: ['a', 'a', 'a'], version: createRes.json().memo.version },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().memo.tags).toEqual(['a']);

    // The normalization helper itself
    expect(normalizeTags(['', '  ', 'A', 'a', 'B'])).toEqual(['A', 'B']);
  });

  // ------------------------------------------------------------------ M-4 + M-6
  it('M-4: folders reject self-parent, cycles and cross-workspace parents with 400', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'folders@example.com', 'Folderer');
    const other = await createTestUser(app, 'folders-other@example.com', 'Other');

    const create = async (payload: object) => app.inject({
      method: 'POST', url: '/api/v1/folders',
      headers: { cookie: cookieHeader },
      payload: { workspaceId: workspace.id, ...payload },
    });

    const parent = await create({ name: 'Parent' });
    expect(parent.statusCode).toBe(201);
    const parentId = parent.json().folder.id;

    const child = await create({ name: 'Child', parentId });
    expect(child.statusCode).toBe(201);

    // Self-parent → 400
    const selfParent = await app.inject({
      method: 'PATCH', url: `/api/v1/folders/${parentId}`,
      headers: { cookie: cookieHeader },
      payload: { parentId: parentId },
    });
    expect(selfParent.statusCode).toBe(400);

    // Cycle (parent under its own child) → 400
    const cycle = await app.inject({
      method: 'PATCH', url: `/api/v1/folders/${parentId}`,
      headers: { cookie: cookieHeader },
      payload: { parentId: child.json().folder.id },
    });
    expect(cycle.statusCode).toBe(400);

    // Nonexistent parent → 400 (previously an FK 500)
    const ghost = await create({ name: 'Ghost', parentId: crypto.randomUUID() });
    expect(ghost.statusCode).toBe(400);

    // Cross-workspace parent → 400
    const foreign = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      headers: { cookie: other.cookieHeader },
      payload: { workspaceId: other.workspace.id, name: 'Foreign' },
    });
    expect(foreign.statusCode).toBe(201);
    const foreignParent = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      headers: { cookie: cookieHeader },
      payload: { workspaceId: workspace.id, name: 'Spy', parentId: foreign.json().folder.id },
    });
    expect(foreignParent.statusCode).toBe(400);
  });

  it('M-5: deleting a folder keeps its subfolders (detached, not cascade-deleted)', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'cascade@example.com', 'Cascader');
    const parent = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      headers: { cookie: cookieHeader },
      payload: { workspaceId: workspace.id, name: 'Parent' },
    });
    const child = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      headers: { cookie: cookieHeader },
      payload: { workspaceId: workspace.id, name: 'Child', parentId: parent.json().folder.id },
    });
    const childId = child.json().folder.id;

    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/folders/${parent.json().folder.id}?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(del.statusCode).toBe(200);

    const childStillThere = dbCtx.sqlite.prepare('SELECT * FROM folders WHERE id = ?').get(childId) as any;
    expect(childStillThere).toBeDefined();
    expect(childStillThere.parent_id).toBeNull();
  });

  it('M-6: blank folder names return 400 and duplicate workspace slugs return 409', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'slugs@example.com', 'Slugger');

    const blankFolder = await app.inject({
      method: 'POST', url: '/api/v1/folders',
      headers: { cookie: cookieHeader },
      payload: { workspaceId: workspace.id, name: '   ' },
    });
    expect(blankFolder.statusCode).toBe(400);

    const ws = await app.inject({
      method: 'POST', url: '/api/v1/workspaces',
      headers: { cookie: cookieHeader },
      payload: { name: 'Slug Test', slug: 'dup-slug' },
    });
    expect(ws.statusCode).toBe(201);

    const dupSlug = await app.inject({
      method: 'POST', url: '/api/v1/workspaces',
      headers: { cookie: cookieHeader },
      payload: { name: 'Slug Test 2', slug: 'dup-slug' },
    });
    expect(dupSlug.statusCode).toBe(409); // previously an unhandled UNIQUE 500
  });

  // ------------------------------------------------------------------ M-15
  it('M-15: a password reset token cannot be consumed twice', async () => {
    await createTestUser(app, 'reset-twice@example.com', 'Resetter');
    const forgot = await app.inject({
      method: 'POST', url: '/api/v1/auth/forgot-password',
      payload: { email: 'reset-twice@example.com' },
    });
    expect(forgot.statusCode).toBe(200);

    // Extract the token hash the service stored, then build a matching raw
    // token via the same derivation the route would use is impossible (raw
    // token is never returned without SMTP) — so consume directly through
    // the service using a token we generate and store ourselves.
    const { requestPasswordReset, consumePasswordReset } = await import('../src/services/password-reset.service.js');
    // The service stores sha256(token); we craft a token, insert a row with
    // its hash, then attempt double consumption.
    const token = crypto.randomBytes(32).toString('hex');
    const userId = (dbCtx.sqlite.prepare('SELECT id FROM users WHERE email = ?').get('reset-twice@example.com') as any).id;
    dbCtx.sqlite
      .prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(crypto.randomUUID(), userId, crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 60_000, Date.now());

    const first = await consumePasswordReset(dbCtx, token, 'FreshPassword123!');
    expect(first).toBeUndefined();
    await expect(consumePasswordReset(dbCtx, token, 'AnotherPassword123!')).rejects.toThrow(/already been used/);
  });

  // ------------------------------------------------------------------ H-9
  it('H-9: only the first registered account becomes instance admin', async () => {
    const first = await createTestUser(app, 'first-admin@example.com', 'First');
    const second = await createTestUser(app, 'second-user@example.com', 'Second');
    expect(first.user).toBeDefined();
    const firstMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: first.cookieHeader } });
    const secondMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: second.cookieHeader } });
    expect(firstMe.json().user.isInstanceAdmin).toBe(true);
    expect(secondMe.json().user.isInstanceAdmin).toBe(false);
  });
});

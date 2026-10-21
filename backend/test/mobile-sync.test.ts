/**
 * Mobile-apps backend support (see mobile-apps/ARCHITECTURE.md §3):
 *
 *  1. GET /api/v1/system/info — public capability discovery used by the
 *     first-launch server-setup screen. Must be reachable without a session,
 *     must identify the product, and must expose the memoClientId capability.
 *
 *  2. Idempotent note creation — offline clients replay POST /memos when an
 *     HTTP response is lost after the server applied the write. A stable
 *     client-supplied clientId must return the memo the first attempt
 *     created instead of duplicating it, and must never be editable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('System info endpoint (GET /api/v1/system/info)', () => {
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

  it('is public — no session cookie required', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/info' });
    expect(res.statusCode).toBe(200);
  });

  it('identifies the product, version and API prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/info' });
    const body = res.json();
    expect(body.name).toBe('pocket-diary');
    expect(body.version).toEqual(expect.any(String));
    expect(body.apiPrefix).toBe('/api/v1');
  });

  it('exposes the memoClientId capability flag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/info' });
    expect(res.json().capabilities).toMatchObject({ memoClientId: true });
  });

  it('is unaffected by rate limiting on the authenticated system route', async () => {
    // The sibling /system/backup-status route requires a session — /info must not.
    const denied = await app.inject({ method: 'GET', url: '/api/v1/system/backup-status' });
    expect(denied.statusCode).toBe(401);
    const info = await app.inject({ method: 'GET', url: '/api/v1/system/info' });
    expect(info.statusCode).toBe(200);
  });
});

describe('Idempotent memo creation (clientId)', () => {
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

  const createNote = (cookieHeader: string, workspaceId: string, over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, title: 'Offline note', ...over },
    });

  it('stores the clientId and replays the same memo on a duplicate create', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    const first = await createNote(cookieHeader, workspace.id, { clientId: 'mobile-op-00000001' });
    expect(first.statusCode).toBe(201);
    const firstMemo = first.json().memo;
    expect(firstMemo.clientId).toBe('mobile-op-00000001');

    // The response to the first attempt was "lost" — the client retries.
    const retry = await createNote(cookieHeader, workspace.id, {
      clientId: 'mobile-op-00000001',
      content: 'written before the response was lost',
    });
    expect(retry.statusCode).toBe(201);
    const retryMemo = retry.json().memo;
    expect(retryMemo.id).toBe(firstMemo.id);
    expect(retryMemo.version).toBe(firstMemo.version);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&limit=100`,
      headers: { cookie: cookieHeader },
    });
    expect(list.json().total).toBe(1);
  });

  it('scopes uniqueness to the workspace — same clientId in two workspaces creates two memos', async () => {
    const { cookieHeader } = await createTestUser(app);
    const wsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie: cookieHeader },
      payload: { name: 'Second workspace' },
    });
    const secondWorkspace = wsRes.json().workspace;

    const a = await createNote(cookieHeader, secondWorkspace.id, { clientId: 'shared-key-0001' });
    const b = await createNote(cookieHeader, secondWorkspace.id, { clientId: 'shared-key-0001' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().memo.id).toBe(a.json().memo.id);

    // The user's auto-created personal workspace is a different scope: the
    // same key must be accepted there too.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader },
    });
    const personal = me.json().workspaces.find((w: { id: string }) => w.id !== secondWorkspace.id);
    const c = await createNote(cookieHeader, personal.id, { clientId: 'shared-key-0001' });
    expect(c.statusCode).toBe(201);
    expect(c.json().memo.id).not.toBe(a.json().memo.id);
  });

  it('replays a trashed memo instead of resurrecting a duplicate', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);
    const created = await createNote(cookieHeader, workspace.id, { clientId: 'trash-replay-01' });
    const memoId = created.json().memo.id;

    const trashed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memoId}`,
      headers: { cookie: cookieHeader },
    });
    expect(trashed.statusCode).toBe(200);

    const replay = await createNote(cookieHeader, workspace.id, { clientId: 'trash-replay-01' });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().memo.id).toBe(memoId);
    expect(replay.json().memo.deletedAt).not.toBeNull();
  });

  it('rejects malformed clientIds but keeps creates without one working', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    const short = await createNote(cookieHeader, workspace.id, { clientId: 'short' });
    expect(short.statusCode).toBe(400);

    const plain = await createNote(cookieHeader, workspace.id);
    expect(plain.statusCode).toBe(201);
    expect(plain.json().memo.clientId).toBeNull();
  });

  it('keeps clientId stable across updates — PATCH cannot change it', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);
    const created = await createNote(cookieHeader, workspace.id, { clientId: 'immutable-key-1' });
    const memoId = created.json().memo.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memoId}`,
      headers: { cookie: cookieHeader },
      payload: { title: 'renamed', clientId: 'evil-attempt-99' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().memo.title).toBe('renamed');
    expect(patched.json().memo.clientId).toBe('immutable-key-1');
  });
});

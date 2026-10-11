import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { workspaceMembers } from '../src/db/schema.js';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

describe('Workspace Tenant Isolation & RBAC Protection', () => {
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

  it('prevents cross-tenant memo access between independent users and workspaces', async () => {
    // User A in Workspace A
    const userA = await createTestUser(app, 'alice@acme.com', 'Alice');
    // User B in Workspace B
    const userB = await createTestUser(app, 'bob@corp.com', 'Bob');

    // Alice creates a memo in Workspace A
    const memoResA = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: userA.cookieHeader },
      payload: {
        workspaceId: userA.workspace.id,
        title: 'Alice Confidential Memo',
        content: 'Acme secret product plans and proprietary intellectual property.',
        priority: 'urgent',
      },
    });
    expect(memoResA.statusCode).toBe(201);
    const memoA = memoResA.json().memo;

    // 1. Bob attempts to list memos specifying Alice's Workspace A ID -> 403 Forbidden
    const listCrossRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${userA.workspace.id}`,
      headers: { cookie: userB.cookieHeader },
    });
    expect(listCrossRes.statusCode).toBe(403);

    // 2. Bob attempts to fetch Alice's memo by ID directly -> 404 Not Found (no cross-tenant leakage)
    const getCrossRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos/${memoA.id}`,
      headers: { cookie: userB.cookieHeader },
    });
    expect(getCrossRes.statusCode).toBe(404);

    // 3. Bob attempts to update Alice's memo -> 404 Not Found
    const updateCrossRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memoA.id}`,
      headers: { cookie: userB.cookieHeader },
      payload: {
        title: 'Hacked by Bob',
        version: 1,
      },
    });
    expect(updateCrossRes.statusCode).toBe(404);

    // 4. Bob attempts to delete Alice's memo -> 404 Not Found
    const deleteCrossRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memoA.id}`,
      headers: { cookie: userB.cookieHeader },
    });
    expect(deleteCrossRes.statusCode).toBe(404);

    // 5. Bob searches in his own workspace for keywords in Alice's memo -> 0 results
    const searchCrossRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${userB.workspace.id}&search=Confidential`,
      headers: { cookie: userB.cookieHeader },
    });
    expect(searchCrossRes.statusCode).toBe(200);
    expect(searchCrossRes.json().total).toBe(0);

    // 6. Bob attempts to export Alice's workspace -> 403 Forbidden
    const exportCrossRes = await app.inject({
      method: 'GET',
      url: `/api/v1/migration/export?workspaceId=${userA.workspace.id}`,
      headers: { cookie: userB.cookieHeader },
    });
    expect(exportCrossRes.statusCode).toBe(403);
  });

  it('rejects category and folder references owned by another workspace', async () => {
    const ownerA = await createTestUser(app, 'owner-a@acme.com', 'Owner A');
    const ownerB = await createTestUser(app, 'owner-b@acme.com', 'Owner B');

    const categoryResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/categories',
      headers: { cookie: ownerA.cookieHeader },
      payload: { workspaceId: ownerA.workspace.id, name: 'Private Category' },
    });
    expect(categoryResponse.statusCode).toBe(201);
    const categoryId = categoryResponse.json().category.id;

    const folderResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { cookie: ownerA.cookieHeader },
      payload: { workspaceId: ownerA.workspace.id, name: 'Private Folder' },
    });
    expect(folderResponse.statusCode).toBe(201);
    const folderId = folderResponse.json().folder.id;

    const createWithForeignCategory = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: ownerB.cookieHeader },
      payload: { workspaceId: ownerB.workspace.id, title: 'Invalid category reference', categoryId },
    });
    expect(createWithForeignCategory.statusCode).toBe(400);

    const createWithForeignFolder = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: ownerB.cookieHeader },
      payload: { workspaceId: ownerB.workspace.id, title: 'Invalid folder reference', folderId },
    });
    expect(createWithForeignFolder.statusCode).toBe(400);

    const validMemo = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: ownerB.cookieHeader },
      payload: { workspaceId: ownerB.workspace.id, title: 'Valid memo' },
    });
    expect(validMemo.statusCode).toBe(201);
    const memoId = validMemo.json().memo.id;

    const updateWithForeignCategory = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memoId}`,
      headers: { cookie: ownerB.cookieHeader },
      payload: { categoryId, version: 1 },
    });
    expect(updateWithForeignCategory.statusCode).toBe(400);

    const updateWithForeignFolder = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memoId}`,
      headers: { cookie: ownerB.cookieHeader },
      payload: { folderId, version: 1 },
    });
    expect(updateWithForeignFolder.statusCode).toBe(400);
  });

  it('enforces RBAC role permissions: viewers cannot mutate or import data', async () => {
    // Owner creates workspace and memo
    const owner = await createTestUser(app, 'owner@acme.com', 'Owner');
    const memoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: owner.cookieHeader },
      payload: {
        workspaceId: owner.workspace.id,
        title: 'Company Handbook',
        content: 'General company policies.',
      },
    });
    const memo = memoRes.json().memo;

    // Register a viewer user
    const viewer = await createTestUser(app, 'viewer@acme.com', 'Viewer');

    // Add viewer to Owner's workspace with 'viewer' role
    dbCtx.db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId: owner.workspace.id,
      userId: viewer.user.id,
      role: 'viewer',
      createdAt: Date.now(),
    }).run();

    // 1. Viewer CAN list memos in workspace
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${owner.workspace.id}`,
      headers: { cookie: viewer.cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().total).toBe(1);

    // 2. Viewer CAN read single memo by ID
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: viewer.cookieHeader },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().memo.title).toBe('Company Handbook');

    // 3. Viewer CANNOT create memo -> 403 Forbidden
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: viewer.cookieHeader },
      payload: {
        workspaceId: owner.workspace.id,
        title: 'Unauthorized Memo',
      },
    });
    expect(createRes.statusCode).toBe(403);

    // 4. Viewer CANNOT update memo -> 403 Forbidden
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: viewer.cookieHeader },
      payload: {
        title: 'Tampered by Viewer',
        version: 1,
      },
    });
    expect(updateRes.statusCode).toBe(403);

    // 5. Viewer CANNOT delete memo -> 403 Forbidden
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: viewer.cookieHeader },
    });
    expect(deleteRes.statusCode).toBe(403);

    // 6. Viewer CANNOT import migration data -> 403 Forbidden
    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/migration/import-local',
      headers: { cookie: viewer.cookieHeader },
      payload: {
        workspaceId: owner.workspace.id,
        memos: [{ title: 'Injected' }],
      },
    });
    expect(importRes.statusCode).toBe(403);
  });
});

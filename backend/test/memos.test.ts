import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('Memos Management API (/api/v1/memos)', () => {
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

  it('creates a new memo with tags, priority, status, and category', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create a category first
    const catRes = await app.inject({
      method: 'POST',
      url: '/api/v1/categories',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        name: 'Work Projects',
        color: '#2563eb',
        icon: 'briefcase',
      },
    });
    expect(catRes.statusCode).toBe(201);
    const category = catRes.json().category;

    // Create memo
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        categoryId: category.id,
        title: 'Project Roadmap',
        content: 'Q4 deliverables and milestones',
        priority: 'high',
        status: 'in_progress',
        isFavorite: true,
        isPinned: true,
        dueDate: 1728556800000,
        tags: ['planning', 'q4', 'roadmap'],
      },
    });

    expect(res.statusCode).toBe(201);
    const { memo } = res.json();

    expect(memo.id).toBeDefined();
    expect(memo.workspaceId).toBe(workspace.id);
    expect(memo.title).toBe('Project Roadmap');
    expect(memo.content).toBe('Q4 deliverables and milestones');
    expect(memo.priority).toBe('high');
    expect(memo.status).toBe('in_progress');
    expect(memo.isFavorite).toBe(true);
    expect(memo.isPinned).toBe(true);
    expect(memo.dueDate).toBe(1728556800000);
    expect(memo.version).toBe(1);
    expect(memo.category).toBeDefined();
    expect(memo.category.name).toBe('Work Projects');
    expect(memo.tags).toEqual(['planning', 'q4', 'roadmap']);
  });

  it('rejects invalid status or priority with 400 Bad Request', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    const invalidStatusRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Test',
        status: 'unknown_status',
      },
    });
    expect(invalidStatusRes.statusCode).toBe(400);

    const invalidPriorityRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Test',
        priority: 'super_urgent',
      },
    });
    expect(invalidPriorityRes.statusCode).toBe(400);
  });

  it('lists memos with pagination, status, and tag filtering', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create 3 memos
    await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Memo 1',
        content: 'Content 1',
        status: 'pending',
        priority: 'low',
        tags: ['alpha'],
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Memo 2',
        content: 'Content 2',
        status: 'completed',
        priority: 'urgent',
        tags: ['beta'],
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Memo 3',
        content: 'Content 3',
        status: 'pending',
        priority: 'high',
        isFavorite: true,
        tags: ['alpha', 'beta'],
      },
    });

    // List all
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    const all = listRes.json();
    expect(all.total).toBe(3);
    expect(all.memos.length).toBe(3);

    // Filter by status=completed
    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&status=completed`,
      headers: { cookie: cookieHeader },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().total).toBe(1);
    expect(statusRes.json().memos[0].title).toBe('Memo 2');

    // Filter by tagName=alpha
    const tagRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&tagName=alpha`,
      headers: { cookie: cookieHeader },
    });
    expect(tagRes.statusCode).toBe(200);
    expect(tagRes.json().total).toBe(2);

    // Filter by isFavorite=true
    const favRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&isFavorite=true`,
      headers: { cookie: cookieHeader },
    });
    expect(favRes.statusCode).toBe(200);
    expect(favRes.json().total).toBe(1);
    expect(favRes.json().memos[0].title).toBe('Memo 3');
  });

  it('rejects invalid or excessive pagination values', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    for (const query of ['page=0', 'page=abc', 'page=100001', 'limit=0', 'limit=101', 'limit=not-a-number']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/memos?workspaceId=${workspace.id}&${query}`,
        headers: { cookie: cookieHeader },
      });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('updates memo and enforces optimistic locking with 409 Conflict', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create memo
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Original Title',
        content: 'Original Content',
        status: 'draft',
      },
    });
    const memo = createRes.json().memo;
    expect(memo.version).toBe(1);

    // Update with correct version = 1
    const updateRes1 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
      payload: {
        title: 'Updated Title V2',
        version: 1,
      },
    });
    expect(updateRes1.statusCode).toBe(200);
    const updated1 = updateRes1.json().memo;
    expect(updated1.title).toBe('Updated Title V2');
    expect(updated1.version).toBe(2);

    // Attempt concurrent update with stale version = 1 -> Should return 409 Conflict!
    const conflictRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
      payload: {
        title: 'Stale Concurrent Update',
        version: 1,
      },
    });
    expect(conflictRes.statusCode).toBe(409);
    const conflictJson = conflictRes.json();
    expect(conflictJson.error).toBe('Conflict');
    expect(conflictJson.currentVersion).toBe(2);

    // Update with fresh version = 2 -> Succeeds and increments to 3
    const updateRes2 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
      payload: {
        title: 'Updated Title V3',
        content: 'New content V3',
        version: 2,
      },
    });
    expect(updateRes2.statusCode).toBe(200);
    const updated2 = updateRes2.json().memo;
    expect(updated2.title).toBe('Updated Title V3');
    expect(updated2.version).toBe(3);

    // Check version revision history
    const versionsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos/${memo.id}/versions`,
      headers: { cookie: cookieHeader },
    });
    expect(versionsRes.statusCode).toBe(200);
    const { versions } = versionsRes.json();
    expect(versions.length).toBe(3); // v1 (created), v2 (updated), v3 (updated)
    expect(versions[0].versionNumber).toBe(1);
    expect(versions[1].versionNumber).toBe(2);
    expect(versions[2].versionNumber).toBe(3);
  });

  it('supports soft delete and restore', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'To Be Soft Deleted',
        content: 'Some memo content',
      },
    });
    const memo = createRes.json().memo;

    // Soft delete
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().success).toBe(true);

    // Normal list excludes soft-deleted memo
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(listRes.json().total).toBe(0);

    // List with includeDeleted=true includes soft-deleted memo
    const listDeletedRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&includeDeleted=true`,
      headers: { cookie: cookieHeader },
    });
    expect(listDeletedRes.json().total).toBe(1);
    expect(listDeletedRes.json().memos[0].deletedAt).toBeTruthy();

    // Restore memo
    const restoreRes = await app.inject({
      method: 'POST',
      url: `/api/v1/memos/${memo.id}/restore`,
      headers: { cookie: cookieHeader },
    });
    expect(restoreRes.statusCode).toBe(200);
    const restored = restoreRes.json().memo;
    expect(restored.deletedAt).toBeNull();

    // Now appears in normal list again
    const finalListRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(finalListRes.json().total).toBe(1);
  });

  it('supports permanent hard delete', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'To Be Hard Deleted',
        tags: ['temp'],
      },
    });
    const memo = createRes.json().memo;

    const hardDeleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${memo.id}?permanent=true`,
      headers: { cookie: cookieHeader },
    });
    expect(hardDeleteRes.statusCode).toBe(200);

    // Even with includeDeleted=true, it is completely gone
    const checkRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos/${memo.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(checkRes.statusCode).toBe(404);
  });
});

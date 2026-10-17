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
    // Audit M-7: rapid successive saves are coalesced into the existing
    // snapshot (within VERSION_COALESCE_WINDOW_MS) instead of writing a full
    // copy per autosave pause. Both updates happened within the window, so
    // only the initial v1 snapshot is retained.
    expect(versions.length).toBe(1);
    expect(versions[0].versionNumber).toBe(1);
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

  it('supports Google Keep attributes, colors, themes, checklists, archiving, and reordering', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // 1. Create note with Google Keep checklist & color
    const createRes1 = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Grocery List',
        noteType: 'checklist',
        color: 'yellow',
        theme: 'grocery',
        checklistData: [
          { id: '1', text: 'Oat Milk', checked: false, sortOrder: 0 },
          { id: '2', text: 'Organic Eggs', checked: true, sortOrder: 1 },
        ],
        reminderTime: Date.now() + 3600000,
        collaborators: [{ email: 'partner@example.com', name: 'Partner' }],
      },
    });
    expect(createRes1.statusCode).toBe(201);
    const memo1 = createRes1.json().memo;
    expect(memo1.color).toBe('yellow');
    expect(memo1.theme).toBe('grocery');
    expect(memo1.noteType).toBe('checklist');
    expect(memo1.checklistData).toHaveLength(2);
    expect(memo1.collaborators).toHaveLength(1);
    expect(memo1.reminderTime).toBeDefined();

    // 2. Create second note (archived)
    const createRes2 = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Archived Reference',
        content: 'Old notes',
        color: 'teal',
        isArchived: true,
      },
    });
    expect(createRes2.statusCode).toBe(201);
    const memo2 = createRes2.json().memo;
    expect(memo2.isArchived).toBe(true);

    // 3. List active memos (excludes archived by default)
    const listActive = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&isArchived=false`,
      headers: { cookie: cookieHeader },
    });
    expect(listActive.statusCode).toBe(200);
    const activeIds = listActive.json().memos.map((m: any) => m.id);
    expect(activeIds).toContain(memo1.id);
    expect(activeIds).not.toContain(memo2.id);

    // 4. List archived memos
    const listArchived = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&isArchived=true`,
      headers: { cookie: cookieHeader },
    });
    expect(listArchived.statusCode).toBe(200);
    const archivedIds = listArchived.json().memos.map((m: any) => m.id);
    expect(archivedIds).toContain(memo2.id);
    expect(archivedIds).not.toContain(memo1.id);

    // 5. Reorder memos atomically
    const reorderRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos/reorder',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        memoIds: [memo2.id, memo1.id],
      },
    });
    expect(reorderRes.statusCode).toBe(200);
    expect(reorderRes.json().success).toBe(true);
  });

  it('provides link preview endpoint', async () => {
    const { cookieHeader } = await createTestUser(app);

    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos/link-preview',
      headers: { cookie: cookieHeader },
      payload: {
        url: 'https://example.com/test-article',
      },
    });
    expect(previewRes.statusCode).toBe(200);
    const data = previewRes.json();
    expect(data.url).toBe('https://example.com/test-article');
    expect(data.title).toBeDefined();
  });

  it('empties the trash: permanently purges all soft-deleted memos for the workspace', async () => {
    const { workspace, cookieHeader, user } = await createTestUser(app, 'trash-owner@example.com');

    const createMemoTitled = async (title: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memos',
        headers: { cookie: cookieHeader },
        payload: { workspaceId: workspace.id, title, content: 'to be deleted' },
      });
      expect(res.statusCode).toBe(201);
      return res.json().memo as { id: string };
    };

    const keep = await createMemoTitled('Keeper');
    const del1 = await createMemoTitled('Doomed one');
    const del2 = await createMemoTitled('Doomed two');

    // Soft-delete two memos
    for (const memo of [del1, del2]) {
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/memos/${memo.id}`, headers: { cookie: cookieHeader } });
      expect(res.statusCode).toBe(200);
    }

    // Other-workspace trash must not be touched: create an isolated second user + trashed memo
    const other = await createTestUser(app, 'other-ws-owner@example.com');
    const otherMemoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: other.cookieHeader },
      payload: { workspaceId: other.workspace.id, title: 'Other workspace trashed note', content: 'x' },
    });
    const otherMemo = otherMemoRes.json().memo as { id: string };
    await app.inject({ method: 'DELETE', url: `/api/v1/memos/${otherMemo.id}`, headers: { cookie: other.cookieHeader } });

    // Viewers may not empty the trash
    const viewer = await createTestUser(app, 'trash-viewer@example.com');
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.id}/members`,
      headers: { cookie: cookieHeader },
      payload: { email: 'trash-viewer@example.com', role: 'viewer' },
    });
    const viewerRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/trash?workspaceId=${workspace.id}`,
      headers: { cookie: viewer.cookieHeader },
    });
    expect(viewerRes.statusCode).toBe(403);

    // Empty the trash as the owner
    const emptyRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/trash?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json().deletedCount).toBe(2);

    // Trashed memos are gone hard; the kept memo survives
    const trashList = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&deletedOnly=true&limit=100`,
      headers: { cookie: cookieHeader },
    });
    expect(trashList.json().total).toBe(0);

    const activeList = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&limit=100`,
      headers: { cookie: cookieHeader },
    });
    const activeIds = activeList.json().memos.map((m: any) => m.id);
    expect(activeIds).toContain(keep.id);
    expect(activeIds).not.toContain(del1.id);
    expect(activeIds).not.toContain(del2.id);

    // Version history rows were cascaded away with the purged memos
    const versionRows = dbCtx.sqlite
      .prepare('SELECT COUNT(*) AS n FROM memo_versions WHERE memo_id IN (?, ?)')
      .get(del1.id, del2.id) as { n: number };
    expect(versionRows.n).toBe(0);

    // The other workspace's trashed memo is untouched
    const otherTrash = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${other.workspace.id}&deletedOnly=true`,
      headers: { cookie: other.cookieHeader },
    });
    expect(otherTrash.json().total).toBe(1);

    // Emptying again is a safe no-op
    const reEmpty = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/trash?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(reEmpty.statusCode).toBe(200);
    expect(reEmpty.json().deletedCount).toBe(0);

    // workspaceId is required by schema validation
    const missingWs = await app.inject({ method: 'DELETE', url: '/api/v1/memos/trash', headers: { cookie: cookieHeader } });
    expect(missingWs.statusCode).toBe(400);

    // Cross-tenant emptying is rejected
    const cross = await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/trash?workspaceId=${other.workspace.id}`,
      headers: { cookie: viewer.cookieHeader },
    });
    expect(cross.statusCode).toBe(403);
  });
});

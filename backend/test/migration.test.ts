import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('Data Migration API (/api/v1/migration)', () => {
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

  it('imports legacy client-side localStorage data in an atomic transaction', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    const importPayload = {
      workspaceId: workspace.id,
      categories: [
        { name: 'Work', color: '#3b82f6', icon: 'briefcase' },
        { name: 'Personal', color: '#10b981', icon: 'user' },
      ],
      tags: ['urgent', 'q4-plan', 'grocery'],
      memos: [
        {
          localId: 'local-memo-101',
          title: 'Q4 Budget Review',
          content: 'Examine departmental expense spreadsheets.',
          priority: 'urgent',
          status: 'in_progress',
          isFavorite: true,
          category: 'Work',
          tags: ['urgent', 'q4-plan'],
          dueDate: 1728556800000,
          createdAt: 1728500000000,
        },
        {
          localId: 'local-memo-102',
          title: 'Weekend Groceries',
          content: 'Milk, cheese, eggs, and bread.',
          priority: 'medium',
          status: 'pending',
          isFavorite: false,
          category: 'Personal',
          tags: ['grocery'],
          createdAt: 1728510000000,
        },
        {
          localId: 'local-memo-103',
          title: 'Quick Ideas Without Pre-defined Category',
          content: 'Startup concepts brainstorm.',
          priority: 'low',
          status: 'draft',
          category: 'Innovations', // Not in category list -> created on the fly
          tags: ['ideas'],
        },
      ],
    };

    const importRes = await app.inject({
      method: 'POST',
      url: '/api/v1/migration/import-local',
      headers: { cookie: cookieHeader },
      payload: importPayload,
    });

    expect(importRes.statusCode).toBe(200);
    const result = importRes.json();
    expect(result.success).toBe(true);
    expect(result.importedMemos).toBe(3);
    expect(result.importedCategories).toBe(3); // Work, Personal, Innovations
    expect(result.importedTags).toBe(4); // urgent, q4-plan, grocery, ideas

    // Verify imported memos are queryable
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    const { memos } = listRes.json();
    expect(memos.length).toBe(3);

    const q4Memo = memos.find((m: any) => m.title === 'Q4 Budget Review');
    expect(q4Memo).toBeDefined();
    expect(q4Memo.priority).toBe('urgent');
    expect(q4Memo.status).toBe('in_progress');
    expect(q4Memo.isFavorite).toBe(true);
    expect(q4Memo.category).toBeDefined();
    expect(q4Memo.category.name).toBe('Work');
    expect(q4Memo.tags).toContain('urgent');
    expect(q4Memo.tags).toContain('q4-plan');
    expect(q4Memo.version).toBe(1);

    // Verify imported memos are immediately indexed in FTS5
    const searchRes = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspace.id}&search=spreadsheets`,
      headers: { cookie: cookieHeader },
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().total).toBe(1);
    expect(searchRes.json().memos[0].title).toBe('Q4 Budget Review');
  });

  it('exports entire workspace data payload', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create category and memo first
    await app.inject({
      method: 'POST',
      url: '/api/v1/categories',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        name: 'Finance',
        color: '#f59e0b',
      },
    });

    const memoCreateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        title: 'Tax Planning 2026',
        content: 'Deductions and corporate filings.',
        priority: 'high',
        tags: ['tax', 'finance'],
      },
    });
    const createdMemo = memoCreateRes.json().memo;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/memos/${createdMemo.id}`,
      headers: { cookie: cookieHeader },
    });

    // Export workspace
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/v1/migration/export?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });

    expect(exportRes.statusCode).toBe(200);
    const exportData = exportRes.json();
    expect(exportData.workspaceId).toBe(workspace.id);
    expect(exportData.exportedAt).toBeTypeOf('number');
    expect(exportData.categories.length).toBe(1);
    expect(exportData.categories[0].name).toBe('Finance');
    expect(exportData.memos.length).toBe(1);
    expect(exportData.memos[0].title).toBe('Tax Planning 2026');
    expect(exportData.memos[0].deletedAt).toBeTypeOf('number');
    expect(exportData.tags.length).toBe(2);
  });
});

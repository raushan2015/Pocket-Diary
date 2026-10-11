import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('Categories, Tags, Folders & Workspaces API', () => {
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

  it('manages categories with full CRUD', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/categories',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        name: 'Urgent Tasks',
        color: '#ef4444',
        icon: 'alert-circle',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const cat = createRes.json().category;
    expect(cat.name).toBe('Urgent Tasks');

    // List
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/categories?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().categories.length).toBe(1);

    // Update
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/categories/${cat.id}`,
      headers: { cookie: cookieHeader },
      payload: {
        name: 'Critical Tasks',
        color: '#dc2626',
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().category.name).toBe('Critical Tasks');

    // Delete
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/categories/${cat.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(deleteRes.statusCode).toBe(200);
  });

  it('manages tags idempotently', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create tag
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/tags',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        name: 'frontend',
      },
    });
    expect(res1.statusCode).toBe(201);
    const tag1 = res1.json().tag;

    // Create same tag again -> returns existing
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/tags',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        name: 'frontend',
      },
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.json().tag.id).toBe(tag1.id);

    // List
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/tags?workspaceId=${workspace.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(listRes.json().tags.length).toBe(1);

    // Delete
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tags/${tag1.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(delRes.statusCode).toBe(200);
  });

  it('renames labels and keeps memo assignments attached', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);
    const createdTag = await app.inject({ method: 'POST', url: '/api/v1/tags', headers: { cookie: cookieHeader }, payload: { workspaceId: workspace.id, name: 'ideas' } });
    expect(createdTag.statusCode).toBe(201);
    const tag = createdTag.json().tag;
    const memoRes = await app.inject({ method: 'POST', url: '/api/v1/memos', headers: { cookie: cookieHeader }, payload: { workspaceId: workspace.id, title: 'Tagged note', content: 'label test', tags: ['ideas'] } });
    expect(memoRes.statusCode).toBe(201);
    const renameRes = await app.inject({ method: 'PATCH', url: `/api/v1/tags/${tag.id}`, headers: { cookie: cookieHeader }, payload: { workspaceId: workspace.id, name: 'brainstorm' } });
    expect(renameRes.statusCode).toBe(200);
    expect(renameRes.json().tag.name).toBe('brainstorm');
    const listRes = await app.inject({ method: 'GET', url: `/api/v1/memos?workspaceId=${workspace.id}`, headers: { cookie: cookieHeader } });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().memos[0].tags).toContain('brainstorm');
    const duplicateRes = await app.inject({ method: 'POST', url: '/api/v1/tags', headers: { cookie: cookieHeader }, payload: { workspaceId: workspace.id, name: 'existing' } });
    const duplicateId = duplicateRes.json().tag.id;
    const duplicateRename = await app.inject({ method: 'PATCH', url: `/api/v1/tags/${tag.id}`, headers: { cookie: cookieHeader }, payload: { workspaceId: workspace.id, name: 'existing' } });
    expect(duplicateRename.statusCode).toBe(400);
    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/v1/tags/${duplicateId}?workspaceId=${workspace.id}`, headers: { cookie: cookieHeader } });
    expect(deleteRes.statusCode).toBe(200);
  });

  it('manages folders and workspaces', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);

    // Create folder
    const folderRes = await app.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId: workspace.id,
        name: 'Archives 2026',
      },
    });
    expect(folderRes.statusCode).toBe(201);
    const folder = folderRes.json().folder;
    expect(folder.name).toBe('Archives 2026');

    // Create second workspace
    const wsRes = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie: cookieHeader },
      payload: {
        name: 'Work Team',
        slug: 'work-team-slug',
      },
    });
    expect(wsRes.statusCode).toBe(201);
    const newWs = wsRes.json().workspace;
    expect(newWs.name).toBe('Work Team');

    // List workspaces
    const listWsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces',
      headers: { cookie: cookieHeader },
    });
    expect(listWsRes.statusCode).toBe(200);
    expect(listWsRes.json().workspaces.length).toBe(2);
  });
});

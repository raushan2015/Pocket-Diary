import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('Request schema validation at API boundaries', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let workspaceId: string;
  let cookieHeader: string;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    const user = await createTestUser(app, 'validator@example.com');
    workspaceId = user.workspace.id;
    cookieHeader = user.cookieHeader;
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  it('rejects memo creation without workspaceId and with invalid enum values', async () => {
    const noWs = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { title: 'x' },
    });
    expect(noWs.statusCode).toBe(400);

    const badPriority = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, title: 'x', priority: 'super-duper' },
    });
    expect(badPriority.statusCode).toBe(400);

    const badStatus = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, title: 'x', status: 'zombie' },
    });
    expect(badStatus.statusCode).toBe(400);

    const badDueDate = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, title: 'x', dueDate: 'not-a-date' },
    });
    expect(badDueDate.statusCode).toBe(400);
  });

  it('rejects oversized memo titles at the boundary', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, title: 'x'.repeat(201) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid list querystring params', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/memos?workspaceId=${workspaceId}&limit=999`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(400);

    const noWs = await app.inject({
      method: 'GET',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
    });
    expect(noWs.statusCode).toBe(400);
  });

  it('rejects malformed auth payloads', async () => {
    const shortPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'someone@example.com', password: '123', name: 'Someone' },
    });
    expect(shortPassword.statusCode).toBe(400);

    const missingName = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'someone@example.com', password: 'Password123!' },
    });
    expect(missingName.statusCode).toBe(400);

    const badRememberMe = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@b.co', password: 'Password123!', rememberMe: 'yes-please' },
    });
    expect(badRememberMe.statusCode).toBe(400);
  });

  it('rejects malformed category, tag and folder payloads', async () => {
    const badCategory = await app.inject({
      method: 'POST',
      url: '/api/v1/categories',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, name: '' },
    });
    expect(badCategory.statusCode).toBe(400);

    const badTag = await app.inject({
      method: 'POST',
      url: '/api/v1/tags',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, name: 'x'.repeat(81) },
    });
    expect(badTag.statusCode).toBe(400);

    const badFolder = await app.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { cookie: cookieHeader },
      payload: { name: 'No Workspace' },
    });
    expect(badFolder.statusCode).toBe(400);
  });

  it('rejects malformed reorder and link-preview payloads', async () => {
    const badReorder = await app.inject({
      method: 'POST',
      url: '/api/v1/memos/reorder',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, memoIds: [] },
    });
    expect(badReorder.statusCode).toBe(400);

    const badPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/memos/link-preview',
      headers: { cookie: cookieHeader },
      payload: { url: 'not a url' },
    });
    expect(badPreview.statusCode).toBe(400);
  });

  it('no longer exposes a direct member-add endpoint (audit H-3)', async () => {
    // POST /workspaces/:id/members was removed: it bypassed invitation consent
    // (admins could pull any registered account into a workspace) and its
    // 404-vs-201 responses let any signed-in user enumerate registered emails.
    // All additions flow through POST /workspaces/:id/invites.
    const directAdd = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/members`,
      headers: { cookie: cookieHeader },
      payload: { email: 'x@example.com', role: 'editor' },
    });
    expect(directAdd.statusCode).toBe(404);

    const badWorkspace = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: { cookie: cookieHeader },
      payload: { name: '' },
    });
    expect(badWorkspace.statusCode).toBe(400);
  });

  it('rejects malformed push subscription payloads', async () => {
    const noKeys = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookieHeader },
      payload: { endpoint: 'https://push.example/abc' },
    });
    expect(noKeys.statusCode).toBe(400);

    const keyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/push/public-key',
      headers: { cookie: cookieHeader },
    });
    expect(keyRes.statusCode).toBe(200);
    expect(keyRes.json().enabled).toBe(false);
    expect(keyRes.json().publicKey).toBeNull();
  });

  it('accepts valid rich memo payloads through the schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: {
        workspaceId,
        title: 'Rich memo',
        content: '- [ ] items',
        noteType: 'checklist',
        checklistData: [{ id: 'c1', text: 'Item', checked: false }],
        tags: ['valid-tag'],
        color: 'teal',
        theme: 'grocery',
        reminderTime: Date.now() + 3600_000,
        isPinned: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().memo.noteType).toBe('checklist');
    expect(res.json().memo.tags).toEqual(['valid-tag']);
  });
});

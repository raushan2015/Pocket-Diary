import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase, type DatabaseContext } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { MockProviderServer, TEST_ENCRYPTION_KEY } from './helpers/ai-mock-provider.js';
import { executeTool, type ToolContext } from '../src/services/ai/tools.service.js';
import { ToolStreamSplitter } from '../src/services/ai/providers/antigravity-cli.js';

async function waitForRequest(app: FastifyInstance, cookie: string, requestId: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/ai/requests/${requestId}`, headers: { cookie } });
    if (res.statusCode === 200) {
      const req = res.json().request;
      if (['complete', 'failed', 'interrupted', 'canceled'].includes(req.status)) return req;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

describe('AI Full Control tools & Antigravity tool stream parser', () => {
  let dbCtx: DatabaseContext;
  let app: FastifyInstance;
  let mock: MockProviderServer;

  beforeAll(async () => {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    mock = new MockProviderServer();
    const baseUrl = await mock.listen();
    process.env.AI_DEEPSEEK_BASE_URL = baseUrl;
  });

  afterAll(async () => {
    delete process.env.AI_DEEPSEEK_BASE_URL;
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    await mock.close();
  });

  const setupApp = async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    const owner = await createTestUser(app, 'fullctrl-owner@example.test', 'Owner');
    const convRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/conversations',
      headers: { cookie: owner.cookieHeader },
      payload: { workspaceId: owner.workspace.id },
    });
    const conversationId = convRes.json().conversation.id as string;
    const emitted: Array<{ event: string; data: unknown }> = [];
    const ctx: ToolContext = {
      dbCtx,
      userId: owner.user.id,
      workspaceId: owner.workspace.id,
      conversationId,
      emitUiEvent: (event, data) => emitted.push({ event, data }),
    };
    return { owner, conversationId, ctx, emitted };
  };

  const teardownApp = async () => {
    await app.close();
    dbCtx.sqlite.close();
    mock.clearRecorded();
  };

  it('executes full lifecycle: notes CRUD, calendar reminders, trash/restore/empty, folders, categories, tags', async () => {
    const { owner, ctx, emitted } = await setupApp();
    try {
      // 1. Folders, Categories, Tags
      const folderCreate = await executeTool('manage_folders', { action: 'create', name: 'Work Projects' }, ctx);
      expect(folderCreate.success).toBe(true);
      const folderId = (folderCreate.result as any).folder.id as string;

      const catCreate = await executeTool('manage_categories', { action: 'create', name: 'Urgent', color: '#ef4444' }, ctx);
      expect(catCreate.success).toBe(true);
      const categoryId = (catCreate.result as any).category.id as string;

      const tagCreate = await executeTool('manage_tags', { action: 'create', name: 'roadmap' }, ctx);
      expect(tagCreate.success).toBe(true);
      const tagId = (tagCreate.result as any).tag.id as string;

      // 2. Create note with metadata & ISO reminder
      const createRes = await executeTool('create_note', {
        title: 'Launch Checklist',
        content: 'Prepare deployment and notify team.',
        folderId,
        categoryId,
        tags: ['roadmap', 'launch'],
        priority: 'high',
        isPinned: true,
        reminderTime: '2026-11-20T09:00:00Z',
        reminderLocation: 'Tokyo Office',
      }, ctx);
      expect(createRes.success).toBe(true);
      const memoId = (createRes.result as any).memoId as string;

      // 3. Dedicated set_reminder (new reminder note) + get_calendar_schedule
      const remRes = await executeTool('set_reminder', {
        title: 'Dentist Appointment',
        reminderTime: '2026-11-21T14:30:00Z',
        priority: 'medium',
      }, ctx);
      expect(remRes.success).toBe(true);
      const remMemoId = (remRes.result as any).memoId as string;

      const calRes = await executeTool('get_calendar_schedule', {}, ctx);
      expect(calRes.success).toBe(true);
      expect((calRes.result as any).scheduledCount).toBe(2);
      expect((calRes.result as any).events.map((e: any) => e.title)).toContain('Dentist Appointment');

      // 4. Update & Read note
      const updRes = await executeTool('update_note', {
        memoId,
        title: 'Launch Checklist v2',
        isFavorite: true,
        status: 'in_progress',
      }, ctx);
      expect(updRes.success).toBe(true);

      const readRes = await executeTool('read_note', { memoId }, ctx);
      expect(readRes.success).toBe(true);
      expect((readRes.result as any).title).toBe('Launch Checklist v2');
      expect((readRes.result as any).isPinned).toBe(true);
      expect((readRes.result as any).isFavorite).toBe(true);

      // 5. Blocked notes remain unreadable & redacted in list/calendar
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/ai/memos/${memoId}/privacy`,
        headers: { cookie: owner.cookieHeader },
        payload: { workspaceId: owner.workspace.id, aiAccess: 'blocked' },
      });
      const blockedRead = await executeTool('read_note', { memoId }, ctx);
      expect(blockedRead.success).toBe(false);
      expect(blockedRead.error).toContain('never share with AI');

      const listRes = await executeTool('list_notes', {}, ctx);
      expect(listRes.success).toBe(true);
      const blockedListed = (listRes.result as any).notes.find((n: any) => n.id === memoId);
      expect(blockedListed.title).toBe('[Blocked Note]');

      // 6. Soft delete -> restore -> soft delete -> empty_trash
      const trashRes = await executeTool('delete_note', { memoId: remMemoId, permanent: false }, ctx);
      expect(trashRes.success).toBe(true);
      expect((trashRes.result as any).status).toBe('moved_to_trash');

      const trashedList = await executeTool('list_notes', { deletedOnly: true }, ctx);
      expect((trashedList.result as any).total).toBe(1);

      const restoreRes = await executeTool('restore_note', { memoId: remMemoId }, ctx);
      expect(restoreRes.success).toBe(true);
      expect((restoreRes.result as any).status).toBe('restored');

      await executeTool('delete_note', { memoId: remMemoId, permanent: false }, ctx);
      const emptyRes = await executeTool('empty_trash', { confirm: true }, ctx);
      expect(emptyRes.success).toBe(true);
      expect((emptyRes.result as any).deletedCount).toBe(1);

      // 7. Folder/Category/Tag rename & delete
      await executeTool('manage_folders', { action: 'update', folderId, name: 'Engineering' }, ctx);
      await executeTool('manage_categories', { action: 'update', categoryId, name: 'Critical' }, ctx);
      await executeTool('manage_tags', { action: 'rename', tagId, name: 'q4-roadmap' }, ctx);
      expect((await executeTool('manage_folders', { action: 'delete', folderId }, ctx)).success).toBe(true);
      expect((await executeTool('manage_categories', { action: 'delete', categoryId }, ctx)).success).toBe(true);
      expect((await executeTool('manage_tags', { action: 'delete', tagId }, ctx)).success).toBe(true);

      // Verify UI live sync events were emitted
      expect(emitted.some((e) => e.event === 'workspace_changed')).toBe(true);
    } finally {
      await teardownApp();
    }
  });

  it('denies destructive/write actions to workspace viewers', async () => {
    const { ctx } = await setupApp();
    try {
      const viewer = await createTestUser(app, 'viewer-fullctrl@example.test', 'Viewer');
      dbCtx.sqlite.prepare(
        "INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'viewer', ?)"
      ).run('wm-viewer-test', ctx.workspaceId, viewer.user.id, Date.now());

      const created = await executeTool('create_note', { title: 'Protected', content: 'Keep safe' }, ctx);
      const memoId = (created.result as any).memoId as string;

      const viewerCtx: ToolContext = { ...ctx, userId: viewer.user.id };
      const delAttempt = await executeTool('delete_note', { memoId }, viewerCtx);
      expect(delAttempt.success).toBe(false);
      const remAttempt = await executeTool('set_reminder', { title: 'Test', reminderTime: '2026-12-01T10:00:00Z' }, viewerCtx);
      expect(remAttempt.success).toBe(false);
    } finally {
      await teardownApp();
    }
  });

  it('executes delete_note and set_reminder end-to-end when fullControl=true in chat', async () => {
    const { owner, conversationId } = await setupApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/api/v1/ai/providers',
        headers: { cookie: owner.cookieHeader },
        payload: { provider: 'deepseek', label: 'Mock', modelId: 'mock-model', apiKey: 'sk-mock-fullctrl-1234' },
      });

      const createdRes = await app.inject({
        method: 'POST',
        url: '/api/v1/memos',
        headers: { cookie: owner.cookieHeader },
        payload: { workspaceId: owner.workspace.id, title: 'Disposable Draft', content: 'Delete me cleanly.' },
      });
      const targetId = createdRes.json().memo.id as string;

      mock.behavior = {
        toolCall: { name: 'delete_note', args: { memoId: targetId, permanent: false } },
      };
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/ai/conversations/${conversationId}/messages`,
        headers: { cookie: owner.cookieHeader },
        payload: { content: '__TOOL__ Go ahead with the test', fullControl: true },
      });
      expect(sendRes.statusCode).toBe(202);
      const done = await waitForRequest(app, owner.cookieHeader, sendRes.json().request.id);
      expect(done.status).toBe('complete');

      // Verify cumulative token usage across both tool rounds
      const convDetail = await app.inject({
        method: 'GET',
        url: `/api/v1/ai/conversations/${conversationId}`,
        headers: { cookie: owner.cookieHeader },
      });
      const assistant = convDetail.json().messages.at(-1);
      expect(assistant.meta?.usage?.inputTokens).toBeGreaterThanOrEqual(20);
      expect(assistant.meta?.usage?.rounds).toBe(2);

      // Active list should now have 0 notes; trash should have 1
      const activeList = await app.inject({
        method: 'GET',
        url: `/api/v1/memos?workspaceId=${owner.workspace.id}`,
        headers: { cookie: owner.cookieHeader },
      });
      expect(activeList.json().total).toBe(0);
    } finally {
      await teardownApp();
    }
  });

  it('parses streamed <<<PD_TOOL>>> blocks across arbitrary chunks without leaking markers', () => {
    const splitter = new ToolStreamSplitter();
    const chunks = [
      'Sure, checking <<<PD_',
      'TOOL>>>\n{"name":"delete_note","arguments":{"memoId":"m1"}}\n<<<END_',
      'PD_TOOL>>>\nAll set!',
    ];
    const events = [
      ...chunks.flatMap((c) => splitter.push(c)),
      ...splitter.flush(),
    ];
    const texts = events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');
    const calls = events.filter((e) => e.type === 'tool_call') as any[];
    expect(texts).toBe('Sure, checking \nAll set!');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('delete_note');
    expect(JSON.parse(calls[0].arguments)).toEqual({ memoId: 'm1' });
  });

  it('supports workspaces, cross-workspace targeting, invites, note history/reorder, attachments, and JSON/ICS exports with RBAC & blocked protections', async () => {
    const { owner, ctx } = await setupApp();
    try {
      // 1. Create & rename second workspace, check storage & members
      const wsCreate = await executeTool('manage_workspaces', { action: 'create', name: 'Personal Journal' }, ctx);
      expect(wsCreate.success).toBe(true);
      const secondWsId = (wsCreate.result as any).workspace.id as string;

      const wsRename = await executeTool('manage_workspaces', { action: 'rename', workspaceId: secondWsId, name: 'Personal Vault' }, ctx);
      expect(wsRename.success).toBe(true);
      expect((wsRename.result as any).workspace.name).toBe('Personal Vault');

      // Cross-workspace note creation + listing
      const crossNote = await executeTool('create_note', {
        workspaceId: secondWsId,
        title: 'Travel Itinerary',
        content: 'Flight at 08:00 JST',
        reminderTime: '2026-12-10T08:00:00Z',
        reminderLocation: 'Haneda Airport',
      }, ctx);
      expect(crossNote.success).toBe(true);
      const crossMemoId = (crossNote.result as any).memoId as string;

      // Update memo so it creates revision history
      await executeTool('update_note', {
        workspaceId: secondWsId,
        memoId: crossMemoId,
        content: 'Flight at 09:00 JST (Terminal 3)',
      }, ctx);

      const versionsRes = await executeTool('manage_note_extras', {
        action: 'versions',
        workspaceId: secondWsId,
        memoId: crossMemoId,
      }, ctx);
      expect(versionsRes.success).toBe(true);
      expect((versionsRes.result as any).versions.length).toBeGreaterThanOrEqual(1);

      // Reorder notes in primary workspace
      const n1 = await executeTool('create_note', { title: 'Note A', content: 'First' }, ctx);
      const n2 = await executeTool('create_note', { title: 'Note B', content: 'Second', reminderTime: '2026-11-25T10:00:00Z' }, ctx);
      const n1Id = (n1.result as any).memoId as string;
      const n2Id = (n2.result as any).memoId as string;
      const reorderRes = await executeTool('manage_note_extras', { action: 'reorder', memoIds: [n2Id, n1Id] }, ctx);
      expect(reorderRes.success).toBe(true);

      // Blocked note refuses revision history and omits from exports & attachments list
      await executeTool('create_note', { title: 'Secret Diary', content: 'Private', reminderTime: '2026-12-01T12:00:00Z' }, ctx)
        .then(async (r) => {
          const blockedId = (r.result as any).memoId as string;
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/ai/memos/${blockedId}/privacy`,
            headers: { cookie: owner.cookieHeader },
            payload: { workspaceId: owner.workspace.id, aiAccess: 'blocked' },
          });
          const blockedVersions = await executeTool('manage_note_extras', { action: 'versions', memoId: blockedId }, ctx);
          expect(blockedVersions.success).toBe(false);
          expect(blockedVersions.error).toContain('never share with AI');
        });

      // Exports: workspace_json & calendar_ics (blocked note omitted)
      const jsonExport = await executeTool('export_data', { format: 'workspace_json' }, ctx);
      expect(jsonExport.success).toBe(true);
      expect((jsonExport.result as any).omittedBlockedCount).toBe(1);
      expect((jsonExport.result as any).memos.map((m: any) => m.title)).not.toContain('Secret Diary');

      const icsExport = await executeTool('export_data', { format: 'calendar_ics' }, ctx);
      expect(icsExport.success).toBe(true);
      expect((icsExport.result as any).eventCount).toBe(1);
      expect((icsExport.result as any).icsContent).toContain('BEGIN:VCALENDAR');
      expect((icsExport.result as any).icsContent).toContain('SUMMARY:Note B');
      expect((icsExport.result as any).icsContent).not.toContain('Secret Diary');

      // Invites lifecycle (create -> list -> revoke)
      const invCreate = await executeTool('manage_invites', { action: 'create', email: 'teammate@example.test', role: 'editor' }, ctx);
      expect(invCreate.success).toBe(true);
      const inviteId = (invCreate.result as any).inviteId as string;
      const invList = await executeTool('manage_invites', { action: 'list' }, ctx);
      expect((invList.result as any).invites.some((i: any) => i.id === inviteId)).toBe(true);
      const invRevoke = await executeTool('manage_invites', { action: 'revoke', inviteId }, ctx);
      expect(invRevoke.success).toBe(true);

      // Attachments list & delete (storage_path never leaked)
      dbCtx.sqlite.prepare(
        'INSERT INTO attachments (id, memo_id, workspace_id, file_name, file_size, mime_type, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('att-1', n1Id, ctx.workspaceId, 'spec.pdf', 1024, 'application/pdf', '/tmp/nonexistent-spec.pdf', Date.now());
      const attList = await executeTool('manage_attachments', { action: 'list' }, ctx);
      expect(attList.success).toBe(true);
      expect((attList.result as any).attachments[0].fileName).toBe('spec.pdf');
      expect((attList.result as any).attachments[0].storagePath).toBeUndefined();
      const attDel = await executeTool('manage_attachments', { action: 'delete', attachmentId: 'att-1' }, ctx);
      expect(attDel.success).toBe(true);

      // Workspace storage & members & activities
      const storageRes = await executeTool('manage_workspaces', { action: 'storage', workspaceId: secondWsId }, ctx);
      expect(storageRes.success).toBe(true);
      expect((storageRes.result as any).totalBytes).toBeGreaterThan(0);

      const membersRes = await executeTool('manage_workspaces', { action: 'members' }, ctx);
      expect((membersRes.result as any).members).toHaveLength(1);

      const activitiesRes = await executeTool('manage_workspaces', { action: 'activities' }, ctx);
      expect(activitiesRes.success).toBe(true);
      expect((activitiesRes.result as any).activities.map((a: any) => a.detail)).not.toContain('Secret Diary');
    } finally {
      await teardownApp();
    }
  });
});

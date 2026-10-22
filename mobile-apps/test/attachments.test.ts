import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxQueue } from '@/features/sync/outbox';
import { NodeSqliteDriver } from '@/services/db/driver.node';
import { initializeDatabase } from '@/services/db/database';
import { NotesRepository } from '@/features/notes/repository';
import { SyncEngine } from '@/features/sync/engine';
import { WorkspaceRepository } from '@/features/workspaces/repository';
import { ApiClient } from '@/services/api/client';
import { MockHttpTransport } from './helpers/mock-transport';
import { validateAttachment, resolveMime } from '@/features/attachments/rules';
import { collectUpcomingReminders } from '@/features/reminders/notifications';

const scope = { serverKey: 'https://notes.example.com', userId: 'user-att' };

describe('Attachment rules (client-side validation mirrors the server)', () => {
  it('resolves MIME by extension first, reported type as fallback', () => {
    expect(resolveMime('photo.jpg', 'application/octet-stream')).toBe('image/jpeg');
    expect(resolveMime('notes.MD', null)).toBe('text/markdown');
    expect(resolveMime('weird.xyz', 'image/png')).toBe('image/png');
    expect(resolveMime('weird.xyz', 'application/octet-stream')).toBeNull();
  });

  it('refuses unsupported types with a clear reason', () => {
    const res = validateAttachment({ fileName: 'movie.mp4', mimeType: 'video/mp4', fileSize: 1000 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('Supported');
  });

  it('refuses files above the 5 MB server limit', () => {
    const res = validateAttachment({ fileName: 'huge.png', mimeType: 'image/png', fileSize: 5 * 1024 * 1024 + 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('5 MB');
  });

  it('accepts a normal photo pick', () => {
    const res = validateAttachment({ fileName: 'IMG_001.jpg', mimeType: 'image/jpeg', fileSize: 800 * 1024 });
    expect(res.ok).toBe(true);
    expect(res.mimeType).toBe('image/jpeg');
  });
});

describe('Outbox attachment operations', () => {
  let db: NodeSqliteDriver;
  let outbox: OutboxQueue;

  beforeEach(() => {
    db = new NodeSqliteDriver(':memory:');
    initializeDatabase(db);
    outbox = new OutboxQueue(db, scope);
  });

  it('never coalesces attachment ops into note lifecycle ops', () => {
    outbox.enqueue({ entity: 'note', noteId: 'n1', op: 'create', payload: { title: 'A' }, clientId: 'client-1' });
    outbox.enqueue({
      entity: 'note',
      noteId: 'n1',
      op: 'attachment_upload',
      payload: { attachmentId: 'att-1', fileName: 'x.png', mimeType: 'image/png' },
    });
    // Lifecycle op remains a single create; attachment op stands alone.
    const entries = outbox.listAllEntries();
    expect(entries.filter((e) => e.op === 'create')).toHaveLength(1);
    expect(entries.filter((e) => e.op === 'attachment_upload')).toHaveLength(1);

    // A subsequent note update must merge into the create, not the attachment.
    outbox.enqueue({ entity: 'note', noteId: 'n1', op: 'update', payload: { title: 'B' } });
    const after = outbox.listAllEntries();
    expect(after.filter((e) => e.op === 'create')).toHaveLength(1);
    expect(after.find((e) => e.op === 'create')?.payload.title).toBe('B');
    expect(after.filter((e) => e.op === 'attachment_upload')).toHaveLength(1);
  });

  it('replaces a re-picked pending upload for the same attachment id', () => {
    outbox.enqueue({
      entity: 'note',
      noteId: 'n1',
      op: 'attachment_upload',
      payload: { attachmentId: 'att-1', fileName: 'first.png' },
    });
    outbox.enqueue({
      entity: 'note',
      noteId: 'n1',
      op: 'attachment_upload',
      payload: { attachmentId: 'att-1', fileName: 'second.png' },
    });
    const uploads = outbox.listAllEntries().filter((e) => e.op === 'attachment_upload');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.payload.fileName).toBe('second.png');
  });

  it('elides pending uploads when the note is trashed (they would 404)', () => {
    outbox.enqueue({
      entity: 'note',
      noteId: 'n1',
      op: 'attachment_upload',
      payload: { attachmentId: 'att-1', fileName: 'x.png' },
    });
    outbox.enqueue({ entity: 'note', noteId: 'n1', op: 'delete', payload: { serverId: 'srv-1' } });
    const entries = outbox.listAllEntries();
    expect(entries.some((e) => e.op === 'attachment_upload')).toBe(false);
    expect(entries.some((e) => e.op === 'delete')).toBe(true);
  });

  it('removeNoteOps drops only pending/in-flight ops for that note', () => {
    const a = outbox.enqueue({ entity: 'note', noteId: 'n1', op: 'create', payload: {} })!;
    outbox.markInFlight(a.id);
    outbox.enqueue({ entity: 'note', noteId: 'n2', op: 'create', payload: {} });
    outbox.removeNoteOps('n1');
    expect(outbox.listAllEntries().some((e) => e.noteId === 'n1')).toBe(false);
    expect(outbox.listAllEntries().some((e) => e.noteId === 'n2')).toBe(true);
  });

  it('retryOp requeues exactly one failed op without resetting its id', () => {
    const e = outbox.enqueue({ entity: 'note', noteId: 'n1', op: 'attachment_upload', payload: {} })!;
    outbox.markFailed(e.id, 'boom', true);
    outbox.retryOp(e.id);
    const requeued = outbox.getEntryById(e.id);
    expect(requeued?.status).toBe('pending');
    expect(requeued?.attempts).toBe(0);
  });
});

describe('Attachment push through the sync engine', () => {
  let db: NodeSqliteDriver;
  let transport: MockHttpTransport;
  let api: ApiClient;
  let notesRepo: NotesRepository;
  let outbox: OutboxQueue;
  let engine: SyncEngine;

  beforeEach(() => {
    db = new NodeSqliteDriver(':memory:');
    initializeDatabase(db);
    transport = new MockHttpTransport();
    api = new ApiClient({ baseUrl: 'https://notes.example.com', transport, token: 'tok' });
    notesRepo = new NotesRepository(db, scope);
    const workspaceRepo = new WorkspaceRepository(db, scope);
    outbox = new OutboxQueue(db, scope);
    engine = new SyncEngine({ api, notesRepo, workspaceRepo, outbox, db, scope });

    transport.on('/api/v1/auth/me', () =>
      MockHttpTransport.json(200, {
        user: { id: scope.userId, email: 'a@b.c', name: 'A', createdAt: 1 },
        workspaces: [{ id: 'ws-default', name: 'Default', role: 'owner' }],
      }),
    );
    transport.on('/api/v1/notifications', () => MockHttpTransport.json(200, { notifications: [], unread: 0 }));
    transport.on('/api/v1/folders', () => MockHttpTransport.json(200, { folders: [] }));
    transport.on('/api/v1/categories', () => MockHttpTransport.json(200, { categories: [] }));
    transport.on('/api/v1/tags', () => MockHttpTransport.json(200, { tags: [] }));
    transport.get('/api/v1/memos/', () => MockHttpTransport.json(200, { memos: [], total: 0, page: 1, limit: 100 }));
  });

  it('uploads a queued attachment once the note exists server-side and caches the DTO locally', async () => {
    const note = notesRepo.createNote({ workspaceId: 'ws-default', title: 'With attachment' });
    db.run("UPDATE notes SET server_id = 'srv-att-1', sync_state = 'synced' WHERE id = ?", [note.id]);
    // Seed a pull cursor so this run is incremental (no absence
    // reconciliation — the empty memo list must not purge the note).
    db.run(
      `INSERT OR REPLACE INTO sync_state (server_key, user_id, workspace_id, last_pull_at, last_full_sync_at)
       VALUES (?, ?, 'ws-default', ?, ?)`,
      [scope.serverKey, scope.userId, Date.now(), Date.now()],
    );

    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'attachment_upload',
      payload: {
        attachmentId: 'local-att-1',
        uri: 'file:///tmp/photo.jpg',
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
      },
    });

    let uploadSeen = false;
    transport.post('/api/v1/attachments/memo/srv-att-1', () => {
      uploadSeen = true;
      return MockHttpTransport.json(201, {
        attachment: {
          id: 'srv-attachment-9',
          memoId: 'srv-att-1',
          fileName: 'photo.jpg',
          fileSize: 1024,
          mimeType: 'image/jpeg',
          createdAt: 1720000001000,
          url: '/api/v1/attachments/srv-attachment-9/file',
        },
      });
    });

    await engine.runSync({ workspaceId: 'ws-default' });

    expect(uploadSeen).toBe(true);
    const after = notesRepo.getNoteById(note.id);
    expect(after?.attachments).toHaveLength(1);
    expect(after?.attachments[0]?.id).toBe('srv-attachment-9');
    expect(outbox.getPendingCount()).toBe(0);
  });

  it('keeps the upload queued (retryable) while the note has not synced yet', async () => {
    const note = notesRepo.createNote({ workspaceId: 'ws-default', title: 'Offline note' });
    // no server_id yet — create op not pushed
    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'attachment_upload',
      payload: { attachmentId: 'a1', uri: 'file:///x.png', fileName: 'x.png', mimeType: 'image/png', fileSize: 10 },
    });

    const res = await engine.runSync({ workspaceId: 'ws-default' });
    // The upload itself is not a "fatal" client error — it waits for the note.
    expect(outbox.getPendingCount()).toBe(1);
    const entry = outbox.listAllEntries().find((e) => e.op === 'attachment_upload');
    expect(entry?.status).toBe('pending');
    expect(res.pushed).toBe(0);
  });

  it('treats attachment delete 404 as success and updates the local cache', async () => {
    const note = notesRepo.createNote({ workspaceId: 'ws-default', title: 'Doc' });
    db.run("UPDATE notes SET server_id = 'srv-att-2', sync_state = 'synced' WHERE id = ?", [note.id]);
    db.run(
      `INSERT OR REPLACE INTO sync_state (server_key, user_id, workspace_id, last_pull_at, last_full_sync_at)
       VALUES (?, ?, 'ws-default', ?, ?)`,
      [scope.serverKey, scope.userId, Date.now(), Date.now()],
    );
    db.run(
      `UPDATE notes SET attachments_json = ? WHERE id = ?`,
      [
        JSON.stringify([
          { id: 'srv-attachment-9', memoId: 'srv-att-2', fileName: 'photo.jpg', fileSize: 1024, mimeType: 'image/jpeg', createdAt: 1 },
        ]),
        note.id,
      ],
    );

    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'attachment_delete',
      payload: { attachmentId: 'srv-attachment-9' },
    });

    transport.delete('/api/v1/attachments/srv-attachment-9', () =>
      MockHttpTransport.json(404, { error: 'Not Found', message: 'gone' }),
    );

    const res = await engine.runSync({ workspaceId: 'ws-default' });
    expect(res.pushed).toBe(1);
    expect(notesRepo.getNoteById(note.id)?.attachments).toHaveLength(0);
  });
});

describe('Upcoming reminder collection', () => {
  const now = 1_700_000_000_000;

  it('collects only future reminders within the window, capped, filtered by trash/archive', () => {
    const notes = [
      { id: 'n1', title: 'A', content: 'x', reminderTime: now + 60_000, deletedAt: null, isArchived: false },
      { id: 'n2', title: 'B', content: 'y', reminderTime: now + 90_000, deletedAt: now, isArchived: false },
      { id: 'n3', title: 'C', content: 'z', reminderTime: now + 120_000, deletedAt: null, isArchived: true },
      { id: 'n4', title: 'D', content: 'w', reminderTime: now - 60_000, deletedAt: null, isArchived: false },
      { id: 'n5', title: 'E', content: 'v', reminderTime: null, deletedAt: null, isArchived: false },
    ];
    const reminders = collectUpcomingReminders(notes, now);
    expect(reminders.map((r) => r.noteId)).toEqual(['n1']);
  });

  it('caps the number of scheduled reminders', () => {
    const notes = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      title: `T${i}`,
      content: '',
      reminderTime: now + 1000 * (i + 1),
      deletedAt: null,
      isArchived: false,
    }));
    expect(collectUpcomingReminders(notes, now)).toHaveLength(25);
  });
});

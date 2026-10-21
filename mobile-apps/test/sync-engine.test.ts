import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine } from '@/features/sync/engine';
import { NotesRepository } from '@/features/notes/repository';
import { WorkspaceRepository } from '@/features/workspaces/repository';
import { OutboxQueue } from '@/features/sync/outbox';
import { NodeSqliteDriver } from '@/services/db/driver.node';
import { initializeDatabase } from '@/services/db/database';
import { ApiClient } from '@/services/api/client';
import { MockHttpTransport } from './helpers/mock-transport';

describe('Synchronization Engine', () => {
  let db: NodeSqliteDriver;
  let transport: MockHttpTransport;
  let api: ApiClient;
  let notesRepo: NotesRepository;
  let workspaceRepo: WorkspaceRepository;
  let outbox: OutboxQueue;
  let engine: SyncEngine;

  const scope = { serverKey: 'https://notes.example.com', userId: 'user-sync-1' };

  beforeEach(() => {
    db = new NodeSqliteDriver(':memory:');
    initializeDatabase(db);
    transport = new MockHttpTransport();
    api = new ApiClient({ baseUrl: 'https://notes.example.com', transport, token: 'test-token' });

    notesRepo = new NotesRepository(db, scope);
    workspaceRepo = new WorkspaceRepository(db, scope);
    outbox = new OutboxQueue(db, scope);

    engine = new SyncEngine({
      api,
      notesRepo,
      workspaceRepo,
      outbox,
      db,
      scope,
    });

    // Default metadata handlers
    transport.on('/api/v1/auth/me', () =>
      MockHttpTransport.json(200, {
        user: { id: scope.userId, email: 'sync@example.com', name: 'Sync User', createdAt: 1700000000000 },
        workspaces: [{ id: 'ws-default', name: 'Default', role: 'owner' }],
      }),
    );
    transport.on('/api/v1/notifications', () => MockHttpTransport.json(200, { notifications: [], unread: 0 }));
    transport.on('/api/v1/folders', () => MockHttpTransport.json(200, { folders: [] }));
    transport.on('/api/v1/categories', () => MockHttpTransport.json(200, { categories: [] }));
    transport.on('/api/v1/tags', () => MockHttpTransport.json(200, { tags: [] }));
    transport.get('/api/v1/memos/', () => MockHttpTransport.json(200, { memos: [], total: 0, page: 1, limit: 100 }));
  });

  it('pushes offline created note with clientId and links server identity', async () => {
    const note = notesRepo.createNote({
      workspaceId: 'ws-default',
      title: 'Created Offline',
      content: 'Will be synced',
      color: 'blue',
      clientId: 'mobile-client-unique-1234',
    });

    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'create',
      payload: {
        workspaceId: note.workspaceId,
        title: note.title,
        content: note.content,
        color: note.color,
      },
      clientId: note.clientId,
    });

    transport.post('/api/v1/memos/', (req) => {
      const body = JSON.parse(req.body as string);
      expect(body.title).toBe('Created Offline');
      expect(body.clientId).toBe('mobile-client-unique-1234');
      return MockHttpTransport.json(201, {
        memo: {
          id: 'server-memo-999',
          workspaceId: 'ws-default',
          folderId: null,
          categoryId: null,
          title: 'Created Offline',
          content: 'Will be synced',
          color: 'blue',
          theme: 'default',
          priority: 'medium',
          status: 'pending',
          noteType: 'text',
          sortOrder: 0,
          isFavorite: false,
          isPinned: false,
          isArchived: false,
          dueDate: null,
          reminderTime: null,
          reminderLocation: null,
          collaborators: [],
          checklistData: [],
          linkPreviews: [],
          attachments: [],
          tags: [],
          clientId: 'mobile-client-unique-1234',
          version: 1,
          createdBy: scope.userId,
          createdAt: 1720000000000,
          updatedAt: 1720000000000,
          deletedAt: null,
        },
      });
    });

    const result = await engine.runSync({ workspaceId: 'ws-default' });
    expect(result.pushed).toBe(1);
    expect(outbox.getPendingCount()).toBe(0);

    const updatedLocal = notesRepo.getNoteById(note.id);
    expect(updatedLocal?.serverId).toBe('server-memo-999');
    expect(updatedLocal?.serverVersion).toBe(1);
    expect(updatedLocal?.syncState).toBe('synced');
  });

  it('handles 409 version conflicts and lets user choose Keep Mine or Use Server', async () => {
    // Setup note as previously synced
    const note = notesRepo.createNote({
      workspaceId: 'ws-default',
      title: 'Local Version 2',
      content: 'Edited on mobile',
    });
    // Manually set server_id and server_version = 2
    db.run(
      "UPDATE notes SET server_id = 'server-conflicted', server_version = 2, sync_state = 'pending' WHERE id = ?",
      [note.id],
    );

    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'update',
      payload: {
        serverId: 'server-conflicted',
        title: 'Local Version 2',
        content: 'Edited on mobile',
      },
      baseVersion: 2,
    });

    // Server returns 409 because another device bumped version to 3
    transport.on('/api/v1/memos/server-conflicted', (req) => {
      if (req.method === 'PATCH') {
        const body = JSON.parse(req.body as string);
        if (body.version === 2) {
          return MockHttpTransport.json(409, {
            error: 'Conflict',
            message: 'Version conflict: memo version is 3, but update requested version 2',
            currentVersion: 3,
          });
        }
        // If version is omitted or matches, succeed
        return MockHttpTransport.json(200, {
          memo: {
            id: 'server-conflicted',
            workspaceId: 'ws-default',
            title: body.title,
            content: body.content,
            color: 'default',
            theme: 'default',
            priority: 'medium',
            status: 'pending',
            noteType: 'text',
            sortOrder: 0,
            isFavorite: false,
            isPinned: false,
            isArchived: false,
            dueDate: null,
            reminderTime: null,
            reminderLocation: null,
            collaborators: [],
            checklistData: [],
            linkPreviews: [],
            attachments: [],
            tags: [],
            clientId: null,
            version: 4,
            createdBy: scope.userId,
            createdAt: 1720000000000,
            updatedAt: 1720000005000,
            deletedAt: null,
          },
        });
      }
      return MockHttpTransport.json(404, {});
    });

    const res = await engine.runSync({ workspaceId: 'ws-default' });
    expect(res.conflicts).toBe(1);

    const conflictedNote = notesRepo.getNoteById(note.id);
    expect(conflictedNote?.syncState).toBe('conflicted');
    expect(outbox.getFailedCount()).toBe(1); // status: conflicted counts as non-pending

    // User chooses "Keep Mine" (force overwrite)
    await engine.resolveConflictKeepMine(note.id);

    // Queue should now be clean and synced
    const resolvedNote = notesRepo.getNoteById(note.id);
    expect(resolvedNote?.syncState).toBe('synced');
    expect(resolvedNote?.serverVersion).toBe(4);
    expect(outbox.getPendingCount()).toBe(0);
  });

  it('pulls server changes without overwriting pending local edits', async () => {
    // 1. A local note has pending offline edits
    const localPending = notesRepo.createNote({
      workspaceId: 'ws-default',
      title: 'Local Edits In Progress',
    });
    db.run("UPDATE notes SET server_id = 'memo-shared-1', sync_state = 'pending' WHERE id = ?", [localPending.id]);

    // 2. Server has a different version of memo-shared-1
    transport.get('/api/v1/memos/', () =>
      MockHttpTransport.json(200, {
        memos: [
          {
            id: 'memo-shared-1',
            workspaceId: 'ws-default',
            folderId: null,
            categoryId: null,
            category: null,
            title: 'Server Version (Should Not Overwrite Local Pending)',
            content: 'From web',
            color: 'red',
            theme: 'default',
            priority: 'medium',
            status: 'pending',
            noteType: 'text',
            sortOrder: 0,
            isFavorite: false,
            isPinned: false,
            isArchived: false,
            dueDate: null,
            reminderTime: null,
            reminderLocation: null,
            collaborators: [],
            checklistData: [],
            linkPreviews: [],
            attachments: [],
            tags: [],
            clientId: null,
            version: 5,
            createdBy: scope.userId,
            createdAt: 1720000000000,
            updatedAt: 1720000001000,
            deletedAt: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 100,
      }),
    );

    await engine.runSync({ workspaceId: 'ws-default' });

    // Local note MUST keep its pending local edits
    const noteAfterPull = notesRepo.getNoteById(localPending.id);
    expect(noteAfterPull?.title).toBe('Local Edits In Progress');
    expect(noteAfterPull?.syncState).toBe('pending');
  });

  it('performs absence reconciliation to delete notes permanently purged on server', async () => {
    // A synced note in SQLite that is no longer on the server
    const localNote = notesRepo.createNote({
      workspaceId: 'ws-default',
      title: 'Purged on Server',
    });
    db.run("UPDATE notes SET server_id = 'memo-vanished', sync_state = 'synced' WHERE id = ?", [localNote.id]);

    // Server returns empty list on full reconciliation
    transport.on('/api/v1/memos/', () =>
      MockHttpTransport.json(200, {
        memos: [],
        total: 0,
        page: 1,
        limit: 100,
      }),
    );

    // Empty list doesn't trigger absence purge unless fullReconciliation is true and server list is verified
    // When server returns a set of memos not containing memo-vanished:
    transport.get('/api/v1/memos/', () =>
      MockHttpTransport.json(200, {
        memos: [
          {
            id: 'memo-surviving-1',
            workspaceId: 'ws-default',
            folderId: null,
            categoryId: null,
            category: null,
            title: 'I am on server',
            content: '',
            color: 'default',
            theme: 'default',
            priority: 'medium',
            status: 'pending',
            noteType: 'text',
            sortOrder: 0,
            isFavorite: false,
            isPinned: false,
            isArchived: false,
            dueDate: null,
            reminderTime: null,
            reminderLocation: null,
            collaborators: [],
            checklistData: [],
            linkPreviews: [],
            attachments: [],
            tags: [],
            clientId: null,
            version: 1,
            createdBy: scope.userId,
            createdAt: 1720000000000,
            updatedAt: 1720000001000,
            deletedAt: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 100,
      }),
    );

    await engine.runSync({ workspaceId: 'ws-default', fullReconciliation: true });

    // memo-vanished should have been purged locally
    expect(notesRepo.getNoteById(localNote.id)).toBeNull();
  });

  it('stops queue and preserves pending ops when server returns 401 Unauthorized', async () => {
    const note = notesRepo.createNote({
      workspaceId: 'ws-default',
      title: 'Auth Expired Note',
    });

    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'create',
      payload: { title: 'Auth Expired Note' },
    });

    transport.post('/api/v1/memos/', () =>
      MockHttpTransport.json(401, { error: 'Unauthorized', message: 'Session expired' }),
    );

    await expect(engine.runSync({ workspaceId: 'ws-default' })).rejects.toThrow();

    // Outbox entry MUST still be preserved for next login!
    expect(outbox.getPendingCount()).toBe(1);
    const entry = outbox.listAllEntries()[0];
    expect(entry?.op).toBe('create');
  });

  it('preserves outbox mutation when network fails mid-request', async () => {
    const note = notesRepo.createNote({
      workspaceId: 'ws-default',
      title: 'Network Failure Note',
    });

    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'create',
      payload: { title: 'Network Failure Note' },
    });

    transport.post('/api/v1/memos/', () => {
      throw new Error('Network error (DNS resolution failed)');
    });

    const res = await engine.runSync({ workspaceId: 'ws-default' });
    expect(res.errors).toBeGreaterThan(0);

    // Outbox op still exists, attempts incremented
    const all = outbox.listAllEntries();
    expect(all.length).toBe(1);
    expect(all[0]?.attempts).toBe(1);
    expect(all[0]?.lastError).toContain('Network error');
  });
});

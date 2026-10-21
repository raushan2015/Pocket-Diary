import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqliteDriver } from '@/services/db/driver.node';
import { initializeDatabase } from '@/services/db/database';
import { NotesRepository } from '@/features/notes/repository';
import { WorkspaceRepository } from '@/features/workspaces/repository';
import { OutboxQueue } from '@/features/sync/outbox';
import { SessionManager } from '@/features/auth/session-manager';
import { MemoryStore } from '@/services/storage/kv';
import { MockHttpTransport } from './helpers/mock-transport';
import { SESSION_COOKIE_NAME } from '@/services/api/contracts';

describe('Multi-server and Multi-account Data Isolation', () => {
  let db: NodeSqliteDriver;
  let prefs: MemoryStore;
  let secure: MemoryStore;
  let transport: MockHttpTransport;

  const serverA = 'https://server-a.example.com';
  const serverB = 'https://server-b.example.com';
  const user1 = 'user-alice';
  const user2 = 'user-bob';

  beforeEach(() => {
    db = new NodeSqliteDriver(':memory:');
    initializeDatabase(db);
    prefs = new MemoryStore();
    secure = new MemoryStore();
    transport = new MockHttpTransport();
  });

  const makeManager = () =>
    new SessionManager({
      prefs,
      secure,
      db,
      transport,
    });

  it('strictly isolates notes by (server_key, user_id)', () => {
    const scopeA1 = { serverKey: serverA, userId: user1 };
    const scopeA2 = { serverKey: serverA, userId: user2 };
    const scopeB1 = { serverKey: serverB, userId: user1 };

    const repoA1 = new NotesRepository(db, scopeA1);
    const repoA2 = new NotesRepository(db, scopeA2);
    const repoB1 = new NotesRepository(db, scopeB1);

    // Alice on Server A creates a note
    const noteA1 = repoA1.createNote({
      workspaceId: 'ws-a1',
      title: 'Alice on Server A',
      content: 'Secret A1',
    });

    // Bob on Server A creates a note
    const noteA2 = repoA2.createNote({
      workspaceId: 'ws-a2',
      title: 'Bob on Server A',
      content: 'Secret A2',
    });

    // Alice on Server B creates a note
    const noteB1 = repoB1.createNote({
      workspaceId: 'ws-b1',
      title: 'Alice on Server B',
      content: 'Secret B1',
    });

    // 1. Check direct ID lookups cross-boundary
    expect(repoA1.getNoteById(noteA1.id)).not.toBeNull();
    expect(repoA1.getNoteById(noteA2.id)).toBeNull(); // Alice cannot see Bob's note
    expect(repoA1.getNoteById(noteB1.id)).toBeNull(); // Alice cannot see Server B's note

    expect(repoA2.getNoteById(noteA1.id)).toBeNull(); // Bob cannot see Alice's note
    expect(repoA2.getNoteById(noteA2.id)).not.toBeNull();

    expect(repoB1.getNoteById(noteA1.id)).toBeNull(); // Server B cannot see Server A
    expect(repoB1.getNoteById(noteB1.id)).not.toBeNull();

    // 2. Check list queries
    const listA1 = repoA1.listNotes({ workspaceId: 'ws-a1' });
    expect(listA1.notes.map((n) => n.id)).toEqual([noteA1.id]);

    const listA2 = repoA2.listNotes({ workspaceId: 'ws-a2' });
    expect(listA2.notes.map((n) => n.id)).toEqual([noteA2.id]);

    const listB1 = repoB1.listNotes({ workspaceId: 'ws-b1' });
    expect(listB1.notes.map((n) => n.id)).toEqual([noteB1.id]);

    // 3. Check search queries do not bleed across boundaries
    const searchRes = repoA1.listNotes({ workspaceId: 'ws-a1', search: 'Secret' });
    expect(searchRes.notes.length).toBe(1);
    expect(searchRes.notes[0]?.title).toBe('Alice on Server A');
  });

  it('strictly isolates outbox mutation queues by (server_key, user_id)', () => {
    const scopeA1 = { serverKey: serverA, userId: user1 };
    const scopeB1 = { serverKey: serverB, userId: user1 };

    const outboxA1 = new OutboxQueue(db, scopeA1);
    const outboxB1 = new OutboxQueue(db, scopeB1);

    outboxA1.enqueue({
      entity: 'note',
      noteId: 'note-1',
      op: 'create',
      payload: { title: 'Op A1' },
    });

    outboxB1.enqueue({
      entity: 'note',
      noteId: 'note-2',
      op: 'create',
      payload: { title: 'Op B1' },
    });

    expect(outboxA1.getPendingCount()).toBe(1);
    expect(outboxB1.getPendingCount()).toBe(1);

    const readyA1 = outboxA1.getReadyEntries();
    expect(readyA1.length).toBe(1);
    expect(readyA1[0]?.payload.title).toBe('Op A1');

    const readyB1 = outboxB1.getReadyEntries();
    expect(readyB1.length).toBe(1);
    expect(readyB1[0]?.payload.title).toBe('Op B1');

    // Completing op in A1 does not alter B1
    outboxA1.markCompleted(readyA1[0]!.id);
    expect(outboxA1.getPendingCount()).toBe(0);
    expect(outboxB1.getPendingCount()).toBe(1);
  });

  it('strictly isolates workspace and tag metadata by (server_key, user_id)', () => {
    const scopeA1 = { serverKey: serverA, userId: user1 };
    const scopeB1 = { serverKey: serverB, userId: user1 };

    const wsRepoA1 = new WorkspaceRepository(db, scopeA1);
    const wsRepoB1 = new WorkspaceRepository(db, scopeB1);

    wsRepoA1.saveWorkspaces([
      { id: 'ws-a1', name: 'Server A Workspace', role: 'owner' },
    ]);
    wsRepoB1.saveWorkspaces([
      { id: 'ws-b1', name: 'Server B Workspace', role: 'owner' },
    ]);

    expect(wsRepoA1.listWorkspaces().map((w) => w.name)).toEqual(['Server A Workspace']);
    expect(wsRepoB1.listWorkspaces().map((w) => w.name)).toEqual(['Server B Workspace']);
  });

  it('isolates credentials in SecureStore across servers and accounts', async () => {
    const mgr = makeManager();

    // Setup Server A
    await mgr.saveServer({
      url: serverA,
      serverKey: serverA,
      name: 'Server A',
      addedAt: Date.now(),
    });

    // Login on Server A
    transport.on(`${serverA}/api/v1/auth/login`, () =>
      MockHttpTransport.json(
        200,
        {
          user: { id: user1, email: 'alice@a.com', name: 'Alice', createdAt: 1000 },
          activeWorkspace: { id: 'ws-a1', name: 'Workspace A1' },
        },
        { 'set-cookie': `${SESSION_COOKIE_NAME}=token-alice-server-a; Path=/; HttpOnly` },
      ),
    );
    transport.on(`${serverA}/api/v1/auth/me`, () =>
      MockHttpTransport.json(200, {
        user: { id: user1, email: 'alice@a.com', name: 'Alice', createdAt: 1000 },
        workspaces: [{ id: 'ws-a1', name: 'Workspace A1', role: 'owner' }],
      }),
    );

    const sessionA = await mgr.login({ email: 'alice@a.com', password: 'Password123' });
    expect(sessionA.token).toBe('token-alice-server-a');

    // Switch server to Server B
    await mgr.saveServer({
      url: serverB,
      serverKey: serverB,
      name: 'Server B',
      addedAt: Date.now(),
    });

    // When active server is B, Alice's token from Server A is not active
    const sessionOnB = await mgr.restoreSession();
    expect(sessionOnB).toBeNull();

    // Login on Server B
    transport.on(`${serverB}/api/v1/auth/login`, () =>
      MockHttpTransport.json(
        200,
        {
          user: { id: user1, email: 'alice@b.com', name: 'Alice', createdAt: 2000 },
          activeWorkspace: { id: 'ws-b1', name: 'Workspace B1' },
        },
        { 'set-cookie': `${SESSION_COOKIE_NAME}=token-alice-server-b; Path=/; HttpOnly` },
      ),
    );
    transport.on(`${serverB}/api/v1/auth/me`, () =>
      MockHttpTransport.json(200, {
        user: { id: user1, email: 'alice@b.com', name: 'Alice', createdAt: 2000 },
        workspaces: [{ id: 'ws-b1', name: 'Workspace B1', role: 'owner' }],
      }),
    );

    const sessionB = await mgr.login({ email: 'alice@b.com', password: 'Password123' });
    expect(sessionB.token).toBe('token-alice-server-b');

    // Switch back to Server A
    await mgr.saveServer({
      url: serverA,
      serverKey: serverA,
      name: 'Server A',
      addedAt: Date.now(),
    });

    // Server A session and token are cleanly restored
    const restoredA = await mgr.restoreSession();
    expect(restoredA?.user.email).toBe('alice@a.com');
    expect(restoredA?.token).toBe('token-alice-server-a');
  });
});

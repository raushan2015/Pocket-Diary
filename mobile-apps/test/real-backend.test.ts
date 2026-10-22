/**
 * REAL-BACKEND INTEGRATION SUITE.
 *
 * These tests boot the actual Pocket Diary backend (Fastify + SQLite, the
 * compiled `backend/dist`) and drive the REAL mobile domain stack against it
 * over real HTTP: SessionManager, SyncEngine, OutboxQueue, NotesRepository,
 * ApiClient with the production FetchTransport (no mocks of the API). The
 * only test-harness substitution is the SQLite driver (better-sqlite3
 * instead of expo-sqlite) and in-memory secure/prefs stores.
 *
 * It verifies the end-to-end offline synchronization contract:
 *   1.  connect + capability probe + sign-in
 *   2.  download existing notes; they stay available offline
 *   3.  offline note creation and editing
 *   4.  pending work survives app restart (driver reopen on the same file)
 *   5.  reconnecting syncs pending work exactly once (idempotent clientId)
 *   6.  concurrent edits produce a visible conflict (409), not silent loss
 *   7.  deletes and restores synchronize in both directions
 *   8.  expired sessions preserve pending work + safe re-authentication
 *   9.  switching servers/accounts never leaks cached data
 *   10. attachments: queued offline upload, cached download, deletion,
 *       and server-side rejection of mismatched file signatures
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NodeSqliteDriver } from '@/services/db/driver.node';
import { initializeDatabase } from '@/services/db/database';
import { MemoryStore } from '@/services/storage/kv';
import { ApiClient } from '@/services/api/client';
import { FetchTransport } from '@/services/api/transport.rn';
import { probeServer } from '@/services/api/server-check';
import * as api from '@/services/api/endpoints';
import { SessionManager } from '@/features/auth/session-manager';
import { SyncEngine } from '@/features/sync/engine';
import { OutboxQueue } from '@/features/sync/outbox';
import { NotesRepository } from '@/features/notes/repository';
import { WorkspaceRepository } from '@/features/workspaces/repository';
import { NodeAttachmentCache } from '@/services/attachments/cache.node';
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from '@/services/api/transport';

// ---------------------------------------------------------------------------
// Environment FIRST: backend config modules read env at import time.
// The statically imported modules above never read env at import time; the
// backend itself is imported dynamically inside beforeAll, after this block.
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-diary-it-'));
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '10000';
process.env.NODE_ENV = 'test';
process.env.ATTACHMENTS_DIR = path.join(tmpRoot, 'attachments');
process.env.DATABASE_PATH = path.join(tmpRoot, 'backend.db');

/** Production fetch transport with a hard on/off switch (offline simulation). */
class SwitchableTransport implements HttpTransport {
  online = true;
  private inner = new FetchTransport();
  async request(req: HttpTransportRequest): Promise<HttpTransportResponse> {
    if (!this.online) {
      throw new Error('Network request failed (simulated offline)');
    }
    return this.inner.request(req);
  }
}

// Loaded lazily from the compiled backend so the env above is in place first.
let backend: any;
let backendDb: any;

let appA: any;
let appB: any;
let urlA = '';
let urlB = '';
let backendSqlA: import('better-sqlite3').Database | null = null;

let mobileDb: NodeSqliteDriver;
let mobileDbFile: string;
let transport: SwitchableTransport;
let prefs: MemoryStore;
let secure: MemoryStore;
let sessionManager: SessionManager;
let onAuthExpired: () => Promise<void>;
let authExpiredSpy: ReturnType<typeof vi.fn>;

function makeStack() {
  const session = sessionManager.getCurrentSession();
  if (!session) throw new Error('makeStack: no active session');
  const scope = { serverKey: session.server.serverKey, userId: session.user.id };
  const notesRepo = new NotesRepository(mobileDb, scope);
  const workspaceRepo = new WorkspaceRepository(mobileDb, scope);
  const outbox = new OutboxQueue(mobileDb, scope);
  const engine = new SyncEngine({
    api: sessionManager.getApiClient()!,
    notesRepo,
    workspaceRepo,
    outbox,
    db: mobileDb,
    scope,
    onAuthExpired,
  });
  return { session, scope, notesRepo, workspaceRepo, outbox, engine };
}

/**
 * Reopens the mobile SQLite file and rebuilds the SessionManager — the
 * faithful "app process died and restarted" simulation. SecureStore
 * (tokens) and Prefs survive, exactly like the real device; the in-memory
 * session and API client are rebuilt from them.
 */
async function restartApp() {
  if (mobileDb) mobileDb.close();
  mobileDb = new NodeSqliteDriver(mobileDbFile);
  initializeDatabase(mobileDb);
  sessionManager = new SessionManager({ prefs, secure, db: mobileDb, transport });
  await sessionManager.restoreSession();
}

function webClientFor(url: string): ApiClient {
  return new ApiClient({ baseUrl: url, transport: new FetchTransport() });
}

async function registerWebUser(url: string, email: string) {
  const client = webClientFor(url);
  const res = await api.register(client, {
    email,
    password: 'Passw0rd123',
    name: 'Web User',
  });
  client.setToken(res.token);
  return { client, user: res.user, workspace: res.workspace };
}

async function bootBackend(port: number, dbPath: string) {
  const ctx = backendDb.createDatabase(dbPath);
  const app = backend.buildApp({ dbCtx: ctx, logger: false });
  await app.listen({ port, host: '127.0.0.1' });
  const address = app.addresses()[0];
  return { app, ctx, url: `http://${address.address}:${address.port}` };
}

beforeAll(async () => {
  backend = await import('../../backend/dist/app.js');
  backendDb = await import('../../backend/dist/db/index.js');

  const a = await bootBackend(0, path.join(tmpRoot, 'server-a.db'));
  appA = a.app;
  urlA = a.url;
  backendSqlA = a.ctx.sqlite;

  const b = await bootBackend(0, path.join(tmpRoot, 'server-b.db'));
  appB = b.app;
  urlB = b.url;

  mobileDbFile = path.join(tmpRoot, 'mobile.db');
  mobileDb = new NodeSqliteDriver(mobileDbFile);
  initializeDatabase(mobileDb);

  transport = new SwitchableTransport();
  prefs = new MemoryStore();
  secure = new MemoryStore();
  sessionManager = new SessionManager({ prefs, secure, db: mobileDb, transport });
  authExpiredSpy = vi.fn();
  onAuthExpired = async () => {
    authExpiredSpy();
    await sessionManager.expireSessionLocally();
  };
}, 60_000);

afterAll(async () => {
  transport.online = true;
  if (appA) await appA.close();
  if (appB) await appB.close();
  if (backendSqlA) backendSqlA.close();
  if (mobileDb) mobileDb.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // temp cleanup is best-effort
  }
});

describe('Offline synchronization against the real backend', () => {
  let web: { client: ApiClient; user: { id: string; email: string }; workspace: { id: string } };

  beforeAll(async () => {
    web = await registerWebUser(urlA, 'alice@example.com');
  });

  it('1. connects to a self-hosted server, detects capabilities, and signs in', async () => {
    const probeClient = webClientFor(urlA);
    const probe = await probeServer(probeClient);
    expect(probe.status).toBe('ok');
    if (probe.status === 'ok') {
      expect(probe.info?.name).toBe('pocket-diary');
      expect(probe.info?.capabilities.memoClientId).toBe(true);
    }

    await sessionManager.saveServer({
      url: urlA,
      serverKey: urlA,
      name: 'Pocket Diary',
      addedAt: Date.now(),
    });
    const session = await sessionManager.login({ email: 'alice@example.com', password: 'Passw0rd123' });
    expect(session.user.email).toBe('alice@example.com');
    expect(session.workspaces.length).toBeGreaterThan(0);
    expect(sessionManager.getApiClient()?.getToken()).toBeTruthy();
  });

  it('2. downloads existing notes and they remain available offline', async () => {
    // The "web" client creates a note the mobile has never seen.
    await api.createMemo(web.client, {
      workspaceId: web.workspace.id,
      title: 'From the web',
      content: 'Written in the browser',
    });

    const { engine, notesRepo, session } = makeStack();
    const res = await engine.runSync({ workspaceId: session.activeWorkspaceId });
    expect(res.pulled).toBeGreaterThanOrEqual(1);

    const local = notesRepo
      .listNotes({ workspaceId: session.activeWorkspaceId })
      .notes.find((n) => n.title === 'From the web');
    expect(local).toBeDefined();
    expect(local?.syncState).toBe('synced');

    // Go offline — the note must still be readable from local storage.
    transport.online = false;
    const offline = notesRepo
      .listNotes({ workspaceId: session.activeWorkspaceId })
      .notes.find((n) => n.title === 'From the web');
    expect(offline).toBeDefined();
    expect(offline?.content).toBe('Written in the browser');
  });

  it('3. creates and edits notes fully offline', async () => {
    // transport is OFFLINE (previous test left it off)
    expect(transport.online).toBe(false);

    const { notesRepo, outbox, session } = makeStack();
    const note = notesRepo.createNote({
      workspaceId: session.activeWorkspaceId,
      title: 'Offline note',
      content: 'First words',
      clientId: 'it-client-offline-note-0001',
    });
    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'create',
      payload: { workspaceId: note.workspaceId, title: note.title, content: note.content },
      clientId: note.clientId,
    });

    // Edit while still offline — coalesced into the pending create.
    const edited = notesRepo.updateNote(note.id, { title: 'Offline note v2', content: 'More words' });
    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'update',
      payload: {
        workspaceId: edited.workspaceId,
        title: edited.title,
        content: edited.content,
        noteType: edited.noteType,
        checklist: edited.checklist,
        serverId: edited.serverId,
      },
      baseVersion: edited.serverVersion,
    });

    expect(outbox.getPendingCount()).toBe(1); // coalesced create+update
    const stored = notesRepo.getNoteById(note.id);
    expect(stored?.title).toBe('Offline note v2');
    expect(stored?.syncState).toBe('pending');
    expect(session.user.email).toBe('alice@example.com');
  });

  it('4. closing and reopening the app preserves pending changes', async () => {
    // Simulate the app process dying: reopen the SQLite file fresh and
    // rebuild the session from the persisted secure store.
    await restartApp();

    const session = sessionManager.getCurrentSession()!;
    expect(session.user.email).toBe('alice@example.com');
    const scope = { serverKey: session.server.serverKey, userId: session.user.id };
    const outbox = new OutboxQueue(mobileDb, scope);
    const notesRepo = new NotesRepository(mobileDb, scope);

    expect(outbox.getPendingCount()).toBe(1);
    const note = notesRepo.listNotes({ workspaceId: session.activeWorkspaceId }).notes.find((n) => n.title === 'Offline note v2');
    expect(note).toBeDefined();
    expect(note?.syncState).toBe('pending');
  });

  it('5. restoring connectivity syncs pending changes exactly once', async () => {
    transport.online = true;
    const { engine, notesRepo, session } = makeStack();
    const res = await engine.runSync({ workspaceId: session.activeWorkspaceId });
    expect(res.pushed).toBe(1);

    const local = notesRepo
      .listNotes({ workspaceId: session.activeWorkspaceId })
      .notes.find((n) => n.title === 'Offline note v2');
    expect(local?.syncState).toBe('synced');
    expect(local?.serverId).toBeTruthy();

    // The server must hold EXACTLY one note with this clientId (idempotency).
    const serverMemos = await api.listMemos(web.client, { workspaceId: web.workspace.id, limit: 100 });
    const matching = serverMemos.memos.filter((m) => m.clientId === 'it-client-offline-note-0001');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.title).toBe('Offline note v2');

    // A second sync must not duplicate anything.
    const again = await engine.runSync({ workspaceId: session.activeWorkspaceId });
    expect(again.pushed).toBe(0);
    const serverMemos2 = await api.listMemos(web.client, { workspaceId: web.workspace.id, limit: 100 });
    expect(serverMemos2.memos.filter((m) => m.clientId === 'it-client-offline-note-0001')).toHaveLength(1);
  });

  it('6. concurrent edits produce a visible conflict, not silent data loss', async () => {
    const { engine, notesRepo, session, scope } = makeStack();
    const local = notesRepo
      .listNotes({ workspaceId: session.activeWorkspaceId })
      .notes.find((n) => n.title === 'Offline note v2')!;
    expect(local.serverId).toBeTruthy();

    // The other device (web) edits the same note — version bumps server-side.
    await api.updateMemo(web.client, local.serverId!, { content: 'Edited on the web' });

    // Mobile edits its stale copy (baseVersion is now behind).
    const edited = notesRepo.updateNote(local.id, { content: 'Edited on my phone' });
    new OutboxQueue(mobileDb, scope).enqueue({
      entity: 'note',
      noteId: local.id,
      op: 'update',
      payload: {
        workspaceId: edited.workspaceId,
        title: edited.title,
        content: edited.content,
        noteType: edited.noteType,
        checklist: edited.checklist,
        serverId: edited.serverId,
      },
      baseVersion: edited.serverVersion,
    });

    const res = await engine.runSync({ workspaceId: session.activeWorkspaceId });
    expect(res.conflicts).toBe(1);

    // The local conflicted copy must survive the pull that follows the 409.
    const conflicted = notesRepo.getNoteById(local.id);
    expect(conflicted?.syncState).toBe('conflicted');
    expect(conflicted?.content).toBe('Edited on my phone');

    // The user chooses "Keep mine" — the server must end up with the phone's text.
    await engine.resolveConflictKeepMine(local.id);
    const serverMemo = await api.getMemo(web.client, local.serverId!);
    expect(serverMemo.content).toBe('Edited on my phone');
    expect(notesRepo.getNoteById(local.id)?.syncState).toBe('synced');
  });

  it('7. deletes and restores synchronize correctly', async () => {
    const { engine, notesRepo, session, scope } = makeStack();
    const stackNote = notesRepo
      .listNotes({ workspaceId: session.activeWorkspaceId })
      .notes.find((n) => n.title === 'From the web')!;

    // Mobile trashes the note.
    notesRepo.trashNote(stackNote.id);
    const afterTrash = notesRepo.getNoteById(stackNote.id);
    new OutboxQueue(mobileDb, scope).enqueue({
      entity: 'note',
      noteId: stackNote.id,
      op: 'delete',
      payload: { serverId: afterTrash?.serverId },
    });
    await engine.runSync({ workspaceId: session.activeWorkspaceId });

    // Server sees it soft-deleted.
    const serverTrashed = await api.getMemo(web.client, stackNote.serverId!);
    expect(serverTrashed.deletedAt).not.toBeNull();

    // Mobile restores it.
    notesRepo.restoreNote(stackNote.id);
    const afterRestore = notesRepo.getNoteById(stackNote.id);
    new OutboxQueue(mobileDb, scope).enqueue({
      entity: 'note',
      noteId: stackNote.id,
      op: 'restore',
      payload: { serverId: afterRestore?.serverId },
    });
    await engine.runSync({ workspaceId: session.activeWorkspaceId });

    const serverRestored = await api.getMemo(web.client, stackNote.serverId!);
    expect(serverRestored.deletedAt).toBeNull();
    expect(notesRepo.getNoteById(stackNote.id)?.deletedAt).toBeNull();
  });

  it('8. expired sessions preserve pending work and allow safe reauthentication', async () => {
    const { engine, notesRepo, session, scope } = makeStack();

    // Edit while offline.
    transport.online = false;
    const local = notesRepo
      .listNotes({ workspaceId: session.activeWorkspaceId })
      .notes.find((n) => n.title === 'From the web')!;
    const edited = notesRepo.updateNote(local.id, { content: 'Edited while session expired' });
    new OutboxQueue(mobileDb, scope).enqueue({
      entity: 'note',
      noteId: local.id,
      op: 'update',
      payload: {
        workspaceId: edited.workspaceId,
        title: edited.title,
        content: edited.content,
        noteType: edited.noteType,
        checklist: edited.checklist,
        serverId: edited.serverId,
      },
      baseVersion: edited.serverVersion,
    });
    expect(outboxCount(scope)).toBe(1);

    // The server sessions are wiped (expired/revoked server-side) — this
    // also invalidates the web client's session, so it re-authenticates too.
    transport.online = true;
    backendSqlA!.prepare('DELETE FROM sessions').run();
    const webRelogin = webClientFor(urlA);
    const wl = await api.login(webRelogin, { email: 'alice@example.com', password: 'Passw0rd123' });
    webRelogin.setToken(wl.token);
    web.client = webRelogin;

    await expect(engine.runSync({ workspaceId: session.activeWorkspaceId })).rejects.toThrow();

    // The app cleared the session (routes to sign-in) but kept the work.
    expect(authExpiredSpy).toHaveBeenCalled();
    expect(sessionManager.getCurrentSession()).toBeNull();
    expect(outboxCount(scope)).toBe(1);

    // Re-authenticate as the same user — the pending op resumes.
    const relogin = await sessionManager.login({ email: 'alice@example.com', password: 'Passw0rd123' });
    expect(relogin.user.email).toBe('alice@example.com');

    // The retried op honors its exponential backoff — let it elapse.
    await new Promise((r) => setTimeout(r, 3_200));

    const stack2 = makeStack();
    const res2 = await stack2.engine.runSync({ workspaceId: stack2.session.activeWorkspaceId });
    expect(res2.pushed).toBe(1);
    const serverMemo = await api.getMemo(web.client, local.serverId!);
    expect(serverMemo.content).toBe('Edited while session expired');
    expect(outboxCount(scope)).toBe(0);
  });

  it('9. switching servers and accounts never exposes another scope’s data', async () => {
    // A second, independent server with a different user and note.
    const webB = await registerWebUser(urlB, 'bob@example.com');
    await api.createMemo(webB.client, {
      workspaceId: webB.workspace.id,
      title: 'Bobs private note',
      content: 'Only on server B',
    });

    // Switch the mobile app to server B and sign in.
    await sessionManager.saveServer({
      url: urlB,
      serverKey: urlB,
      name: 'Pocket Diary B',
      addedAt: Date.now(),
    });
    const restored = await sessionManager.restoreSession();
    expect(restored).toBeNull(); // no account on B yet

    const sessionB = await sessionManager.login({ email: 'bob@example.com', password: 'Passw0rd123' });
    expect(sessionB.user.email).toBe('bob@example.com');

    const stackB = makeStack();
    await stackB.engine.runSync({ workspaceId: stackB.session.activeWorkspaceId });
    const bNotes = stackB.notesRepo.listNotes({ workspaceId: stackB.session.activeWorkspaceId }).notes;
    expect(bNotes.map((n) => n.title)).toContain('Bobs private note');
    expect(bNotes.some((n) => n.title === 'From the web')).toBe(false); // server A data must not leak

    // Switch back to server A — the A session (token) is still valid.
    await sessionManager.setActiveServer(urlA);
    const sessionA = await sessionManager.restoreSession();
    expect(sessionA?.user.email).toBe('alice@example.com');

    const stackA = makeStack();
    const aNotes = stackA.notesRepo.listNotes({ workspaceId: stackA.session.activeWorkspaceId }).notes;
    expect(aNotes.some((n) => n.title === 'From the web')).toBe(true);
    expect(aNotes.some((n) => n.title === 'Bobs private note')).toBe(false); // server B must not leak
  });

  it('10. attachments: offline-queued upload, byte-exact download, deletion, and server rejection of fakes', async () => {
    // Make sure we're on server A as alice.
    await sessionManager.setActiveServer(urlA);
    await sessionManager.restoreSession();

    const { notesRepo, session, scope } = makeStack();

    // A real PNG header (magic bytes) + padding — server verifies the signature.
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ITEST-PNG-BODY-PAYLOAD', 'utf8'),
    ]);

    transport.online = false;
    const note = notesRepo.createNote({
      workspaceId: session.activeWorkspaceId,
      title: 'Note with picture',
      clientId: 'it-client-attachment-note-1',
    });
    new OutboxQueue(mobileDb, scope).enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'create',
      payload: { workspaceId: note.workspaceId, title: note.title, content: note.content },
      clientId: note.clientId,
    });
    new OutboxQueue(mobileDb, scope).enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'attachment_upload',
      payload: {
        attachmentId: 'local-att-it-1',
        fileName: 'picture.png',
        mimeType: 'image/png',
        fileSize: pngBytes.length,
        fileBytesB64: pngBytes.toString('base64'),
      },
    });

    // Restart (persistence), reconnect, sync: note create then upload, in order.
    await restartApp();
    transport.online = true;

    const session2 = sessionManager.getCurrentSession()!;
    const scope2 = { serverKey: session2.server.serverKey, userId: session2.user.id };
    const repo2 = new NotesRepository(mobileDb, scope2);
    const outbox2 = new OutboxQueue(mobileDb, scope2);
    const engine2 = new SyncEngine({
      api: sessionManager.getApiClient()!,
      notesRepo: repo2,
      workspaceRepo: new WorkspaceRepository(mobileDb, scope2),
      outbox: outbox2,
      db: mobileDb,
      scope: scope2,
      onAuthExpired,
    });

    const res = await engine2.runSync({ workspaceId: session2.activeWorkspaceId });
    expect(res.pushed).toBe(2); // create + attachment upload

    const localNote = repo2
      .listNotes({ workspaceId: session2.activeWorkspaceId })
      .notes.find((n) => n.title === 'Note with picture')!;
    expect(localNote.serverId).toBeTruthy();
    expect(localNote.attachments).toHaveLength(1);

    // The server holds the attachment under the note.
    const serverAttachments = await api.getMemoAttachments(web.client, localNote.serverId!);
    expect(serverAttachments).toHaveLength(1);
    expect(serverAttachments[0]?.mimeType).toBe('image/png');

    // Download through the mobile attachment cache — bytes must match exactly.
    const cache = new NodeAttachmentCache(path.join(tmpRoot, 'mobile-attachments'));
    const mobileClient = sessionManager.getApiClient()!;
    const localPath = await cache.ensureCached(mobileClient, {
      id: serverAttachments[0]!.id,
      fileName: serverAttachments[0]!.fileName,
      mimeType: serverAttachments[0]!.mimeType,
    });
    expect(localPath).toBeTruthy();
    expect(fs.readFileSync(localPath!)).toEqual(pngBytes);

    // Delete the attachment from the phone — sync removes it server-side.
    outbox2.enqueue({
      entity: 'note',
      noteId: localNote.id,
      op: 'attachment_delete',
      payload: { attachmentId: serverAttachments[0]!.id },
    });
    await engine2.runSync({ workspaceId: session2.activeWorkspaceId });
    const afterDelete = await api.getMemoAttachments(web.client, localNote.serverId!);
    expect(afterDelete).toHaveLength(0);

    // The server still enforces its own rules: a ".png" with wrong magic bytes → 415.
    const fakeBytes = Buffer.from('<script>alert(1)</script>');
    const fakeForm = new FormData();
    fakeForm.append('file', new Blob([fakeBytes], { type: 'image/png' }), 'evil.png');
    await expect(api.uploadAttachment(web.client, localNote.serverId!, fakeForm)).rejects.toMatchObject({
      status: 415,
    });
  });

  it('background full reconciliation removes notes purged on the server', async () => {
    // Web deletes a note permanently — no tombstone reaches the client.
    const created = await api.createMemo(web.client, {
      workspaceId: web.workspace.id,
      title: 'Doomed on server',
    });
    const { engine, notesRepo, session } = makeStack();
    await engine.runSync({ workspaceId: session.activeWorkspaceId });
    expect(
      notesRepo.listNotes({ workspaceId: session.activeWorkspaceId }).notes.some((n) => n.serverId === created.id),
    ).toBe(true);

    await api.deleteMemo(web.client, created.id, { permanent: true });

    // Incremental pull: still present (updatedAt cursor never saw a change).
    await engine.runSync({ workspaceId: session.activeWorkspaceId });
    expect(
      notesRepo.listNotes({ workspaceId: session.activeWorkspaceId }).notes.some((n) => n.serverId === created.id),
    ).toBe(true);

    // Full reconciliation (first sync of a fresh install / manual resync) purges it.
    await engine.runSync({ workspaceId: session.activeWorkspaceId, fullReconciliation: true });
    expect(
      notesRepo.listNotes({ workspaceId: session.activeWorkspaceId }).notes.some((n) => n.serverId === created.id),
    ).toBe(false);
  });
});

function outboxCount(scope: { serverKey: string; userId: string }): number {
  const outbox = new OutboxQueue(mobileDb, scope);
  return outbox.getPendingCount();
}

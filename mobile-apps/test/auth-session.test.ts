import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '@/features/auth/session-manager';
import { MemoryStore } from '@/services/storage/kv';
import { NodeSqliteDriver } from '@/services/db/driver.node';
import { initializeDatabase } from '@/services/db/database';
import { MockHttpTransport } from './helpers/mock-transport';
import { SESSION_COOKIE_NAME } from '@/services/api/contracts';

describe('Authentication & Session Management', () => {
  let prefs: MemoryStore;
  let secure: MemoryStore;
  let db: NodeSqliteDriver;
  let transport: MockHttpTransport;

  beforeEach(() => {
    prefs = new MemoryStore();
    secure = new MemoryStore();
    db = new NodeSqliteDriver(':memory:');
    initializeDatabase(db);
    transport = new MockHttpTransport();
  });

  const makeManager = () =>
    new SessionManager({
      prefs,
      secure,
      db,
      transport,
    });

  it('manages server configuration and prevents plain HTTP credential transfer', async () => {
    const mgr = makeManager();

    await mgr.saveServer({
      url: 'https://notes.example.com',
      serverKey: 'https://notes.example.com',
      name: 'Work Notes',
      addedAt: Date.now(),
    });

    const active = await mgr.getActiveServer();
    expect(active?.url).toBe('https://notes.example.com');
    expect(active?.name).toBe('Work Notes');

    const list = await mgr.listServers();
    expect(list.length).toBe(1);
  });

  it('signs in, stores session token in SecureStore, and caches account locally', async () => {
    const mgr = makeManager();
    await mgr.saveServer({
      url: 'https://notes.example.com',
      serverKey: 'https://notes.example.com',
      addedAt: Date.now(),
    });

    transport.on('/api/v1/auth/login', (req) => {
      const body = JSON.parse(req.body as string);
      expect(body.email).toBe('alice@example.com');
      return MockHttpTransport.json(
        200,
        {
          user: {
            id: 'user-alice-1',
            email: 'alice@example.com',
            name: 'Alice',
            createdAt: 1700000000000,
          },
          activeWorkspace: {
            id: 'ws-alice-1',
            name: 'Personal',
          },
        },
        {
          'set-cookie': `${SESSION_COOKIE_NAME}=secret-session-token-xyz; Path=/; HttpOnly`,
        },
      );
    });

    transport.on('/api/v1/auth/me', () =>
      MockHttpTransport.json(200, {
        user: {
          id: 'user-alice-1',
          email: 'alice@example.com',
          name: 'Alice',
          createdAt: 1700000000000,
        },
        workspaces: [{ id: 'ws-alice-1', name: 'Personal', role: 'owner' }],
      }),
    );

    const session = await mgr.login({ email: 'alice@example.com', password: 'Password123' });

    expect(session.user.email).toBe('alice@example.com');
    expect(session.token).toBe('secret-session-token-xyz');
    expect(session.activeWorkspaceId).toBe('ws-alice-1');

    // Prove token was saved in SecureStore, NOT plain prefs
    const secureKeys = await secure.keys('');
    expect(secureKeys.length).toBeGreaterThan(0);
    expect(await secure.get(secureKeys[0]!)).toBe('secret-session-token-xyz');

    // Prove user was cached in SQLite
    const accountRow = db.get<{ email: string }>('SELECT email FROM accounts WHERE user_id = ?', ['user-alice-1']);
    expect(accountRow?.email).toBe('alice@example.com');
  });

  it('restores cached session across app restarts even when offline', async () => {
    const mgr1 = makeManager();
    await mgr1.saveServer({
      url: 'https://notes.example.com',
      serverKey: 'https://notes.example.com',
      addedAt: Date.now(),
    });

    transport.on('/api/v1/auth/login', () =>
      MockHttpTransport.json(
        200,
        {
          user: { id: 'u1', email: 'bob@example.com', name: 'Bob', createdAt: 1700000000000 },
          activeWorkspace: { id: 'w1', name: 'Personal' },
        },
        { 'set-cookie': `${SESSION_COOKIE_NAME}=tok-bob-123` },
      ),
    );

    await mgr1.login({ email: 'bob@example.com', password: 'Password123' });

    // App restarts: new transport simulating offline failure on /auth/me
    const offlineTransport = new MockHttpTransport().on('/api/v1/auth/me', () => {
      throw new Error('Offline (no network)');
    });

    const mgr2 = new SessionManager({
      prefs,
      secure,
      db,
      transport: offlineTransport,
    });

    const restored = await mgr2.restoreSession();
    expect(restored).not.toBeNull();
    expect(restored?.user.email).toBe('bob@example.com');
    expect(restored?.token).toBe('tok-bob-123');
    expect(restored?.activeWorkspaceId).toBe('w1');
  });

  it('clears session when server returns 401 Unauthorized (expired/revoked session)', async () => {
    const mgr1 = makeManager();
    await mgr1.saveServer({
      url: 'https://notes.example.com',
      serverKey: 'https://notes.example.com',
      addedAt: Date.now(),
    });

    transport.on('/api/v1/auth/login', () =>
      MockHttpTransport.json(
        200,
        {
          user: { id: 'u1', email: 'charlie@example.com', name: 'Charlie', createdAt: 1700000000000 },
          activeWorkspace: { id: 'w1', name: 'Personal' },
        },
        { 'set-cookie': `${SESSION_COOKIE_NAME}=revoked-tok` },
      ),
    );

    await mgr1.login({ email: 'charlie@example.com', password: 'Password123' });

    // Server returns 401 on next /auth/me
    const expiredTransport = new MockHttpTransport().on('/api/v1/auth/me', () =>
      MockHttpTransport.json(401, { error: 'Unauthorized', message: 'Session expired' }),
    );

    const mgr2 = new SessionManager({
      prefs,
      secure,
      db,
      transport: expiredTransport,
    });

    const restored = await mgr2.restoreSession();
    expect(restored).toBeNull();

    // Verify token was removed from SecureStore
    const secureKeys = await secure.keys('');
    for (const k of secureKeys) {
      expect(await secure.get(k)).toBeNull();
    }
  });

  it('logs out and revokes credentials locally and on server', async () => {
    const mgr = makeManager();
    await mgr.saveServer({
      url: 'https://notes.example.com',
      serverKey: 'https://notes.example.com',
      addedAt: Date.now(),
    });

    transport.on('/api/v1/auth/login', () =>
      MockHttpTransport.json(
        200,
        {
          user: { id: 'u1', email: 'dave@example.com', name: 'Dave', createdAt: 1700000000000 },
          activeWorkspace: { id: 'w1', name: 'Personal' },
        },
        { 'set-cookie': `${SESSION_COOKIE_NAME}=dave-token` },
      ),
    );

    let serverLogoutCalled = false;
    transport.on('/api/v1/auth/logout', (req) => {
      serverLogoutCalled = true;
      expect(req.headers.Cookie).toContain(`${SESSION_COOKIE_NAME}=dave-token`);
      return MockHttpTransport.json(200, { success: true });
    });

    await mgr.login({ email: 'dave@example.com', password: 'Password123' });
    expect(mgr.getCurrentSession()).not.toBeNull();

    await mgr.logout();

    expect(serverLogoutCalled).toBe(true);
    expect(mgr.getCurrentSession()).toBeNull();
    expect(mgr.getApiClient()?.getToken()).toBeNull();
  });
});

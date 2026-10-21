/**
 * Session Manager & Server Configuration Service.
 *
 * Enforces:
 *  - SecureStore for sensitive session tokens (never plain AsyncStorage/SQLite).
 *  - Isolation by (server_key, user_id) across all credential and data stores.
 *  - Multi-server & multi-account configuration persistence.
 *  - Sliding renewal & session expiration detection.
 */
import type { PrefsStore, SecureStore } from '@/services/storage/kv';
import { readJson, writeJson } from '@/services/storage/kv';
import type { SqliteDriver } from '@/services/db/driver';
import { ApiClient } from '@/services/api/client';
import type { HttpTransport } from '@/services/api/transport';
import { ApiError } from '@/services/api/transport';
import * as api from '@/services/api/endpoints';
import type { ApiUser, ApiWorkspace } from '@/services/api/contracts';

export interface ServerConfig {
  url: string;
  serverKey: string;
  name?: string;
  isLegacy?: boolean;
  capabilities?: {
    memoClientId?: boolean;
  };
  addedAt: number;
}

export interface SessionState {
  server: ServerConfig;
  user: ApiUser;
  activeWorkspaceId: string;
  workspaces: ApiWorkspace[];
  token: string;
}

export interface SessionManagerOptions {
  prefs: PrefsStore;
  secure: SecureStore;
  db: SqliteDriver;
  transport: HttpTransport;
}

const PREF_SERVERS_KEY = 'pocket_diary.servers';
const PREF_ACTIVE_SERVER_KEY = 'pocket_diary.active_server';

export class SessionManager {
  private prefs: PrefsStore;
  private secure: SecureStore;
  private db: SqliteDriver;
  private transport: HttpTransport;

  private currentSession: SessionState | null = null;
  private currentApiClient: ApiClient | null = null;
  private listeners = new Set<(session: SessionState | null) => void>();

  constructor(opts: SessionManagerOptions) {
    this.prefs = opts.prefs;
    this.secure = opts.secure;
    this.db = opts.db;
    this.transport = opts.transport;
  }

  subscribe(listener: (session: SessionState | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentSession);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.currentSession);
    }
  }

  getCurrentSession(): SessionState | null {
    return this.currentSession;
  }

  getApiClient(): ApiClient | null {
    return this.currentApiClient;
  }

  createApiClientForServer(serverUrl: string, token?: string | null): ApiClient {
    return new ApiClient({
      baseUrl: serverUrl,
      transport: this.transport,
      token: token ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Server Management
  // -------------------------------------------------------------------------

  async listServers(): Promise<ServerConfig[]> {
    const servers = await readJson<ServerConfig[]>(this.prefs, PREF_SERVERS_KEY);
    return servers ?? [];
  }

  async getActiveServer(): Promise<ServerConfig | null> {
    const key = await this.prefs.get(PREF_ACTIVE_SERVER_KEY);
    if (!key) return null;
    const servers = await this.listServers();
    return servers.find((s) => s.serverKey === key) ?? null;
  }

  async saveServer(server: ServerConfig): Promise<void> {
    const servers = await this.listServers();
    const existingIndex = servers.findIndex((s) => s.serverKey === server.serverKey);
    if (existingIndex >= 0) {
      servers[existingIndex] = { ...servers[existingIndex], ...server };
    } else {
      servers.push(server);
    }
    await writeJson(this.prefs, PREF_SERVERS_KEY, servers);
    await this.prefs.set(PREF_ACTIVE_SERVER_KEY, server.serverKey);
  }

  async setActiveServer(serverKey: string): Promise<ServerConfig | null> {
    const servers = await this.listServers();
    const found = servers.find((s) => s.serverKey === serverKey);
    if (!found) return null;
    await this.prefs.set(PREF_ACTIVE_SERVER_KEY, serverKey);
    // Reload session for this server
    await this.restoreSession();
    return found;
  }

  async removeServer(serverKey: string): Promise<void> {
    const servers = await this.listServers();
    const filtered = servers.filter((s) => s.serverKey !== serverKey);
    await writeJson(this.prefs, PREF_SERVERS_KEY, filtered);

    const activeKey = await this.prefs.get(PREF_ACTIVE_SERVER_KEY);
    if (activeKey === serverKey) {
      const next = filtered[0];
      if (next) {
        await this.prefs.set(PREF_ACTIVE_SERVER_KEY, next.serverKey);
      } else {
        await this.prefs.delete(PREF_ACTIVE_SERVER_KEY);
      }
      await this.restoreSession();
    }
  }

  // -------------------------------------------------------------------------
  // Token & Account Helpers
  // -------------------------------------------------------------------------

  private tokenStorageKey(serverKey: string, userId: string): string {
    // Keep short and clean for SecureStore/Keychain
    return `tok_${encodeURIComponent(serverKey)}_${encodeURIComponent(userId)}`.slice(0, 120);
  }

  private activeUserPrefKey(serverKey: string): string {
    return `pocket_diary.active_user.${serverKey}`;
  }

  private activeWorkspacePrefKey(serverKey: string, userId: string): string {
    return `pocket_diary.active_ws.${serverKey}.${userId}`;
  }

  // -------------------------------------------------------------------------
  // Session Lifecycle
  // -------------------------------------------------------------------------

  async restoreSession(): Promise<SessionState | null> {
    const server = await this.getActiveServer();
    if (!server) {
      this.currentSession = null;
      this.currentApiClient = null;
      this.notify();
      return null;
    }

    const activeUserId = await this.prefs.get(this.activeUserPrefKey(server.serverKey));
    if (!activeUserId) {
      this.currentSession = null;
      this.currentApiClient = this.createApiClientForServer(server.url);
      this.notify();
      return null;
    }

    const tokenKey = this.tokenStorageKey(server.serverKey, activeUserId);
    const token = await this.secure.get(tokenKey);
    if (!token) {
      this.currentSession = null;
      this.currentApiClient = this.createApiClientForServer(server.url);
      this.notify();
      return null;
    }

    const client = this.createApiClientForServer(server.url, token);
    this.currentApiClient = client;

    // Check cached user in SQLite
    const cachedUser = this.db.get<{
      user_id: string;
      email: string;
      name: string;
      created_at: number;
    }>(
      'SELECT user_id, email, name, created_at FROM accounts WHERE server_key = ? AND user_id = ?',
      [server.serverKey, activeUserId],
    );

    const cachedWorkspaces = this.db.all<{
      workspace_id: string;
      name: string;
      slug: string | null;
      role: string;
    }>(
      'SELECT workspace_id, name, slug, role FROM workspaces WHERE server_key = ? AND user_id = ?',
      [server.serverKey, activeUserId],
    );

    const savedWsId = await this.prefs.get(this.activeWorkspacePrefKey(server.serverKey, activeUserId));
    const activeWsId = savedWsId || cachedWorkspaces[0]?.workspace_id || '';

    if (cachedUser) {
      this.currentSession = {
        server,
        user: {
          id: cachedUser.user_id,
          email: cachedUser.email,
          name: cachedUser.name,
          createdAt: cachedUser.created_at,
        },
        workspaces: cachedWorkspaces.map((w) => ({
          id: w.workspace_id,
          name: w.name,
          slug: w.slug ?? undefined,
          role: w.role as any,
        })),
        activeWorkspaceId: activeWsId,
        token,
      };
      this.notify();
    }

    // Attempt online session verification / refresh in the background
    try {
      const me = await api.getMe(client);
      await this.saveAccountData(server.serverKey, me.user, me.workspaces, token);
      const effectiveWsId =
        (await this.prefs.get(this.activeWorkspacePrefKey(server.serverKey, me.user.id))) ||
        me.workspaces[0]?.id ||
        '';

      this.currentSession = {
        server,
        user: me.user,
        workspaces: me.workspaces,
        activeWorkspaceId: effectiveWsId,
        token,
      };
      this.notify();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Session expired or revoked on server
        await this.secure.delete(tokenKey);
        this.currentSession = null;
        this.notify();
        return null;
      }
      // If network error, the cached session above remains active (offline support!)
    }

    return this.currentSession;
  }

  async login(input: { email: string; password: string; timezone?: string }): Promise<SessionState> {
    const server = await this.getActiveServer();
    if (!server) {
      throw new Error('No server configured. Please complete server setup first.');
    }

    const client = this.createApiClientForServer(server.url);
    const authSession = await api.login(client, input);

    client.setToken(authSession.token);
    this.currentApiClient = client;

    // Fetch full workspaces list
    let workspaces: ApiWorkspace[] = authSession.workspaces ?? [];
    if (workspaces.length === 0) {
      try {
        const me = await api.getMe(client);
        workspaces = me.workspaces;
      } catch {
        if (authSession.activeWorkspace) {
          workspaces = [{ id: authSession.activeWorkspace.id, name: authSession.activeWorkspace.name, role: 'owner' }];
        }
      }
    }

    const activeWorkspaceId =
      authSession.activeWorkspace?.id ||
      workspaces[0]?.id ||
      '';

    await this.saveAccountData(server.serverKey, authSession.user, workspaces, authSession.token);
    await this.prefs.set(this.activeUserPrefKey(server.serverKey), authSession.user.id);
    await this.prefs.set(this.activeWorkspacePrefKey(server.serverKey, authSession.user.id), activeWorkspaceId);

    const sessionState: SessionState = {
      server,
      user: authSession.user,
      workspaces,
      activeWorkspaceId,
      token: authSession.token,
    };

    this.currentSession = sessionState;
    this.notify();
    return sessionState;
  }

  async register(input: { email: string; password: string; name: string; timezone?: string; inviteToken?: string }): Promise<SessionState> {
    const server = await this.getActiveServer();
    if (!server) {
      throw new Error('No server configured. Please complete server setup first.');
    }

    const client = this.createApiClientForServer(server.url);
    const authSession = await api.register(client, input);

    client.setToken(authSession.token);
    this.currentApiClient = client;

    const workspaces: ApiWorkspace[] = [authSession.workspace];
    const activeWorkspaceId = authSession.workspace.id;

    await this.saveAccountData(server.serverKey, authSession.user, workspaces, authSession.token);
    await this.prefs.set(this.activeUserPrefKey(server.serverKey), authSession.user.id);
    await this.prefs.set(this.activeWorkspacePrefKey(server.serverKey, authSession.user.id), activeWorkspaceId);

    const sessionState: SessionState = {
      server,
      user: authSession.user,
      workspaces,
      activeWorkspaceId,
      token: authSession.token,
    };

    this.currentSession = sessionState;
    this.notify();
    return sessionState;
  }

  async setActiveWorkspace(workspaceId: string): Promise<void> {
    if (!this.currentSession) return;
    this.currentSession = {
      ...this.currentSession,
      activeWorkspaceId: workspaceId,
    };
    await this.prefs.set(
      this.activeWorkspacePrefKey(this.currentSession.server.serverKey, this.currentSession.user.id),
      workspaceId,
    );
    this.notify();
  }

  async logout(): Promise<void> {
    if (this.currentSession && this.currentApiClient) {
      try {
        await api.logout(this.currentApiClient);
      } catch {
        // Best effort
      }
      const tokenKey = this.tokenStorageKey(
        this.currentSession.server.serverKey,
        this.currentSession.user.id,
      );
      await this.secure.delete(tokenKey);
    }

    this.currentSession = null;
    if (this.currentApiClient) {
      this.currentApiClient.setToken(null);
    }
    this.notify();
  }

  private async saveAccountData(
    serverKey: string,
    user: ApiUser,
    workspaces: ApiWorkspace[],
    token: string,
  ): Promise<void> {
    await this.secure.set(this.tokenStorageKey(serverKey, user.id), token);

    this.db.transaction(() => {
      this.db.run(
        'INSERT OR REPLACE INTO accounts (server_key, user_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)',
        [serverKey, user.id, user.email, user.name, user.createdAt],
      );

      const now = Date.now();
      for (const w of workspaces) {
        this.db.run(
          `INSERT OR REPLACE INTO workspaces (server_key, user_id, workspace_id, name, slug, role, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [serverKey, user.id, w.id, w.name, w.slug ?? null, w.role ?? 'editor', now],
        );
      }
    });
  }
}

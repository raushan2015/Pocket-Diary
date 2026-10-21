import React, { createContext, useContext, useEffect, useState } from 'react';
import { SessionManager, type ServerConfig, type SessionState } from './session-manager';
import type { ApiClient } from '@/services/api/client';
import type { PlatformServices } from '@/services/platform';

export interface AuthContextValue {
  session: SessionState | null;
  activeServer: ServerConfig | null;
  isReady: boolean;
  sessionManager: SessionManager;
  apiClient: ApiClient | null;
  login(input: { email: string; password: string; timezone?: string }): Promise<SessionState>;
  register(input: { email: string; password: string; name: string; timezone?: string }): Promise<SessionState>;
  logout(): Promise<void>;
  switchWorkspace(workspaceId: string): Promise<void>;
  setServer(server: ServerConfig): Promise<void>;
  disconnectServer(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  services,
  children,
}: {
  services: PlatformServices;
  children: React.ReactNode;
}) {
  const [sessionManager] = useState(
    () =>
      new SessionManager({
        prefs: services.prefs,
        secure: services.secure,
        db: services.db,
        transport: services.transport,
      }),
  );

  const [session, setSession] = useState<SessionState | null>(null);
  const [activeServer, setActiveServer] = useState<ServerConfig | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Subscribe to session changes
    const unsub = sessionManager.subscribe((s) => {
      if (!cancelled) {
        setSession(s);
      }
    });

    // Initial session & server restoration
    (async () => {
      try {
        const srv = await sessionManager.getActiveServer();
        if (!cancelled) setActiveServer(srv);

        if (srv) {
          const restored = await sessionManager.restoreSession();
          if (!cancelled) setSession(restored);
        }
      } finally {
        if (!cancelled) setIsReady(true);
      }
    })();

    return () => {
      cancelled = true;
      unsub();
    };
  }, [sessionManager]);

  const value: AuthContextValue = {
    session,
    activeServer,
    isReady,
    sessionManager,
    apiClient: sessionManager.getApiClient(),

    async login(input) {
      const res = await sessionManager.login(input);
      setSession(res);
      const srv = await sessionManager.getActiveServer();
      setActiveServer(srv);
      return res;
    },

    async register(input) {
      const res = await sessionManager.register(input);
      setSession(res);
      const srv = await sessionManager.getActiveServer();
      setActiveServer(srv);
      return res;
    },

    async logout() {
      await sessionManager.logout();
      setSession(null);
    },

    async switchWorkspace(workspaceId: string) {
      await sessionManager.setActiveWorkspace(workspaceId);
      setSession(sessionManager.getCurrentSession());
    },

    async setServer(server: ServerConfig) {
      await sessionManager.saveServer(server);
      setActiveServer(server);
      const restored = await sessionManager.restoreSession();
      setSession(restored);
    },

    async disconnectServer() {
      if (activeServer) {
        await sessionManager.removeServer(activeServer.serverKey);
        setActiveServer(null);
        setSession(null);
      }
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useAuth } from '../auth/AuthContext';
import { NotesRepository } from '../notes/repository';
import { WorkspaceRepository } from '../workspaces/repository';
import { OutboxQueue } from './outbox';
import { SyncEngine, type SyncStatus } from './engine';
import type { PlatformServices } from '@/services/platform';

export interface SyncContextValue {
  syncStatus: SyncStatus;
  isOnline: boolean;
  notesRepo: NotesRepository;
  workspaceRepo: WorkspaceRepository;
  outbox: OutboxQueue;
  runSync(options?: { workspaceId?: string; fullReconciliation?: boolean }): Promise<{
    pushed: number;
    pulled: number;
    conflicts: number;
    errors: number;
  }>;
  resolveConflictKeepMine(noteId: string): Promise<void>;
  resolveConflictUseServer(noteId: string): Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({
  services,
  children,
}: {
  services: PlatformServices;
  children: React.ReactNode;
}) {
  const { session, apiClient } = useAuth();
  const [isOnline, setIsOnline] = useState(true);

  // Derive scope: if not logged in, use fallback guest scope
  const scope = useMemo(
    () => ({
      serverKey: session?.server.serverKey ?? 'local-unauthenticated',
      userId: session?.user.id ?? 'local-guest',
    }),
    [session?.server.serverKey, session?.user.id],
  );

  const notesRepo = useMemo(() => new NotesRepository(services.db, scope), [services.db, scope]);
  const workspaceRepo = useMemo(() => new WorkspaceRepository(services.db, scope), [services.db, scope]);
  const outbox = useMemo(() => new OutboxQueue(services.db, scope), [services.db, scope]);

  const syncEngine = useMemo(() => {
    if (!apiClient) return null;
    return new SyncEngine({
      api: apiClient,
      notesRepo,
      workspaceRepo,
      outbox,
      db: services.db,
      scope,
    });
  }, [apiClient, notesRepo, workspaceRepo, outbox, services.db, scope]);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    isSyncing: false,
    pendingCount: 0,
    failedCount: 0,
    lastSyncAt: null,
    lastError: null,
  });

  // 1. Subscribe to SyncEngine status
  useEffect(() => {
    if (!syncEngine) return;
    return syncEngine.subscribe((st) => setSyncStatus(st));
  }, [syncEngine]);

  // 2. NetInfo listener
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state: NetInfoState) => {
      const connected = Boolean(state.isConnected && state.isInternetReachable !== false);
      setIsOnline(connected);
      if (connected && session && syncEngine) {
        // Trigger sync when reconnected
        void syncEngine.runSync({ workspaceId: session.activeWorkspaceId }).catch(() => {});
      }
    });
    return () => unsub();
  }, [syncEngine, session]);

  // 3. AppState listener: sync on foregrounding
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active' && session && syncEngine && isOnline) {
        void syncEngine.runSync({ workspaceId: session.activeWorkspaceId }).catch(() => {});
      }
    };
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [syncEngine, session, isOnline]);

  const value: SyncContextValue = {
    syncStatus,
    isOnline,
    notesRepo,
    workspaceRepo,
    outbox,

    async runSync(options) {
      if (!syncEngine || !session) {
        return { pushed: 0, pulled: 0, conflicts: 0, errors: 0 };
      }
      return syncEngine.runSync({
        workspaceId: options?.workspaceId || session.activeWorkspaceId,
        fullReconciliation: options?.fullReconciliation,
      });
    },

    async resolveConflictKeepMine(noteId: string) {
      if (!syncEngine) return;
      await syncEngine.resolveConflictKeepMine(noteId);
    },

    async resolveConflictUseServer(noteId: string) {
      if (!syncEngine) return;
      await syncEngine.resolveConflictUseServer(noteId);
    },
  };

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used inside SyncProvider');
  return ctx;
}

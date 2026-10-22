/**
 * Synchronization Engine (Push + Pull + Conflict Handling).
 *
 * Implements:
 *  - Push: FIFO durable outbox queue execution with idempotency keys (clientId)
 *    and optimistic concurrency version checks.
 *  - Pull: Workspace-scoped pagination with updatedAt cursor + periodic full
 *    absence reconciliation (handles server hard deletes/purges).
 *  - Conflicts: 409 parked for user resolution (Keep Mine / Use Server).
 *  - Resilient to network drops mid-request and auth expiration.
 */
import type { ApiClient } from '@/services/api/client';
import { ApiError } from '@/services/api/transport';
import * as api from '@/services/api/endpoints';
import type { NotesRepository } from '@/features/notes/repository';
import type { WorkspaceRepository } from '@/features/workspaces/repository';
import type { OutboxQueue, OutboxEntry } from './outbox';
import type { SqliteDriver } from '@/services/db/driver';
import type { NoteAttachment } from '@/features/notes/types';

/**
 * Builds the multipart form for an attachment upload from an outbox payload.
 *
 * Outbox payloads must survive JSON serialization in SQLite, so the file
 * source is always a string:
 *  - `uri` — a file:// path read by the native layer (React Native devices);
 *  - `fileBytesB64` — base64 bytes (Node test harness / tooling).
 */
export function buildAttachmentForm(payload: Record<string, any>): FormData {
  const form = new FormData();
  const fileName = payload.fileName ?? 'attachment';
  const mimeType = payload.mimeType ?? 'application/octet-stream';

  if (typeof payload.fileBytesB64 === 'string' && payload.fileBytesB64.length > 0) {
    const bytes = b64ToBytes(payload.fileBytesB64);
    // TS 5.9 + lib.dom Blob requires an ArrayBuffer-backed view.
    form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }), fileName);
  } else if (payload.uri) {
    form.append('file', {
      uri: payload.uri,
      name: fileName,
      type: mimeType,
    } as any);
  } else {
    throw new Error('Attachment payload has neither a file URI nor file content');
  }
  return form;
}

/** Base64 → bytes (works on Hermes and Node ≥ 16). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export interface SyncEngineScope {
  serverKey: string;
  userId: string;
}

export interface SyncStatus {
  isSyncing: boolean;
  pendingCount: number;
  failedCount: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export class SyncEngine {
  private api: ApiClient;
  private notesRepo: NotesRepository;
  private workspaceRepo: WorkspaceRepository;
  private outbox: OutboxQueue;
  private db: SqliteDriver;
  private scope: SyncEngineScope;

  private isRunning = false;
  private currentRun: Promise<{
    pushed: number;
    pulled: number;
    conflicts: number;
    errors: number;
  }> | null = null;
  private listeners = new Set<(status: SyncStatus) => void>();
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;

  constructor(opts: {
    api: ApiClient;
    notesRepo: NotesRepository;
    workspaceRepo: WorkspaceRepository;
    outbox: OutboxQueue;
    db: SqliteDriver;
    scope: SyncEngineScope;
    /** Invoked once when a push hits 401: the caller clears the local session (never the outbox). */
    onAuthExpired?: () => void | Promise<void>;
  }) {
    this.api = opts.api;
    this.notesRepo = opts.notesRepo;
    this.workspaceRepo = opts.workspaceRepo;
    this.outbox = opts.outbox;
    this.db = opts.db;
    this.scope = opts.scope;
    this.onAuthExpired = opts.onAuthExpired;
    // Crash recovery: anything left `in_flight` by a previous process must be
    // requeued, or it would never run again (getReadyEntries only picks `pending`).
    this.outbox.requeueInFlight();
  }

  private onAuthExpired?: () => void | Promise<void>;

  setScope(scope: SyncEngineScope): void {
    this.scope = scope;
    this.notesRepo.setScope(scope);
    this.workspaceRepo.setScope(scope);
    this.outbox.setScope(scope);
  }

  setApiClient(client: ApiClient): void {
    this.api = client;
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  getStatus(): SyncStatus {
    return {
      isSyncing: this.isRunning,
      pendingCount: this.outbox.getPendingCount(),
      failedCount: this.outbox.getFailedCount(),
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  private notify(): void {
    const s = this.getStatus();
    for (const l of this.listeners) {
      l(s);
    }
  }

  // -------------------------------------------------------------------------
  // Main Sync Runner
  // -------------------------------------------------------------------------

  async runSync(options: { workspaceId?: string; fullReconciliation?: boolean } = {}): Promise<{
    pushed: number;
    pulled: number;
    conflicts: number;
    errors: number;
  }> {
    if (!this.api.getToken()) {
      return { pushed: 0, pulled: 0, conflicts: 0, errors: 0 };
    }

    // A sync is already in flight: join it instead of silently reporting
    // "nothing happened" — callers (pull-to-refresh, reconnect, mutation
    // debounce) need the real outcome to update the UI.
    if (this.isRunning && this.currentRun) {
      return this.currentRun;
    }

    this.isRunning = true;
    this.lastError = null;
    this.notify();

    let pushed = 0;
    let pulled = 0;
    let conflicts = 0;
    let errors = 0;

    const pushedServerIds = new Set<string>();

    const run = (async () => {
      try {
        // 1. Push local mutations
        const pushRes = await this.pushOutbox(pushedServerIds);
        pushed = pushRes.pushed;
        conflicts = pushRes.conflicts;
        errors = pushRes.errors;

        // 2. Pull server changes
        const pulledCount = await this.pullServer(options, pushedServerIds);
        pulled = pulledCount;

        this.lastSyncAt = Date.now();
        return { pushed, pulled, conflicts, errors };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        if (err instanceof ApiError && err.status === 401 && this.onAuthExpired) {
          // Session expired or was revoked (also mid-pull): clear the local
          // session so the app routes to sign-in. The outbox is untouched —
          // pending work resumes after re-authentication.
          try {
            await this.onAuthExpired();
          } catch {
            // notification-only hook; never mask the sync error
          }
        }
        throw err;
      } finally {
        this.isRunning = false;
        this.currentRun = null;
        this.notify();
      }
    })();

    this.currentRun = run;
    return run;
  }

  // -------------------------------------------------------------------------
  // Push Outbox Operations
  // -------------------------------------------------------------------------

  private async pushOutbox(pushedServerIds: Set<string>): Promise<{ pushed: number; conflicts: number; errors: number }> {
    let pushed = 0;
    let conflicts = 0;
    let errors = 0;

    const readyEntries = this.outbox.getReadyEntries(50);

    for (const op of readyEntries) {
      this.outbox.markInFlight(op.id);

      try {
        await this.processOp(op, pushedServerIds);
        this.outbox.markCompleted(op.id);
        pushed++;
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 401) {
            // Auth token invalid or expired: park op as pending and abort push.
            // The outbox survives — after re-authentication the same ops run.
            this.outbox.markFailed(op.id, 'Session expired', false);
            this.outbox.requeueInFlight();
            if (this.onAuthExpired) {
              try {
                await this.onAuthExpired();
              } catch {
                // notification-only hook; never block the sync result
              }
            }
            throw err;
          }

          if (err.status === 409) {
            // Concurrency conflict
            conflicts++;
            this.outbox.markConflicted(op.id, err.serverMessage || 'Version conflict (409)');
            this.notesRepo.setSyncState(op.noteId, 'conflicted');
            continue;
          }

          if (err.status === 404 && (op.op === 'delete' || op.op === 'restore' || op.op === 'attachment_upload')) {
            // Already deleted / not found on server — consider completed.
            // For attachment_upload this means the note is gone server-side;
            // there is nothing left to attach the file to.
            this.outbox.markCompleted(op.id);
            pushed++;
            continue;
          }

          if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
            // Fatal client error (e.g. 403 Forbidden role, 400 Bad Request)
            errors++;
            this.outbox.markFailed(op.id, err.serverMessage || `HTTP ${err.status}`, true);
            this.notesRepo.setSyncState(op.noteId, 'error');
            continue;
          }
        }

        // Retryable network or server error
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        this.outbox.markFailed(op.id, msg, false);
      }
    }

    return { pushed, conflicts, errors };
  }

  private async processOp(op: OutboxEntry, pushedServerIds: Set<string>): Promise<void> {
    const localNote = this.notesRepo.getNoteById(op.noteId);

    switch (op.op) {
      case 'create': {
        const payload = op.payload;
        const createdMemo = await api.createMemo(this.api, {
          workspaceId: payload.workspaceId,
          title: payload.title,
          content: payload.content,
          color: payload.color,
          theme: payload.theme,
          priority: payload.priority,
          status: payload.status,
          noteType: payload.noteType,
          folderId: payload.folderId,
          categoryId: payload.categoryId,
          dueDate: payload.dueDate,
          reminderTime: payload.reminderTime,
          reminderLocation: payload.reminderLocation,
          checklistData: payload.checklist?.map((c: any) => ({
            id: c.id,
            text: c.text,
            checked: Boolean(c.checked),
          })),
          tags: payload.tags,
          isPinned: payload.isPinned,
          isFavorite: payload.isFavorite,
          isArchived: payload.isArchived,
          clientId: op.clientId ?? undefined,
        });

        pushedServerIds.add(createdMemo.id);

        // Link server ID and version to local note
        if (localNote) {
          this.db.run(
            `UPDATE notes SET
              server_id = ?, server_version = ?, server_updated_at = ?, sync_state = 'synced'
             WHERE id = ?`,
            [createdMemo.id, createdMemo.version, createdMemo.updatedAt, localNote.id],
          );
        }
        break;
      }

      case 'update': {
        const serverId = localNote?.serverId ?? op.payload.serverId;
        if (!serverId) {
          throw new Error('Cannot update note without server ID');
        }

        const patch = op.payload;
        const updatedMemo = await api.updateMemo(this.api, serverId, {
          title: patch.title,
          content: patch.content,
          color: patch.color,
          theme: patch.theme,
          priority: patch.priority,
          status: patch.status,
          noteType: patch.noteType,
          folderId: patch.folderId,
          categoryId: patch.categoryId,
          dueDate: patch.dueDate,
          reminderTime: patch.reminderTime,
          reminderLocation: patch.reminderLocation,
          checklistData: patch.checklist?.map((c: any) => ({
            id: c.id,
            text: c.text,
            checked: Boolean(c.checked),
          })),
          tags: patch.tags,
          isPinned: patch.isPinned,
          isFavorite: patch.isFavorite,
          isArchived: patch.isArchived,
          version: op.baseVersion ?? undefined,
        });

        pushedServerIds.add(updatedMemo.id);

        if (localNote) {
          this.db.run(
            `UPDATE notes SET
              server_version = ?, server_updated_at = ?, sync_state = 'synced'
             WHERE id = ?`,
            [updatedMemo.version, updatedMemo.updatedAt, localNote.id],
          );
        }
        break;
      }

      case 'delete': {
        const serverId = localNote?.serverId ?? op.payload.serverId;
        if (!serverId) {
          // Note never reached server
          return;
        }
        await api.deleteMemo(this.api, serverId, { permanent: Boolean(op.payload.permanent) });
        break;
      }

      case 'restore': {
        const serverId = localNote?.serverId ?? op.payload.serverId;
        if (!serverId) return;
        const restoredMemo = await api.restoreMemo(this.api, serverId);
        if (localNote) {
          this.db.run(
            `UPDATE notes SET
              server_version = ?, server_updated_at = ?, deleted_at = NULL, sync_state = 'synced'
             WHERE id = ?`,
            [restoredMemo.version, restoredMemo.updatedAt, localNote.id],
          );
        }
        break;
      }

      case 'attachment_upload': {
        const serverId = localNote?.serverId ?? op.payload.serverId;
        if (!serverId) {
          // The note itself has not reached the server yet (its create op is
          // still queued ahead of us). Wait — retryable, not an error the user
          // must fix: as soon as the create lands, the upload proceeds.
          throw new Error('Waiting for the note to sync before uploading its attachment');
        }
        const form = buildAttachmentForm(op.payload);
        const attachment = await api.uploadAttachment(this.api, serverId, form);
        if (localNote) {
          this.mergeLocalAttachment(localNote.id, {
            id: attachment.id,
            memoId: attachment.memoId,
            fileName: attachment.fileName,
            fileSize: attachment.fileSize,
            mimeType: attachment.mimeType,
            createdAt: attachment.createdAt,
            url: attachment.url,
          });
        }
        break;
      }

      case 'attachment_delete': {
        const attachmentId: string | undefined = op.payload.attachmentId;
        if (!attachmentId) return;
        try {
          await api.deleteAttachment(this.api, attachmentId);
        } catch (err) {
          // Already gone server-side (double delete) — still drop it locally.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        if (localNote) {
          this.db.run(
            `UPDATE notes SET attachments_json = ? WHERE id = ?`,
            [
              JSON.stringify(
                (localNote.attachments ?? []).filter((a) => a.id !== attachmentId),
              ),
              localNote.id,
            ],
          );
        }
        break;
      }
    }
  }

  /** Idempotently merges a server attachment DTO into the note's cached list. */
  private mergeLocalAttachment(noteId: string, attachment: NoteAttachment): void {
    const row = this.db.get<{ attachments_json: string }>(
      'SELECT attachments_json FROM notes WHERE id = ?',
      [noteId],
    );
    if (!row) return;
    let existing: NoteAttachment[] = [];
    try {
      existing = JSON.parse(row.attachments_json || '[]');
    } catch {
      existing = [];
    }
    if (existing.some((a) => a.id === attachment.id)) return;
    this.db.run('UPDATE notes SET attachments_json = ? WHERE id = ?', [
      JSON.stringify([...existing, attachment]),
      noteId,
    ]);
  }

  // -------------------------------------------------------------------------
  // Pull Server Changes
  // -------------------------------------------------------------------------

  private async pullServer(
    options: { workspaceId?: string; fullReconciliation?: boolean },
    pushedServerIds = new Set<string>(),
  ): Promise<number> {
    let pulledCount = 0;

    // 1. Refresh metadata
    try {
      const me = await api.getMe(this.api);
      this.workspaceRepo.saveWorkspaces(me.workspaces);

      const notifs = await api.getNotifications(this.api, 50);
      this.workspaceRepo.saveNotifications(notifs.notifications);
    } catch {
      // Non-fatal
    }

    const workspaces = options.workspaceId
      ? [{ id: options.workspaceId, name: '' } as any]
      : this.workspaceRepo.listWorkspaces();

    for (const ws of workspaces) {
      // Refresh folders, categories, tags for this workspace
      try {
        const [f, c, t] = await Promise.all([
          api.getFolders(this.api, ws.id),
          api.getCategories(this.api, ws.id),
          api.getTags(this.api, ws.id),
        ]);
        this.workspaceRepo.saveFolders(ws.id, f);
        this.workspaceRepo.saveCategories(ws.id, c);
        this.workspaceRepo.saveTags(ws.id, t);
      } catch {
        // Continue
      }

      // Check sync cursor for this workspace
      const syncRow = this.db.get<{
        last_pull_at: number | null;
        last_full_sync_at: number | null;
      }>(
        'SELECT last_pull_at, last_full_sync_at FROM sync_state WHERE server_key = ? AND user_id = ? AND workspace_id = ?',
        [this.scope.serverKey, this.scope.userId, ws.id],
      );

      const lastPullAt = syncRow?.last_pull_at ? Number(syncRow.last_pull_at) : 0;
      const isFull = options.fullReconciliation || !lastPullAt;
      const SKEW_MARGIN_MS = 5_000;

      let page = 1;
      const limit = 100;
      let hasMore = true;
      const serverSeenIds = new Set<string>();

      while (hasMore) {
        const res = await api.listMemos(this.api, {
          workspaceId: ws.id,
          includeDeleted: true,
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          page,
          limit,
        });

        if (res.memos.length === 0) break;

        for (const memo of res.memos) {
          serverSeenIds.add(memo.id);
          this.notesRepo.upsertSyncedNote(memo);
          pulledCount++;
        }

        const lastMemo = res.memos[res.memos.length - 1];
        if (!isFull && lastMemo && lastMemo.updatedAt < lastPullAt - SKEW_MARGIN_MS) {
          // Reached items older than our last pull cursor
          break;
        }

        if (page * limit >= res.total || res.memos.length < limit) {
          hasMore = false;
        } else {
          page++;
        }
      }

      const now = Date.now();

      // Absence reconciliation (G-3: hard-deleted / purged notes detection)
      if (isFull) {
        const localSynced = this.db.all<{ id: string; server_id: string }>(
          `SELECT id, server_id FROM notes
           WHERE server_key = ? AND user_id = ? AND workspace_id = ?
             AND server_id IS NOT NULL AND sync_state = 'synced'`,
          [this.scope.serverKey, this.scope.userId, ws.id],
        );

        for (const row of localSynced) {
          if (!serverSeenIds.has(row.server_id) && !pushedServerIds.has(row.server_id)) {
            // Note was purged from server: remove locally
            this.notesRepo.purgeNote(row.id);
          }
        }
      }

      this.db.run(
        `INSERT OR REPLACE INTO sync_state (
          server_key, user_id, workspace_id, last_pull_at, last_full_sync_at, last_push_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [
          this.scope.serverKey,
          this.scope.userId,
          ws.id,
          now,
          isFull ? now : syncRow?.last_full_sync_at ?? null,
          now,
        ],
      );
    }

    return pulledCount;
  }

  // -------------------------------------------------------------------------
  // Conflict Resolution
  // -------------------------------------------------------------------------

  /**
   * User chooses "Keep Mine":
   * Overwrite server copy with local edits (last-write-wins without version constraint).
   */
  async resolveConflictKeepMine(noteId: string): Promise<void> {
    const note = this.notesRepo.getNoteById(noteId);
    if (!note) throw new Error('Note not found');

    // Remove any conflicted outbox op for this note
    this.db.run(
      `DELETE FROM outbox WHERE server_key = ? AND user_id = ? AND note_id = ? AND status = 'conflicted'`,
      [this.scope.serverKey, this.scope.userId, noteId],
    );

    // Enqueue fresh update without baseVersion (forces server write)
    this.outbox.enqueue({
      entity: 'note',
      noteId,
      op: 'update',
      payload: {
        title: note.title,
        content: note.content,
        color: note.color,
        theme: note.theme,
        priority: note.priority,
        status: note.status,
        noteType: note.noteType,
        folderId: note.folderId,
        categoryId: note.categoryId,
        dueDate: note.dueDate,
        reminderTime: note.reminderTime,
        reminderLocation: note.reminderLocation,
        checklist: note.checklist,
        tags: note.tags,
        isPinned: note.isPinned,
        isFavorite: note.isFavorite,
        isArchived: note.isArchived,
        serverId: note.serverId,
      },
      baseVersion: null, // Omit version to bypass optimistic lock
    });

    this.notesRepo.setSyncState(noteId, 'pending');
    await this.runSync({ workspaceId: note.workspaceId });
  }

  /**
   * User chooses "Use Server":
   * Discards local patch and replaces with latest server copy.
   */
  async resolveConflictUseServer(noteId: string): Promise<void> {
    const note = this.notesRepo.getNoteById(noteId);
    if (!note || !note.serverId) throw new Error('Note not found or missing server ID');

    // Remove any outbox ops for this note
    this.db.run(
      `DELETE FROM outbox WHERE server_key = ? AND user_id = ? AND note_id = ?`,
      [this.scope.serverKey, this.scope.userId, noteId],
    );

    // Fetch latest server memo
    const memo = await api.getMemo(this.api, note.serverId);
    this.notesRepo.setSyncState(noteId, 'synced');
    this.notesRepo.upsertSyncedNote(memo);
    this.notify();
  }
}

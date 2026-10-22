/**
 * SQLite Notes Repository.
 *
 * All operations are scoped by (server_key, user_id).
 * Handles:
 *  - Full offline CRUD (create, update, soft delete, restore, purge).
 *  - Checklists, colors, tags, folders, categories, reminders.
 *  - Local search (FTS / prefix match) & status/archive filtering.
 *  - Conflict detection & resolution markers ('synced', 'pending', 'conflicted', 'error').
 */
import type { SqliteDriver } from '@/services/db/driver';
import { boolInt } from '@/services/db/driver';
import type { Note, NoteAttachment, NotePatch, NotePriority, NoteStatus, SyncState } from './types';
import type { ApiMemo } from '@/services/api/contracts';
import { defaultIdGen, type IdGen } from '@/utils/ids';
import { safeJsonArray, jsonStringify } from '@/utils/json';

export interface NotesRepoScope {
  serverKey: string;
  userId: string;
}

export interface ListNotesFilter {
  workspaceId: string;
  isPinned?: boolean;
  isArchived?: boolean;
  isFavorite?: boolean;
  hasReminder?: boolean;
  noteType?: 'text' | 'checklist';
  status?: NoteStatus;
  priority?: NotePriority;
  folderId?: string | null;
  categoryId?: string | null;
  tagName?: string;
  search?: string;
  deletedOnly?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateNoteInput {
  workspaceId: string;
  title?: string;
  content?: string;
  color?: Note['color'];
  theme?: string;
  priority?: NotePriority;
  status?: NoteStatus;
  noteType?: 'text' | 'checklist';
  folderId?: string | null;
  categoryId?: string | null;
  dueDate?: number | null;
  reminderTime?: number | null;
  reminderLocation?: string | null;
  checklist?: Note['checklist'];
  tags?: string[];
  attachments?: NoteAttachment[];
  isPinned?: boolean;
  isFavorite?: boolean;
  isArchived?: boolean;
  clientId?: string;
}

export class NotesRepository {
  private db: SqliteDriver;
  private scope: NotesRepoScope;
  private idGen: IdGen;

  constructor(db: SqliteDriver, scope: NotesRepoScope, idGen: IdGen = defaultIdGen) {
    this.db = db;
    this.scope = scope;
    this.idGen = idGen;
  }

  setScope(scope: NotesRepoScope): void {
    this.scope = scope;
  }

  private mapRow(r: any): Note {
    return {
      id: r.id,
      serverId: r.server_id ?? null,
      clientId: r.client_id ?? null,
      workspaceId: r.workspace_id,
      folderId: r.folder_id ?? null,
      categoryId: r.category_id ?? null,
      title: r.title ?? '',
      content: r.content ?? '',
      color: r.color ?? 'default',
      theme: r.theme ?? 'default',
      priority: (r.priority ?? 'medium') as NotePriority,
      status: (r.status ?? 'pending') as NoteStatus,
      noteType: (r.note_type ?? 'text') as 'text' | 'checklist',
      sortOrder: Number(r.sort_order ?? 0),
      isFavorite: Boolean(r.is_favorite),
      isPinned: Boolean(r.is_pinned),
      isArchived: Boolean(r.is_archived),
      dueDate: r.due_date != null ? Number(r.due_date) : null,
      reminderTime: r.reminder_time != null ? Number(r.reminder_time) : null,
      reminderLocation: r.reminder_location ?? null,
      checklist: safeJsonArray(r.checklist_json, []),
      tags: safeJsonArray(r.tags_json, []),
      attachments: safeJsonArray(r.attachments_json, []),
      collaborators: safeJsonArray(r.collaborators_json, []),
      linkPreviews: safeJsonArray(r.link_previews_json, []),
      category: r.category_json ? JSON.parse(r.category_json) : null,
      serverVersion: Number(r.server_version ?? 1),
      serverUpdatedAt: r.server_updated_at != null ? Number(r.server_updated_at) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      deletedAt: r.deleted_at != null ? Number(r.deleted_at) : null,
      syncState: (r.sync_state ?? 'synced') as SyncState,
    };
  }

  getNoteById(id: string): Note | null {
    const row = this.db.get(
      'SELECT * FROM notes WHERE id = ? AND server_key = ? AND user_id = ?',
      [id, this.scope.serverKey, this.scope.userId],
    );
    return row ? this.mapRow(row) : null;
  }

  getNoteByServerId(serverId: string): Note | null {
    const row = this.db.get(
      'SELECT * FROM notes WHERE server_id = ? AND server_key = ? AND user_id = ?',
      [serverId, this.scope.serverKey, this.scope.userId],
    );
    return row ? this.mapRow(row) : null;
  }

  getNoteByClientId(clientId: string): Note | null {
    const row = this.db.get(
      'SELECT * FROM notes WHERE client_id = ? AND server_key = ? AND user_id = ?',
      [clientId, this.scope.serverKey, this.scope.userId],
    );
    return row ? this.mapRow(row) : null;
  }

  listNotes(filter: ListNotesFilter): { notes: Note[]; total: number } {
    const conditions: string[] = ['server_key = ?', 'user_id = ?', 'workspace_id = ?'];
    const params: (string | number | null)[] = [
      this.scope.serverKey,
      this.scope.userId,
      filter.workspaceId,
    ];

    if (filter.deletedOnly) {
      conditions.push('deleted_at IS NOT NULL');
    } else if (!filter.includeDeleted) {
      conditions.push('deleted_at IS NULL');
    }

    if (filter.isPinned !== undefined) {
      conditions.push('is_pinned = ?');
      params.push(boolInt(filter.isPinned));
    }

    if (filter.isFavorite !== undefined) {
      conditions.push('is_favorite = ?');
      params.push(boolInt(filter.isFavorite));
    }

    if (filter.isArchived !== undefined) {
      conditions.push('is_archived = ?');
      params.push(boolInt(filter.isArchived));
    }

    if (filter.hasReminder !== undefined) {
      if (filter.hasReminder) {
        conditions.push('(reminder_time IS NOT NULL OR due_date IS NOT NULL)');
      } else {
        conditions.push('reminder_time IS NULL AND due_date IS NULL');
      }
    }

    if (filter.noteType) {
      conditions.push('note_type = ?');
      params.push(filter.noteType);
    }

    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    if (filter.priority) {
      conditions.push('priority = ?');
      params.push(filter.priority);
    }

    if (filter.folderId !== undefined) {
      if (filter.folderId === null) {
        conditions.push('folder_id IS NULL');
      } else {
        conditions.push('folder_id = ?');
        params.push(filter.folderId);
      }
    }

    if (filter.categoryId !== undefined) {
      if (filter.categoryId === null) {
        conditions.push('category_id IS NULL');
      } else {
        conditions.push('category_id = ?');
        params.push(filter.categoryId);
      }
    }

    if (filter.tagName) {
      conditions.push("tags_json LIKE ?");
      params.push(`%"${filter.tagName}"%`);
    }

    if (filter.search && filter.search.trim()) {
      const q = `%${filter.search.trim()}%`;
      conditions.push('(title LIKE ? OR content LIKE ?)');
      params.push(q, q);
    }

    const whereClause = conditions.join(' AND ');

    const countRow = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM notes WHERE ${whereClause}`,
      params,
    );
    const total = countRow ? Number(countRow.cnt) : 0;

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = this.db.all(
      `SELECT * FROM notes WHERE ${whereClause}
       ORDER BY is_pinned DESC, updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return {
      notes: rows.map((r) => this.mapRow(r)),
      total,
    };
  }

  createNote(input: CreateNoteInput, syncState: SyncState = 'pending'): Note {
    const id = this.idGen();
    const now = Date.now();
    const clientId = input.clientId ?? `mobile-${this.idGen()}`;

    this.db.run(
      `INSERT INTO notes (
        id, server_id, client_id, server_key, user_id, workspace_id,
        folder_id, category_id, title, content, color, theme, priority,
        status, note_type, sort_order, is_favorite, is_pinned, is_archived,
        due_date, reminder_time, reminder_location, checklist_json, tags_json,
        collaborators_json, link_previews_json, attachments_json, category_json,
        server_version, server_updated_at, created_at, updated_at, deleted_at, sync_state
      ) VALUES (
        ?, NULL, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, 0, ?, ?, ?,
        ?, ?, ?, ?, ?,
        '[]', '[]', ?, NULL,
        1, NULL, ?, ?, NULL, ?
      )`,
      [
        id,
        clientId,
        this.scope.serverKey,
        this.scope.userId,
        input.workspaceId,
        input.folderId ?? null,
        input.categoryId ?? null,
        input.title ?? '',
        input.content ?? '',
        input.color ?? 'default',
        input.theme ?? 'default',
        input.priority ?? 'medium',
        input.status ?? 'pending',
        input.noteType ?? 'text',
        boolInt(input.isFavorite ?? false),
        boolInt(input.isPinned ?? false),
        boolInt(input.isArchived ?? false),
        input.dueDate ?? null,
        input.reminderTime ?? null,
        input.reminderLocation ?? null,
        jsonStringify(input.checklist ?? []),
        jsonStringify(input.tags ?? []),
        jsonStringify(input.attachments ?? []),
        now,
        now,
        syncState,
      ],
    );

    const note = this.getNoteById(id);
    if (!note) throw new Error('Failed to retrieve newly created local note');
    return note;
  }

  updateNote(id: string, patch: NotePatch, syncState: SyncState = 'pending'): Note {
    const existing = this.getNoteById(id);
    if (!existing) throw new Error(`Note not found: ${id}`);

    const now = Date.now();
    const newTitle = patch.title !== undefined ? patch.title : existing.title;
    const newContent = patch.content !== undefined ? patch.content : existing.content;
    const newColor = patch.color !== undefined ? patch.color : existing.color;
    const newTheme = patch.theme !== undefined ? patch.theme : existing.theme;
    const newPriority = patch.priority !== undefined ? patch.priority : existing.priority;
    const newStatus = patch.status !== undefined ? patch.status : existing.status;
    const newNoteType = patch.noteType !== undefined ? patch.noteType : existing.noteType;
    const newSortOrder = patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder;
    const newIsFavorite = patch.isFavorite !== undefined ? patch.isFavorite : existing.isFavorite;
    const newIsPinned = patch.isPinned !== undefined ? patch.isPinned : existing.isPinned;
    const newIsArchived = patch.isArchived !== undefined ? patch.isArchived : existing.isArchived;
    const newFolderId = patch.folderId !== undefined ? patch.folderId : existing.folderId;
    const newCategoryId = patch.categoryId !== undefined ? patch.categoryId : existing.categoryId;
    const newDueDate = patch.dueDate !== undefined ? patch.dueDate : existing.dueDate;
    const newReminderTime = patch.reminderTime !== undefined ? patch.reminderTime : existing.reminderTime;
    const newReminderLocation = patch.reminderLocation !== undefined ? patch.reminderLocation : existing.reminderLocation;
    const newChecklist = patch.checklist !== undefined ? patch.checklist : existing.checklist;
    const newTags = patch.tags !== undefined ? patch.tags : existing.tags;

    this.db.run(
      `UPDATE notes SET
        title = ?, content = ?, color = ?, theme = ?, priority = ?, status = ?,
        note_type = ?, sort_order = ?, is_favorite = ?, is_pinned = ?, is_archived = ?,
        folder_id = ?, category_id = ?, due_date = ?, reminder_time = ?, reminder_location = ?,
        checklist_json = ?, tags_json = ?, updated_at = ?, sync_state = ?
      WHERE id = ? AND server_key = ? AND user_id = ?`,
      [
        newTitle,
        newContent,
        newColor,
        newTheme,
        newPriority,
        newStatus,
        newNoteType,
        newSortOrder,
        boolInt(newIsFavorite),
        boolInt(newIsPinned),
        boolInt(newIsArchived),
        newFolderId,
        newCategoryId,
        newDueDate,
        newReminderTime,
        newReminderLocation,
        jsonStringify(newChecklist),
        jsonStringify(newTags),
        now,
        syncState,
        id,
        this.scope.serverKey,
        this.scope.userId,
      ],
    );

    const updated = this.getNoteById(id);
    if (!updated) throw new Error('Failed to retrieve updated note');
    return updated;
  }

  trashNote(id: string): Note {
    const existing = this.getNoteById(id);
    if (!existing) throw new Error(`Note not found: ${id}`);
    const now = Date.now();

    this.db.run(
      'UPDATE notes SET deleted_at = ?, updated_at = ?, sync_state = ? WHERE id = ? AND server_key = ? AND user_id = ?',
      [now, now, 'pending', id, this.scope.serverKey, this.scope.userId],
    );

    return this.getNoteById(id)!;
  }

  restoreNote(id: string): Note {
    const existing = this.getNoteById(id);
    if (!existing) throw new Error(`Note not found: ${id}`);
    const now = Date.now();

    this.db.run(
      'UPDATE notes SET deleted_at = NULL, updated_at = ?, sync_state = ? WHERE id = ? AND server_key = ? AND user_id = ?',
      [now, 'pending', id, this.scope.serverKey, this.scope.userId],
    );

    return this.getNoteById(id)!;
  }

  purgeNote(id: string): void {
    this.db.run(
      'DELETE FROM notes WHERE id = ? AND server_key = ? AND user_id = ?',
      [id, this.scope.serverKey, this.scope.userId],
    );
  }

  emptyTrash(workspaceId: string): number {
    const result = this.db.run(
      'DELETE FROM notes WHERE server_key = ? AND user_id = ? AND workspace_id = ? AND deleted_at IS NOT NULL',
      [this.scope.serverKey, this.scope.userId, workspaceId],
    );
    return result.changes;
  }

  setSyncState(id: string, syncState: SyncState): void {
    this.db.run(
      'UPDATE notes SET sync_state = ? WHERE id = ? AND server_key = ? AND user_id = ?',
      [syncState, id, this.scope.serverKey, this.scope.userId],
    );
  }

  /**
   * Reconciles a server note during pull synchronization.
   * If local note has pending unpushed edits, DO NOT overwrite it.
   */
  upsertSyncedNote(apiMemo: ApiMemo): Note {
    // Check if we already have this note by server_id or client_id
    let existing = this.getNoteByServerId(apiMemo.id);
    if (!existing && apiMemo.clientId) {
      existing = this.getNoteByClientId(apiMemo.clientId);
    }

    if (existing) {
      // If note has pending local edits, preserve them! Conflict will be surfaced on push.
      // The same protection applies to `conflicted` notes: the local copy is
      // the user's version that "Keep mine" must be able to send. Overwriting
      // it with the server row (which happens right after a 409 in the same
      // sync run) would silently discard the user's edits — the exact failure
      // the conflict banner exists to prevent. `error` rows keep their local
      // state too: their op is parked for manual retry, not reconciled.
      if (existing.syncState === 'pending' || existing.syncState === 'conflicted' || existing.syncState === 'error') {
        if (existing.serverId !== apiMemo.id) {
          // Link the server ID if it was created offline
          this.db.run(
            'UPDATE notes SET server_id = ?, server_version = ? WHERE id = ?',
            [apiMemo.id, apiMemo.version, existing.id],
          );
        }
        return this.getNoteById(existing.id)!;
      }

      // Update with server values
      this.db.run(
        `UPDATE notes SET
          server_id = ?, client_id = ?, workspace_id = ?, folder_id = ?, category_id = ?,
          title = ?, content = ?, color = ?, theme = ?, priority = ?, status = ?,
          note_type = ?, sort_order = ?, is_favorite = ?, is_pinned = ?, is_archived = ?,
          due_date = ?, reminder_time = ?, reminder_location = ?, checklist_json = ?,
          tags_json = ?, collaborators_json = ?, link_previews_json = ?, attachments_json = ?,
          category_json = ?, server_version = ?, server_updated_at = ?,
          updated_at = ?, deleted_at = ?, sync_state = 'synced'
        WHERE id = ?`,
        [
          apiMemo.id,
          apiMemo.clientId ?? existing.clientId,
          apiMemo.workspaceId,
          apiMemo.folderId ?? null,
          apiMemo.categoryId ?? null,
          apiMemo.title,
          apiMemo.content,
          apiMemo.color,
          apiMemo.theme,
          apiMemo.priority,
          apiMemo.status,
          apiMemo.noteType,
          apiMemo.sortOrder,
          boolInt(apiMemo.isFavorite),
          boolInt(apiMemo.isPinned),
          boolInt(apiMemo.isArchived),
          apiMemo.dueDate ?? null,
          apiMemo.reminderTime ?? null,
          apiMemo.reminderLocation ?? null,
          jsonStringify(
            (apiMemo.checklistData ?? []).map((c) => ({
              id: c.id,
              text: c.text,
              checked: Boolean(c.checked ?? c.completed),
            })),
          ),
          jsonStringify(apiMemo.tags ?? []),
          jsonStringify(apiMemo.collaborators ?? []),
          jsonStringify(apiMemo.linkPreviews ?? []),
          jsonStringify(
            (apiMemo.attachments ?? []).map((a) => ({
              id: a.id,
              memoId: a.memoId,
              fileName: a.fileName,
              fileSize: a.fileSize,
              mimeType: a.mimeType,
              createdAt: a.createdAt,
              url: a.url,
            })),
          ),
          apiMemo.category ? jsonStringify(apiMemo.category) : null,
          apiMemo.version,
          apiMemo.updatedAt,
          apiMemo.updatedAt,
          apiMemo.deletedAt ?? null,
          existing.id,
        ],
      );

      return this.getNoteById(existing.id)!;
    }

    // Insert new synced note
    const id = this.idGen();
    this.db.run(
      `INSERT INTO notes (
        id, server_id, client_id, server_key, user_id, workspace_id,
        folder_id, category_id, title, content, color, theme, priority,
        status, note_type, sort_order, is_favorite, is_pinned, is_archived,
        due_date, reminder_time, reminder_location, checklist_json, tags_json,
        collaborators_json, link_previews_json, attachments_json, category_json,
        server_version, server_updated_at, created_at, updated_at, deleted_at, sync_state
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, 'synced'
      )`,
      [
        id,
        apiMemo.id,
        apiMemo.clientId ?? null,
        this.scope.serverKey,
        this.scope.userId,
        apiMemo.workspaceId,
        apiMemo.folderId ?? null,
        apiMemo.categoryId ?? null,
        apiMemo.title,
        apiMemo.content,
        apiMemo.color,
        apiMemo.theme,
        apiMemo.priority,
        apiMemo.status,
        apiMemo.noteType,
        apiMemo.sortOrder,
        boolInt(apiMemo.isFavorite),
        boolInt(apiMemo.isPinned),
        boolInt(apiMemo.isArchived),
        apiMemo.dueDate ?? null,
        apiMemo.reminderTime ?? null,
        apiMemo.reminderLocation ?? null,
        jsonStringify(
          (apiMemo.checklistData ?? []).map((c) => ({
            id: c.id,
            text: c.text,
            checked: Boolean(c.checked ?? c.completed),
          })),
        ),
        jsonStringify(apiMemo.tags ?? []),
        jsonStringify(apiMemo.collaborators ?? []),
        jsonStringify(apiMemo.linkPreviews ?? []),
        jsonStringify(
          (apiMemo.attachments ?? []).map((a) => ({
            id: a.id,
            memoId: a.memoId,
            fileName: a.fileName,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
            createdAt: a.createdAt,
            url: a.url,
          })),
        ),
        apiMemo.category ? jsonStringify(apiMemo.category) : null,
        apiMemo.version,
        apiMemo.updatedAt,
        apiMemo.createdAt,
        apiMemo.updatedAt,
        apiMemo.deletedAt ?? null,
      ],
    );

    return this.getNoteById(id)!;
  }
}

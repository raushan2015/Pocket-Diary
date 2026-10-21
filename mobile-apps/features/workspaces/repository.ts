/**
 * SQLite Workspaces & Metadata Repository (Folders, Categories, Tags, Notifications).
 * All queries are strictly scoped to (server_key, user_id).
 */
import type { SqliteDriver } from '@/services/db/driver';
import type { ApiFolder, ApiCategory, ApiTag, ApiNotification, ApiWorkspace } from '@/services/api/contracts';

export interface WorkspaceRepoScope {
  serverKey: string;
  userId: string;
}

export class WorkspaceRepository {
  private db: SqliteDriver;
  private scope: WorkspaceRepoScope;

  constructor(db: SqliteDriver, scope: WorkspaceRepoScope) {
    this.db = db;
    this.scope = scope;
  }

  setScope(scope: WorkspaceRepoScope): void {
    this.scope = scope;
  }

  listWorkspaces(): ApiWorkspace[] {
    const rows = this.db.all<{
      workspace_id: string;
      name: string;
      slug: string | null;
      role: string;
    }>(
      'SELECT workspace_id, name, slug, role FROM workspaces WHERE server_key = ? AND user_id = ? ORDER BY name ASC',
      [this.scope.serverKey, this.scope.userId],
    );
    return rows.map((r) => ({
      id: r.workspace_id,
      name: r.name,
      slug: r.slug ?? undefined,
      role: r.role as any,
    }));
  }

  saveWorkspaces(workspaces: ApiWorkspace[]): void {
    const now = Date.now();
    this.db.transaction(() => {
      for (const w of workspaces) {
        this.db.run(
          `INSERT OR REPLACE INTO workspaces (server_key, user_id, workspace_id, name, slug, role, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [this.scope.serverKey, this.scope.userId, w.id, w.name, w.slug ?? null, w.role ?? 'editor', now],
        );
      }
    });
  }

  listFolders(workspaceId: string): ApiFolder[] {
    const rows = this.db.all<{ id: string; workspace_id: string; name: string; parent_id: string | null }>(
      'SELECT id, workspace_id, name, parent_id FROM folders WHERE server_key = ? AND user_id = ? AND workspace_id = ? ORDER BY name ASC',
      [this.scope.serverKey, this.scope.userId, workspaceId],
    );
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      parentId: r.parent_id,
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  saveFolders(workspaceId: string, folders: ApiFolder[]): void {
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM folders WHERE server_key = ? AND user_id = ? AND workspace_id = ?',
        [this.scope.serverKey, this.scope.userId, workspaceId],
      );
      for (const f of folders) {
        this.db.run(
          'INSERT INTO folders (server_key, user_id, workspace_id, id, name, parent_id) VALUES (?, ?, ?, ?, ?, ?)',
          [this.scope.serverKey, this.scope.userId, workspaceId, f.id, f.name, f.parentId ?? null],
        );
      }
    });
  }

  listCategories(workspaceId: string): ApiCategory[] {
    const rows = this.db.all<{ id: string; workspace_id: string; name: string; color: string | null; icon: string | null }>(
      'SELECT id, workspace_id, name, color, icon FROM categories WHERE server_key = ? AND user_id = ? AND workspace_id = ? ORDER BY name ASC',
      [this.scope.serverKey, this.scope.userId, workspaceId],
    );
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      createdAt: 0,
    }));
  }

  saveCategories(workspaceId: string, categories: ApiCategory[]): void {
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM categories WHERE server_key = ? AND user_id = ? AND workspace_id = ?',
        [this.scope.serverKey, this.scope.userId, workspaceId],
      );
      for (const c of categories) {
        this.db.run(
          'INSERT INTO categories (server_key, user_id, workspace_id, id, name, color, icon) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [this.scope.serverKey, this.scope.userId, workspaceId, c.id, c.name, c.color ?? null, c.icon ?? null],
        );
      }
    });
  }

  listTags(workspaceId: string): ApiTag[] {
    const rows = this.db.all<{ id: string; workspace_id: string; name: string }>(
      'SELECT id, workspace_id, name FROM tags WHERE server_key = ? AND user_id = ? AND workspace_id = ? ORDER BY name ASC',
      [this.scope.serverKey, this.scope.userId, workspaceId],
    );
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      createdAt: 0,
    }));
  }

  saveTags(workspaceId: string, tags: ApiTag[]): void {
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM tags WHERE server_key = ? AND user_id = ? AND workspace_id = ?',
        [this.scope.serverKey, this.scope.userId, workspaceId],
      );
      for (const t of tags) {
        this.db.run(
          'INSERT INTO tags (server_key, user_id, workspace_id, id, name) VALUES (?, ?, ?, ?, ?)',
          [this.scope.serverKey, this.scope.userId, workspaceId, t.id, t.name],
        );
      }
    });
  }

  listNotifications(limit = 50): ApiNotification[] {
    const rows = this.db.all<{
      id: string;
      workspace_id: string;
      memo_id: string;
      type: string;
      title: string;
      body: string | null;
      reminder_time: number | null;
      read_at: number | null;
      created_at: number;
    }>(
      `SELECT * FROM notifications WHERE server_key = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [this.scope.serverKey, this.scope.userId, limit],
    );

    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      memoId: r.memo_id,
      type: 'reminder',
      title: r.title,
      body: r.body,
      reminderTime: r.reminder_time != null ? Number(r.reminder_time) : null,
      readAt: r.read_at != null ? Number(r.read_at) : null,
      createdAt: Number(r.created_at),
    }));
  }

  markNotificationRead(id: string): void {
    this.db.run(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND server_key = ? AND user_id = ?',
      [Date.now(), id, this.scope.serverKey, this.scope.userId],
    );
  }

  saveNotifications(notifications: ApiNotification[]): void {
    this.db.transaction(() => {
      for (const n of notifications) {
        this.db.run(
          `INSERT OR REPLACE INTO notifications (
            server_key, user_id, id, workspace_id, memo_id, type,
            title, body, reminder_time, read_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.scope.serverKey,
            this.scope.userId,
            n.id,
            n.workspaceId,
            n.memoId,
            n.type,
            n.title,
            n.body ?? null,
            n.reminderTime ?? null,
            n.readAt ?? null,
            n.createdAt,
          ],
        );
      }
    });
  }
}

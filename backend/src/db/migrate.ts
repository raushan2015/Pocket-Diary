import type Database from 'better-sqlite3';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'active',
  is_instance_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
-- NOTE: idx_sessions_public_id is intentionally NOT created here. On fresh
-- databases the sessions table already has the column, but on legacy
-- databases it does not yet — this index would crash the SCHEMA_SQL execution
-- ("no such column: public_id") before the versioned step below can add the
-- column. The L-8 step in runMigrations creates the index (and backfills
-- existing rows) in the correct order for both fresh and legacy databases.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS memos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'default',
  theme TEXT NOT NULL DEFAULT 'default',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  note_type TEXT NOT NULL DEFAULT 'text',
  sort_order INTEGER NOT NULL DEFAULT 0,
  due_date INTEGER,
  reminder_time INTEGER,
  reminder_location TEXT,
  collaborators TEXT NOT NULL DEFAULT '[]',
  checklist_data TEXT NOT NULL DEFAULT '[]',
  link_previews TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memos_workspace_id ON memos(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memos_status ON memos(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_memos_due_date ON memos(workspace_id, due_date);
CREATE INDEX IF NOT EXISTS idx_memos_deleted_at ON memos(workspace_id, deleted_at);

CREATE TABLE IF NOT EXISTS memo_tags (
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memo_id, tag_id)
);

CREATE TABLE IF NOT EXISTS memo_versions (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'reminder',
  title TEXT NOT NULL,
  body TEXT,
  reminder_time INTEGER,
  email_sent_at INTEGER,
  push_sent_at INTEGER,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(user_id, memo_id, reminder_time);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  invited_by TEXT NOT NULL REFERENCES users(id),
  email_sent_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_email ON workspace_invites(email);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);

-- Full-Text Search 5 (FTS5) Virtual Table & Triggers
CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
  title,
  content,
  content='memos',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memos_ai AFTER INSERT ON memos BEGIN
  INSERT INTO memos_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memos_ad AFTER DELETE ON memos BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memos_au AFTER UPDATE ON memos
WHEN new.title != old.title OR new.content != old.content
BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO memos_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`;

// Bump when the FTS triggers or index shape change so existing databases
// know a one-time rebuild is required (audit M-8).
const FTS_SCHEMA_VERSION = 2;

/**
 * Database schema version (audit L-15). Structural changes ship as gated
 * steps inside runMigrations and bump this number; `PRAGMA user_version`
 * records the version a database has already reached, replacing the previous
 * ad-hoc approach. Steps stay idempotent (PRAGMA guards are kept as
 * belt-and-braces for databases that predate versioning).
 */
const SCHEMA_VERSION = 3;

export function runMigrations(sqlite: Database.Database): void {
  // Base schema (idempotent CREATE IF NOT EXISTS statements)
  sqlite.exec(SCHEMA_SQL);

  const dbVersion = Number(sqlite.pragma('user_version', { simple: true }) || 0);

  // -----------------------------------------------------------------------
  // Versioned migration steps (audit L-15). Each step runs when the database
  // has not yet reached its version, then the reached version is recorded
  // via PRAGMA user_version. Add new steps with an incremented
  // SCHEMA_VERSION; never edit an already-shipped step. Steps stay
  // idempotent (PRAGMA guards are kept as belt-and-braces for databases
  // that predate versioning), so replaying one is harmless.
  // -----------------------------------------------------------------------
  if (dbVersion < SCHEMA_VERSION) {
    // --- Step v3 -----------------------------------------------------------
    // (memo color/theme/archive/checklist columns, reminder ownership,
    //  public session ids, missing indexes, FTS update-trigger upgrade)

    const memoColumns = sqlite.prepare('PRAGMA table_info(memos)').all() as Array<{ name: string }>;
    const existingNames = new Set(memoColumns.map((col) => col.name));

    const additiveColumns: Array<{ name: string; def: string }> = [
      { name: 'color', def: "ALTER TABLE memos ADD COLUMN color TEXT NOT NULL DEFAULT 'default'" },
      { name: 'theme', def: "ALTER TABLE memos ADD COLUMN theme TEXT NOT NULL DEFAULT 'default'" },
      { name: 'is_archived', def: "ALTER TABLE memos ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0" },
      { name: 'note_type', def: "ALTER TABLE memos ADD COLUMN note_type TEXT NOT NULL DEFAULT 'text'" },
      { name: 'sort_order', def: "ALTER TABLE memos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0" },
      { name: 'reminder_time', def: "ALTER TABLE memos ADD COLUMN reminder_time INTEGER" },
      { name: 'reminder_location', def: "ALTER TABLE memos ADD COLUMN reminder_location TEXT" },
      { name: 'collaborators', def: "ALTER TABLE memos ADD COLUMN collaborators TEXT NOT NULL DEFAULT '[]'" },
      { name: 'checklist_data', def: "ALTER TABLE memos ADD COLUMN checklist_data TEXT NOT NULL DEFAULT '[]'" },
      { name: 'link_previews', def: "ALTER TABLE memos ADD COLUMN link_previews TEXT NOT NULL DEFAULT '[]'" },
      // Audit H-2: who set the effective reminder — reminders notify this user only.
      { name: 'reminder_set_by', def: "ALTER TABLE memos ADD COLUMN reminder_set_by TEXT" },
    ];

    for (const col of additiveColumns) {
      if (!existingNames.has(col.name)) {
        sqlite.exec(col.def);
      }
    }

    // Audit L-8: opaque per-device session identifiers so users can revoke
    // individual devices without ever exposing the token hash. Existing rows
    // are backfilled with fresh UUIDs.
    const sessionColumns = sqlite.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!sessionColumns.some((col) => col.name === 'public_id')) {
      sqlite.exec("ALTER TABLE sessions ADD COLUMN public_id TEXT NOT NULL DEFAULT ''");
    }
    try {
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_sessions_public_id ON sessions(public_id);');
    } catch { /* non-fatal for very old databases */ }
    const backfillSessionId = sqlite.prepare('UPDATE sessions SET public_id = ? WHERE id = ?');
    const sessionsWithoutId = sqlite.prepare("SELECT id FROM sessions WHERE public_id = ''").all() as Array<{ id: string }>;
    for (const row of sessionsWithoutId) {
      backfillSessionId.run(crypto.randomUUID(), row.id);
    }

    // Audit H-2: existing notes with a reminder are attributed to their creator.
    // Re-read the column list here: on legacy databases the column was only
    // just added by the additive ALTERs above, so the pre-migration snapshot
    // (existingNames) would miss it and silently skip the backfill — caught
    // by test/migrate-legacy.test.ts against the real pre-remediation schema.
    const memoColumnsAfter = sqlite.prepare('PRAGMA table_info(memos)').all() as Array<{ name: string }>;
    if (memoColumnsAfter.some((col) => col.name === 'reminder_set_by')) {
      try {
        sqlite.exec(
          'UPDATE memos SET reminder_set_by = created_by WHERE reminder_set_by IS NULL AND COALESCE(reminder_time, due_date) IS NOT NULL'
        );
      } catch {
        // Backfill is best-effort; new writes always set the column.
      }
    }

    // Users table additive migration: instance administrator flag (SEC-03).
    const userColumns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    if (!userColumns.some((col) => col.name === 'is_instance_admin')) {
      sqlite.exec('ALTER TABLE users ADD COLUMN is_instance_admin INTEGER NOT NULL DEFAULT 0');
    }
    // Guarantee exactly one instance admin exists: the earliest registered user.
    const adminCount = sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE is_instance_admin = 1').get() as { n: number };
    if (Number(adminCount?.n ?? 0) === 0) {
      sqlite.exec(
        'UPDATE users SET is_instance_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1)'
      );
    }

    try {
      sqlite.exec("CREATE INDEX IF NOT EXISTS idx_memos_is_archived ON memos(workspace_id, is_archived);");
      sqlite.exec("CREATE INDEX IF NOT EXISTS idx_memos_sort_order ON memos(workspace_id, sort_order);");
      // Missing indexes (audit L-15): version history, attachments and tag joins.
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_memo_versions_memo_id ON memo_versions(memo_id);');
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_attachments_memo_id ON attachments(memo_id);');
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_memo_tags_tag_id ON memo_tags(tag_id);');
      // Reminder scan (audit M-9): the scan filters on COALESCE(reminder_time,
      // due_date); an expression index avoids a full table scan every tick.
      sqlite.exec('CREATE INDEX IF NOT EXISTS idx_memos_reminder_due ON memos(COALESCE(reminder_time, due_date));');
    } catch {
      // Index creation is best-effort for very old databases
    }

    // FTS maintenance (audit M-8): the expensive full index rebuild runs only
    // when the FTS trigger shape changes — the previous unconditional rebuild
    // cost O(all notes) per boot.
    if (dbVersion < FTS_SCHEMA_VERSION) {
      try {
        // Recreate the update trigger with its WHEN clause: CREATE TRIGGER IF
        // NOT EXISTS cannot upgrade the unconditional trigger on old databases.
        sqlite.exec('DROP TRIGGER IF EXISTS memos_au;');
        sqlite.exec(`CREATE TRIGGER memos_au AFTER UPDATE ON memos
WHEN new.title != old.title OR new.content != old.content
BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO memos_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;`);
        sqlite.exec("INSERT INTO memos_fts(memos_fts) VALUES('rebuild');");
      } catch {
        // Rebuild may be unnecessary or a no-op on fresh databases
      }
    }

    // Record the reached schema version.
    sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

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
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
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

CREATE TRIGGER IF NOT EXISTS memos_au AFTER UPDATE ON memos BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO memos_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`;

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(SCHEMA_SQL);
  // Safe additive migrations for existing databases
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
  ];

  for (const col of additiveColumns) {
    if (!existingNames.has(col.name)) {
      sqlite.exec(col.def);
    }
  }

  try {
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_memos_is_archived ON memos(workspace_id, is_archived);");
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_memos_sort_order ON memos(workspace_id, sort_order);");
    sqlite.exec("INSERT INTO memos_fts(memos_fts) VALUES('rebuild');");
  } catch {
    // Rebuild may be unnecessary or no-op on fresh databases
  }
}

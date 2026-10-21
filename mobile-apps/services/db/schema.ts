/**
 * Local SQLite schema (v1).
 *
 * Every data row is scope-keyed by (server_key, user_id): switching servers
 * or accounts can never read another scope's rows — isolation by
 * construction, verified by test/isolation.test.ts.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_key, user_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  role TEXT NOT NULL DEFAULT 'editor',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_key, user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  server_id TEXT,
  client_id TEXT,
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  folder_id TEXT,
  category_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'default',
  theme TEXT NOT NULL DEFAULT 'default',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  note_type TEXT NOT NULL DEFAULT 'text',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  due_date INTEGER,
  reminder_time INTEGER,
  reminder_location TEXT,
  checklist_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  collaborators_json TEXT NOT NULL DEFAULT '[]',
  link_previews_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  category_json TEXT,
  server_version INTEGER NOT NULL DEFAULT 1,
  server_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'synced'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_server_id ON notes(server_id);
CREATE INDEX IF NOT EXISTS idx_notes_scope
  ON notes(server_key, user_id, workspace_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_unsynced
  ON notes(server_key, user_id, sync_state) WHERE sync_state != 'synced';
CREATE INDEX IF NOT EXISTS idx_notes_reminder
  ON notes(server_key, user_id, reminder_time);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  note_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  base_version INTEGER,
  client_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_queue
  ON outbox(server_key, user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_note ON outbox(note_id, status);

CREATE TABLE IF NOT EXISTS sync_state (
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  last_pull_at INTEGER,
  last_full_sync_at INTEGER,
  last_push_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (server_key, user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS folders (
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  PRIMARY KEY (server_key, user_id, id)
);

CREATE TABLE IF NOT EXISTS categories (
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  PRIMARY KEY (server_key, user_id, id)
);

CREATE TABLE IF NOT EXISTS tags (
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (server_key, user_id, id)
);

CREATE TABLE IF NOT EXISTS notifications (
  server_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  reminder_time INTEGER,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_key, user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(server_key, user_id, created_at);
`;

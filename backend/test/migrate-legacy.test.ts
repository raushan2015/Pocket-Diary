/**
 * Legacy-database migration regression test.
 *
 * The live instance crashed on its first boot with the remediated image:
 * SCHEMA_SQL contained `CREATE INDEX ... ON sessions(public_id)`, but on
 * databases created by the pre-remediation image (commit e804dcf) that column
 * does not exist yet — the exec failed before the versioned migration step
 * could add it. This test recreates a REAL legacy database using the old
 * schema verbatim from that commit and proves the new code migrates it:
 *
 *   legacy (user_version 0) --createDatabase--> current schema (v4),
 *   data preserved, app boots
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Schema as shipped in commit e804dcf ("Add notifications, voice notes, keep
 * and markdown import, invites, and test suite") — the image the live
 * instance ran before the remediation. Extracted verbatim from git so this
 * fixture cannot drift from what real legacy databases actually contain.
 * Notable differences vs. today: no sessions.public_id, no memos.reminder_set_by.
 */
const LEGACY_SCHEMA_SQL = `
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

CREATE TRIGGER IF NOT EXISTS memos_au AFTER UPDATE ON memos BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO memos_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;`;

describe('Migration from the pre-remediation (e804dcf) database', () => {
  let dbPath: string;
  let tmpDir: string;
  let app: FastifyInstance | undefined;
  let dbCtx: ReturnType<typeof createDatabase> | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-legacy-'));
    dbPath = path.join(tmpDir, 'memo_manager.db');
  });

  afterEach(async () => {
    if (app) { await app.close(); app = undefined; }
    if (dbCtx) { dbCtx.sqlite.close(); dbCtx = undefined; }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates a real legacy database to v3 without crashing, preserving data', () => {
    // --- 1. Build a fully-migrated legacy database exactly as the old image did.
    const legacy = new Database(dbPath);
    legacy.exec(LEGACY_SCHEMA_SQL);
    const seed = legacy.transaction(() => {
      legacy.prepare(
        "INSERT INTO users (id, email, password_hash, name, created_at, updated_at) VALUES ('legacy-user', 'legacy@example.com', 'not-a-real-hash', 'Legacy User', 1700000000000, 1700000000000)"
      ).run();
      legacy.prepare(
        "INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at) VALUES ('legacy-ws', 'Legacy Workspace', 'legacy-ws', 'legacy-user', 1700000000000, 1700000000000)"
      ).run();
      legacy.prepare(
        "INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES ('legacy-member', 'legacy-ws', 'legacy-user', 'owner', 1700000000000)"
      ).run();
      legacy.prepare(
        "INSERT INTO memos (id, workspace_id, title, content, priority, status, version, created_by, created_at, updated_at, reminder_time) VALUES ('legacy-memo', 'legacy-ws', 'Invoice reminder legacy-seed', 'pay the invoice', 'high', 'pending', 1, 'legacy-user', 1700000000000, 1700000000000, 1700000100000)"
      ).run();
      legacy.prepare(
        "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('legacy-session-hash', 'legacy-user', 2000000000000, 1700000000000)"
      ).run();
    });
    seed();
    expect(legacy.pragma('user_version', { simple: true })).toBe(0);
    legacy.close();

    // --- 2. The new code must migrate it (this exec crashed before the fix).
    dbCtx = createDatabase(dbPath);
    const sqlite = dbCtx.sqlite;

    expect(sqlite.pragma('user_version', { simple: true })).toBe(4);

    // --- 3. The L-8 step added public_id and backfilled existing sessions.
    const sessionCols = sqlite.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(sessionCols.map((c) => c.name)).toContain('public_id');
    const session = sqlite.prepare('SELECT public_id FROM sessions WHERE id = ?').get('legacy-session-hash') as { public_id: string };
    expect(session.public_id.length).toBeGreaterThan(10);

    // --- 4. The H-2 step attributed the legacy reminder to its creator.
    const memo = sqlite.prepare('SELECT reminder_set_by, title FROM memos WHERE id = ?').get('legacy-memo') as { reminder_set_by: string | null; title: string };
    expect(memo.reminder_set_by).toBe('legacy-user');
    expect(memo.title).toBe('Invoice reminder legacy-seed');

    // --- 5. All seeded data survived.
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM memos').get() as { n: number }).n).toBe(1);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_members').get() as { n: number }).n).toBe(1);

    // --- 6. Full-text search still finds the legacy note (FTS survived; the
    //        M-8 step only swapped the update trigger and rebuilt the index).
    const hit = sqlite.prepare("SELECT rowid FROM memos_fts WHERE memos_fts MATCH 'invoice'").get();
    expect(hit).toBeTruthy();

    // --- 7. Idempotent: migrating an already-migrated database is a no-op.
    dbCtx.sqlite.close();
    dbCtx = createDatabase(dbPath);
    expect(dbCtx.sqlite.pragma('user_version', { simple: true })).toBe(4);
  });

  it('boots the full app against a migrated legacy database and serves traffic', async () => {
    // Build the legacy DB first.
    const legacy = new Database(dbPath);
    legacy.exec(LEGACY_SCHEMA_SQL);
    legacy.prepare(
      "INSERT INTO users (id, email, password_hash, name, created_at, updated_at) VALUES ('legacy-user', 'legacy@example.com', 'not-a-real-hash', 'Legacy User', 1700000000000, 1700000000000)"
    ).run();
    legacy.close();

    dbCtx = createDatabase(dbPath);
    app = buildApp({ dbCtx, logger: false });
    await app.ready();

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    // The migrated database accepts new registrations.
    const register = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'post-migration@example.com', password: 'Password123!', name: 'Post Migration' },
    });
    expect(register.statusCode).toBe(201);

    // The legacy user's rows are still readable through the API surface.
    const cookie = `memo_session=${register.cookies.find((c) => c.name === 'memo_session')?.value}`;
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    // The instance already had a user, so the earliest registered one keeps
    // the instance-admin flag (SEC-03 step) — the new registrant does not.
    expect(me.json().user.isInstanceAdmin).toBe(false);
    const legacyAdmin = dbCtx.sqlite.prepare('SELECT is_instance_admin FROM users WHERE id = ?').get('legacy-user') as { is_instance_admin: number };
    expect(legacyAdmin.is_instance_admin).toBe(1);
  });
});

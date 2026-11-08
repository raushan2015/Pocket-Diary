/**
 * AI feature database migration tests (handoff §4):
 *  - fresh DB boots at schema version 5 with every AI table present,
 *  - a REAL legacy v4-shaped database (pre-AI columns/tables) upgrades
 *    without data loss and backfills memos.ai_access to the safe default,
 *  - re-running migrations is idempotent,
 *  - user/workspace deletion cascades AI records.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import crypto from 'node:crypto';

function userVersion(sqlite: Database.Database): number {
  return Number(sqlite.pragma('user_version', { simple: true }) || 0);
}

describe('AI schema migration (v5)', () => {
  it('creates all AI tables and the memos.ai_access column on a fresh database', () => {
    const dbCtx = createDatabase(':memory:');
    try {
      expect(userVersion(dbCtx.sqlite)).toBe(5);
      const tables = dbCtx.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r: any) => r.name);
      for (const table of [
        'ai_provider_configs',
        'ai_conversations',
        'ai_messages',
        'ai_requests',
        'ai_action_proposals',
        'ai_note_grants',
        'ai_note_protected_sections',
        'ai_access_audit',
      ]) {
        expect(tables).toContain(table);
      }
      const memoCols = dbCtx.sqlite.prepare('PRAGMA table_info(memos)').all().map((c: any) => c.name);
      expect(memoCols).toContain('ai_access');
      const defaults = dbCtx.sqlite.prepare("SELECT ai_access FROM memos LIMIT 1").all();
      expect(defaults.length).toBe(0); // no rows, but the column exists
    } finally {
      dbCtx.sqlite.close();
    }
  });

  it('upgrades a legacy v4 database without losing notes and backfills ai_access', () => {
    // Build a database with ONLY the pre-AI (v4) schema and a couple of notes.
    const legacy = new Database(':memory:');
    legacy.pragma('journal_mode = WAL');
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL, avatar_url TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', status TEXT NOT NULL DEFAULT 'active', is_instance_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ip_address TEXT, user_agent TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE workspace_members (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL);
      CREATE TABLE memos (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
        client_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE memo_versions (id TEXT PRIMARY KEY, memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE, version_number INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, changed_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
    `);
    const now = Date.now();
    const userId = crypto.randomUUID();
    const wsId = crypto.randomUUID();
    const memoId = crypto.randomUUID();
    legacy.prepare("INSERT INTO users (id, email, password_hash, name, created_at, updated_at, is_instance_admin) VALUES (?, 'legacy@example.com', 'x', 'Legacy', ?, ?, 1)").run(userId, now, now);
    legacy.prepare("INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at) VALUES (?, 'Legacy WS', 'legacy-ws', ?, ?, ?)").run(wsId, userId, now, now);
    legacy.prepare("INSERT INTO memos (id, workspace_id, title, content, created_by, created_at, updated_at, version) VALUES (?, ?, 'Legacy note', 'Legacy content', ?, ?, ?, 1)").run(memoId, wsId, userId, now, now);
    legacy.pragma('user_version = 4');

    runMigrations(legacy);

    expect(userVersion(legacy)).toBe(5);
    const note = legacy.prepare('SELECT id, title, ai_access FROM memos WHERE id = ?').get(memoId) as any;
    expect(note).toBeDefined();
    expect(note.title).toBe('Legacy note'); // data preserved
    expect(note.ai_access).toBe('current_only'); // safe default backfill

    const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
    expect(tables).toContain('ai_conversations');
    legacy.close();
  });

  it('is idempotent when re-run on an already-migrated database', () => {
    const dbCtx = createDatabase(':memory:');
    try {
      expect(() => runMigrations(dbCtx.sqlite)).not.toThrow();
      expect(userVersion(dbCtx.sqlite)).toBe(5);
    } finally {
      dbCtx.sqlite.close();
    }
  });

  it('cascades AI records when a user is deleted', async () => {
    const dbCtx = createDatabase(':memory:');
    try {
      const now = Date.now();
      const userId = crypto.randomUUID();
      const wsId = crypto.randomUUID();
      const convId = crypto.randomUUID();
      const cfgId = crypto.randomUUID();
      dbCtx.sqlite.prepare("INSERT INTO users (id, email, password_hash, name, created_at, updated_at, is_instance_admin) VALUES (?, 'c@example.com', 'x', 'C', ?, ?, 1)").run(userId, now, now);
      dbCtx.sqlite.prepare("INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at) VALUES (?, 'WS', 'ws', ?, ?, ?)").run(wsId, userId, now, now);
      dbCtx.sqlite.prepare("INSERT INTO ai_provider_configs (id, user_id, provider, label, model_id, key_ciphertext, key_nonce, key_auth_tag, encryption_key_version, is_default, created_at, updated_at) VALUES (?, ?, 'openai', 'L', 'm', 'c', 'n', 't', 1, 1, ?, ?)").run(cfgId, userId, now, now);
      dbCtx.sqlite.prepare("INSERT INTO ai_conversations (id, user_id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, 'T', ?, ?)").run(convId, userId, wsId, now, now);
      dbCtx.sqlite.prepare("INSERT INTO ai_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'hello', ?)").run(crypto.randomUUID(), convId, now);

      // Mirror the app's account-deletion semantics: owned workspaces are
      // removed first (workspaces.owner_id has no cascade by design), then the
      // user row — AI records must follow via their own user/workspace FKs.
      dbCtx.sqlite.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId);
      dbCtx.sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);

      expect(dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_provider_configs').get()).toEqual({ n: 0 });
      expect(dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_conversations').get()).toEqual({ n: 0 });
      expect(dbCtx.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_messages').get()).toEqual({ n: 0 });
    } finally {
      dbCtx.sqlite.close();
    }
  });
});

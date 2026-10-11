import { describe, it, expect } from 'vitest';
import { createDatabase } from '../src/db/index.js';
import { users, workspaces, workspaceMembers, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

describe('Database and Schema', () => {
  it('initializes SQLite with WAL and foreign keys enabled', () => {
    const { sqlite } = createDatabase(':memory:');

    // In memory, foreign keys should be ON (1)
    const fkPragma = sqlite.pragma('foreign_keys', { simple: true });
    expect(fkPragma).toBe(1);

    // Busy timeout should be 5000
    const busyTimeout = sqlite.pragma('busy_timeout', { simple: true });
    expect(busyTimeout).toBe(5000);
  });

  it('enables WAL mode on file-based SQLite database', () => {
    const tempDbPath = `/tmp/test-wal-${Date.now()}.db`;
    try {
      const { sqlite } = createDatabase(tempDbPath);
      const journalMode = sqlite.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');
      sqlite.close();
    } finally {
      import('node:fs').then(fs => {
        if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
        if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
        if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
      });
    }
  });

  it('creates tables and allows relational inserts with foreign keys', () => {
    const { db } = createDatabase(':memory:');

    const userId = crypto.randomUUID();
    const wsId = crypto.randomUUID();
    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();

    // Insert user
    db.insert(users).values({
      id: userId,
      email: 'test@example.com',
      passwordHash: 'dummy_hash',
      name: 'Test User',
      createdAt: now,
      updatedAt: now,
    }).run();

    // Insert workspace
    db.insert(workspaces).values({
      id: wsId,
      name: 'Personal Workspace',
      slug: `personal-${userId.slice(0, 8)}`,
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Insert workspace member
    db.insert(workspaceMembers).values({
      id: crypto.randomUUID(),
      workspaceId: wsId,
      userId: userId,
      role: 'owner',
      createdAt: now,
    }).run();

    // Insert session
    db.insert(sessions).values({
      id: sessionId,
      userId: userId,
      expiresAt: now + 60000,
      createdAt: now,
    }).run();

    // Query user and session
    const foundUser = db.select().from(users).where(eq(users.id, userId)).get();
    expect(foundUser).toBeDefined();
    expect(foundUser?.email).toBe('test@example.com');

    const foundSession = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(foundSession).toBeDefined();
    expect(foundSession?.userId).toBe(userId);
  });

  it('enforces foreign key constraints', () => {
    const { db } = createDatabase(':memory:');
    const now = Date.now();

    // Attempting to insert a session with a non-existent user_id should fail
    expect(() => {
      db.insert(sessions).values({
        id: crypto.randomBytes(32).toString('hex'),
        userId: 'non-existent-user',
        expiresAt: now + 60000,
        createdAt: now,
      }).run();
    }).toThrow();
  });
});

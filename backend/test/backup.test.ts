import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseBackup } from '../src/services/backup.service.js';

describe('SQLite online backups', () => {
  let tempDirectory: string | undefined;

  afterEach(async () => {
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = undefined;
    }
  });

  it('creates a consistent restorable snapshot of a live SQLite database', async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-backup-test-'));
    const sourcePath = path.join(tempDirectory, 'source.db');
    const backupDirectory = path.join(tempDirectory, 'backups');
    const source = new Database(sourcePath);

    try {
      source.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
      source.prepare('INSERT INTO notes (body) VALUES (?)').run('preserve this memo');
      source.pragma('journal_mode = WAL');

      const backupPath = await createDatabaseBackup(source, { directory: backupDirectory });
      const snapshot = new Database(backupPath, { readonly: true });

      try {
        const row = snapshot.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string };
        expect(row.body).toBe('preserve this memo');
        expect(path.dirname(backupPath)).toBe(backupDirectory);
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
    }
  });

  it('does not create a snapshot when the SQLite backup operation fails', async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-backup-failure-'));
    const source = new Database(':memory:');
    source.close();

    await expect(
      createDatabaseBackup(source, { directory: path.join(tempDirectory, 'backups') }),
    ).rejects.toThrow();
    expect(await fs.readdir(path.join(tempDirectory, 'backups'))).toEqual([]);
  });

  it('restores a snapshot and recovers database state with PRAGMA integrity check', async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-restore-test-'));
    const sourcePath = path.join(tempDirectory, 'source.db');
    const backupDirectory = path.join(tempDirectory, 'backups');
    const source = new Database(sourcePath);

    source.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT NOT NULL)');
    source.prepare('INSERT INTO notes (title, body) VALUES (?, ?)').run('Important Memo', 'State before disaster');
    source.pragma('journal_mode = WAL');

    const backupPath = await createDatabaseBackup(source, { directory: backupDirectory });

    // Simulate accidental deletion
    source.prepare('DELETE FROM notes WHERE id = 1').run();
    expect(source.prepare('SELECT COUNT(*) as count FROM notes').get()).toEqual({ count: 0 });
    source.close();

    // Perform disaster recovery restore
    const restoredDbPath = path.join(tempDirectory, 'restored.db');
    await fs.copyFile(backupPath, restoredDbPath);
    const restored = new Database(restoredDbPath);

    try {
      const integrity = restored.pragma('integrity_check') as [{ integrity_check: string }];
      expect(integrity[0].integrity_check).toBe('ok');

      const recoveredRow = restored.prepare('SELECT title, body FROM notes WHERE id = 1').get() as { title: string; body: string };
      expect(recoveredRow.title).toBe('Important Memo');
      expect(recoveredRow.body).toBe('State before disaster');
    } finally {
      restored.close();
    }
  });
});

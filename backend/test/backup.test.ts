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
});

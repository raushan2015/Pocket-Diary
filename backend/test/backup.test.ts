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
  it('replicates snapshots to an off-host directory with independent retention', async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-replication-test-'));
    const sourcePath = path.join(tempDirectory, 'source.db');
    const backupDirectory = path.join(tempDirectory, 'local-backups');
    const replicationDirectory = path.join(tempDirectory, 'off-host-replica');
    const source = new Database(sourcePath);

    try {
      source.exec('CREATE TABLE memos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
      source.prepare('INSERT INTO memos (title) VALUES (?)').run('off-host protected memo');
      source.pragma('journal_mode = WAL');

      const first = await createDatabaseBackup(source, {
        directory: backupDirectory,
        retention: 3,
        replicationDirectory,
        replicationRetention: 2,
      });

      // Snapshot exists in BOTH locations and is a valid SQLite copy
      const isSnapshot = (name: string) => /^memo-manager-.*\.db$/.test(name);
      const replicaFiles = (await fs.readdir(replicationDirectory)).filter(isSnapshot);
      expect(replicaFiles).toHaveLength(1);
      const replicaPath = path.join(replicationDirectory, path.basename(first));
      const replica = new Database(replicaPath, { readonly: true });
      try {
        const row = replica.prepare('SELECT title FROM memos WHERE id = 1').get() as { title: string };
        expect(row.title).toBe('off-host protected memo');
      } finally {
        replica.close();
      }

      // Retention is enforced independently in the replica directory
      await createDatabaseBackup(source, { directory: backupDirectory, retention: 3, replicationDirectory, replicationRetention: 2 });
      await createDatabaseBackup(source, { directory: backupDirectory, retention: 3, replicationDirectory, replicationRetention: 2 });
      const afterThree = (await fs.readdir(replicationDirectory)).filter(isSnapshot);
      expect(afterThree).toHaveLength(2); // replica capped at 2
      const localAfterThree = (await fs.readdir(backupDirectory)).filter(isSnapshot);
      expect(localAfterThree).toHaveLength(3); // local cap is 3
    } finally {
      source.close();
    }
  });

  it('keeps the local snapshot even when off-host replication fails', async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-replication-fail-'));
    const sourcePath = path.join(tempDirectory, 'source.db');
    const backupDirectory = path.join(tempDirectory, 'backups');
    // A FILE (not a directory) at the replication path forces copyFile to fail
    const badReplicationPath = path.join(tempDirectory, 'not-a-directory');
    await fs.writeFile(badReplicationPath, 'blocker');
    const source = new Database(sourcePath);

    const warnings: string[] = [];
    try {
      source.exec('CREATE TABLE memos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
      source.pragma('journal_mode = WAL');

      const backupPath = await createDatabaseBackup(source, {
        directory: backupDirectory,
        replicationDirectory: badReplicationPath,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => warnings.push('replication failed'),
        },
      });

      const localEntries = await fs.readdir(backupDirectory);
      // Audit M-12: one .db snapshot plus the attachments-mirror directory.
      const snapshotFiles = localEntries.filter((name) => name.endsWith('.db'));
      expect(snapshotFiles).toHaveLength(1);
      expect(localEntries).toContain('attachments-mirror');
      const restored = new Database(backupPath, { readonly: true });
      restored.close();
      expect(warnings).toHaveLength(1);
    } finally {
      source.close();
    }
  });
});

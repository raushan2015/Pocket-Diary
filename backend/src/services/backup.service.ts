import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupConfig } from '../config.js';

const BACKUP_PATTERN = /^memo-manager-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.db$/;

export interface BackupOptions {
  directory: string;
  retention?: number;
  /** Off-host replication destination (e.g. NFS mount / bind mount outside the data volume). */
  replicationDirectory?: string;
  replicationRetention?: number;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

async function enforceRetention(directory: string, retention: number, logger?: BackupOptions['logger']): Promise<void> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && BACKUP_PATTERN.test(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(directory, entry.name);
          const stat = await fs.stat(fullPath);
          return { path: fullPath, modifiedAt: stat.mtimeMs, name: entry.name };
        }),
    );

    backups.sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
    await Promise.all(
      backups.slice(retention).map(async (backup) => fs.rm(backup.path, { force: true })),
    );
  } catch (error) {
    logger?.warn({ err: error, directory }, 'Backup retention cleanup failed');
  }
}

export async function createDatabaseBackup(
  sqlite: Database.Database,
  options: BackupOptions,
): Promise<string> {
  const retention = Math.max(1, Math.floor(options.retention ?? 7));
  await fs.mkdir(options.directory, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(4).toString('hex');
  const destination = path.join(options.directory, `memo-manager-${timestamp}-${suffix}.db`);

  try {
    await sqlite.backup(destination);
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }

  // Off-host replication: copy the fresh snapshot outside the data volume.
  if (options.replicationDirectory) {
    try {
      await fs.mkdir(options.replicationDirectory, { recursive: true });
      await fs.copyFile(destination, path.join(options.replicationDirectory, path.basename(destination)));
      await enforceRetention(
        options.replicationDirectory,
        Math.max(1, Math.floor(options.replicationRetention ?? 7)),
        options.logger,
      );
    } catch (error) {
      // Replication failure must not fail the local backup, but must be loud.
      options.logger?.error({ err: error, replicationDirectory: options.replicationDirectory }, 'Backup off-host replication failed');
    }
  }

  await enforceRetention(options.directory, retention, options.logger);

  options.logger?.info({ backupPath: destination, replicated: Boolean(options.replicationDirectory) }, 'SQLite database backup completed');
  return destination;
}

export interface BackupStatus {
  localConfigured: boolean;
  localDirectory: string | null;
  localSnapshots: number;
  lastBackupAt: number | null;
  replicationConfigured: boolean;
  replicationDirectory: string | null;
  replicationSnapshots: number;
  lastReplicatedAt: number | null;
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const localDirectory = process.env.BACKUP_DIR
    ?? path.join(path.dirname(path.resolve(process.env.DATABASE_PATH ?? 'data/memo_manager.db')), 'backups');

  const countSnapshots = async (dir: string | null): Promise<{ count: number; last: number | null }> => {
    if (!dir) return { count: 0, last: null };
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile() && BACKUP_PATTERN.test(e.name));
      let last: number | null = null;
      for (const f of files) {
        const stat = await fs.stat(path.join(dir, f.name));
        if (last == null || stat.mtimeMs > last) last = stat.mtimeMs;
      }
      return { count: files.length, last };
    } catch {
      return { count: 0, last: null };
    }
  };

  const local = await countSnapshots(localDirectory);
  const replicated = await countSnapshots(backupConfig.replicationDir || null);

  return {
    localConfigured: true,
    localDirectory,
    localSnapshots: local.count,
    lastBackupAt: local.last,
    replicationConfigured: Boolean(backupConfig.replicationDir),
    replicationDirectory: backupConfig.replicationDir || null,
    replicationSnapshots: replicated.count,
    lastReplicatedAt: replicated.last,
  };
}

export interface BackupSchedulerOptions {
  sqlite: Database.Database;
  databasePath: string;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  directory?: string;
  intervalHours?: number;
  retention?: number;
  replicationDirectory?: string;
  replicationRetention?: number;
}

export function startBackupScheduler(options: BackupSchedulerOptions): () => Promise<void> {
  if (options.databasePath === ':memory:') {
    options.logger.info('SQLite backup scheduler disabled for in-memory database');
    return async () => undefined;
  }

  const intervalHours = Math.max(1, Number(options.intervalHours ?? process.env.BACKUP_INTERVAL_HOURS ?? 24) || 24);
  const retention = Math.max(1, Math.floor(Number(options.retention ?? process.env.BACKUP_RETENTION ?? 7) || 7));
  const directory = options.directory
    ?? process.env.BACKUP_DIR
    ?? path.join(path.dirname(path.resolve(options.databasePath)), 'backups');

  let inFlight: Promise<void> | null = null;

  const runBackup = (): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = createDatabaseBackup(options.sqlite, {
      directory,
      retention,
      replicationDirectory: options.replicationDirectory ?? backupConfig.replicationDir ?? undefined,
      replicationRetention: options.replicationRetention ?? backupConfig.replicationRetention,
      logger: options.logger,
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        options.logger.error({ err: error, directory }, 'SQLite database backup failed');
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  options.logger.info({ directory, intervalHours, retention }, 'SQLite database backup scheduler started');
  void runBackup();

  const timer = setInterval(() => void runBackup(), intervalHours * 60 * 60 * 1000);
  timer.unref();

  return async () => {
    clearInterval(timer);
    if (inFlight) await inFlight;
    options.logger.info('SQLite database backup scheduler stopped');
  };
}

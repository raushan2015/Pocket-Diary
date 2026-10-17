import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupConfig } from '../config.js';

const BACKUP_PATTERN = /^memo-manager-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.db$/;
const ATTACHMENTS_MIRROR_DIR = 'attachments-mirror';

/** Resolves the attachments directory exactly like the attachments route (audit M-12/M-13). */
function resolveAttachmentsDir(): string {
  return process.env.ATTACHMENTS_DIR || path.resolve(process.cwd(), '../data/attachments');
}

/**
 * Incremental mirror of the attachments directory into the backup folder
 * (audit M-12): attachments were previously NOT backed up at all. Files are
 * immutable once written, so copying only files that are missing keeps each
 * run cheap while making the backup set complete.
 */
async function mirrorAttachments(destinationDir: string, logger?: BackupOptions['logger']): Promise<void> {
  const sourceDir = resolveAttachmentsDir();
  let files: string[];
  try {
    files = (await fs.readdir(sourceDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return; // no attachments dir yet — nothing to mirror
  }

  const mirrorDir = path.join(destinationDir, ATTACHMENTS_MIRROR_DIR);
  try {
    await fs.mkdir(mirrorDir, { recursive: true });
    const existing = new Set(
      (await fs.readdir(mirrorDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    );
    for (const name of files) {
      if (existing.has(name)) continue;
      await fs.copyFile(path.join(sourceDir, name), path.join(mirrorDir, name));
    }
  } catch (error) {
    logger?.warn({ err: error, mirrorDir }, 'Attachment backup mirror failed');
  }
}

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
  await mirrorAttachments(options.directory, options.logger);
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
  /** Skip the startup snapshot when one already exists newer than this (hours). Default: min(1, interval/4). */
  startupMinIntervalHours?: number;
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

  const newestSnapshotAt = async (): Promise<number | null> => {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      let newest: number | null = null;
      for (const entry of entries) {
        if (!entry.isFile() || !BACKUP_PATTERN.test(entry.name)) continue;
        const stat = await fs.stat(path.join(directory, entry.name));
        if (newest == null || stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
      return newest;
    } catch {
      return null;
    }
  };

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

  // Audit M-12: a backup on every startup meant a crash-looping container
  // pushed all good snapshots out of retention within minutes. Only run the
  // startup snapshot when the newest one is older than the minimum interval.
  const startupMinIntervalHours = Math.max(
    0.25,
    options.startupMinIntervalHours ?? Math.min(1, intervalHours / 4),
  );
  void newestSnapshotAt().then((lastAt) => {
    const ageHours = lastAt == null ? Infinity : (Date.now() - lastAt) / (60 * 60 * 1000);
    if (ageHours >= startupMinIntervalHours) {
      void runBackup();
    } else {
      options.logger.info(
        { ageHours: Math.round(ageHours * 100) / 100 },
        'Skipping startup backup: a recent snapshot already exists',
      );
    }
  });

  const timer = setInterval(() => void runBackup(), intervalHours * 60 * 60 * 1000);
  timer.unref();

  return async () => {
    clearInterval(timer);
    if (inFlight) await inFlight;
    options.logger.info('SQLite database backup scheduler stopped');
  };
}

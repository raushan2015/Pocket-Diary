import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const BACKUP_PATTERN = /^memo-manager-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.db$/;

export interface BackupOptions {
  directory: string;
  retention?: number;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
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

  try {
    const entries = await fs.readdir(options.directory, { withFileTypes: true });
    const backups = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && BACKUP_PATTERN.test(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(options.directory, entry.name);
          const stat = await fs.stat(fullPath);
          return { path: fullPath, modifiedAt: stat.mtimeMs, name: entry.name };
        }),
    );

    backups.sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
    await Promise.all(
      backups.slice(retention).map(async (backup) => fs.rm(backup.path, { force: true })),
    );
  } catch (error) {
    options.logger?.warn({ err: error, directory: options.directory }, 'Backup retention cleanup failed');
  }

  options.logger?.info({ backupPath: destination }, 'SQLite database backup completed');
  return destination;
}

export interface BackupSchedulerOptions {
  sqlite: Database.Database;
  databasePath: string;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  directory?: string;
  intervalHours?: number;
  retention?: number;
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

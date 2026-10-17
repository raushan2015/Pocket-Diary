import path from 'node:path';
import { buildApp } from './app.js';
import { config, resolveAppUrl } from './config.js';
import { startBackupScheduler } from './services/backup.service.js';
import { startReminderScheduler } from './services/notification.service.js';
import { isEmailEnabled } from './services/mailer.service.js';
import { isPushEnabled } from './services/push.service.js';

async function start() {
  const app = buildApp();
  let stopBackupScheduler: () => Promise<void> = async () => undefined;
  let stopReminderScheduler: () => void = () => undefined;

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      stopReminderScheduler();
      await stopBackupScheduler();
      await app.close();
      if (app.dbCtx?.sqlite) {
        app.dbCtx.sqlite.close();
      }
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    const address = await app.listen({
      port: config.port,
      host: config.host,
    });
    app.log.info(`Memo Manager backend listening on ${address}`);
    const databasePath = process.env.DATABASE_PATH ?? path.resolve(process.cwd(), 'data/memo_manager.db');
    stopBackupScheduler = startBackupScheduler({
      sqlite: app.dbCtx.sqlite,
      databasePath,
      logger: app.log,
    });
    const reminderIntervalMs = Math.max(10_000, Number(process.env.REMINDER_SCAN_INTERVAL_MS ?? 30_000) || 30_000);
    stopReminderScheduler = startReminderScheduler(app.dbCtx, {
      intervalMs: reminderIntervalMs,
      appUrl: resolveAppUrl(),
      logger: {
        info: (msg: string) => app.log.info(msg),
        warn: (msg: string) => app.log.warn(msg),
        error: (msg: string, err?: unknown) => app.log.error({ err }, msg),
      },
    });
    app.log.info(
      `reminder delivery: email ${isEmailEnabled() ? 'enabled' : 'disabled (SMTP_HOST not set)'}, web push ${isPushEnabled() ? 'enabled' : 'disabled (VAPID keys not set)'}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// If executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  start();
}

export { start };

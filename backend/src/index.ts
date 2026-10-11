import path from 'node:path';
import { buildApp } from './app.js';
import { config } from './config.js';
import { startBackupScheduler } from './services/backup.service.js';

async function start() {
  const app = buildApp();
  let stopBackupScheduler: () => Promise<void> = async () => undefined;

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
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

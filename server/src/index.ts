import { env } from './env';
import { buildApp } from './app';
import { bootstrap } from './bootstrap';
import { logger } from './logger';
import { startPresenceMonitor, stopPresenceMonitor } from './services/presenceScheduler';
import { prisma } from './prisma';
import { startSchedulers } from './scheduler';
import { startDatabaseBackups } from './services/backup';

const app = buildApp();

const start = async () => {
  await bootstrap();
  startPresenceMonitor();
  startSchedulers();
  const stopBackups = startDatabaseBackups();

  const server = app.listen(env.PORT, () => {
    logger.info(`Server listening on port ${env.PORT}`);
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'Shutting down');
    stopPresenceMonitor();
    stopBackups();
    await prisma.$disconnect();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

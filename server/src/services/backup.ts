import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../env';
import { logger } from '../logger';

const SQLITE_PREFIX = 'sqlite';

const resolveSqlitePath = (databaseUrl: string): string | null => {
  if (!databaseUrl.startsWith('file:')) {
    return null;
  }
  const withoutPrefix = databaseUrl.slice(5);
  const [filePath] = withoutPrefix.split('?');
  if (!filePath) {
    return null;
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(process.cwd(), filePath);
};

const formatTimestamp = (date: Date) => {
  const pad = (value: number) => value.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
};

const cleanupOldBackups = async (dir: string, retentionDays: number) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  if (!entries.length) {
    return;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const targets = entries.filter((entry) => entry.isFile() && entry.name.startsWith(`${SQLITE_PREFIX}-backup-`));

  await Promise.all(
    targets.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      try {
        const stats = await fs.stat(filePath);
        if (stats.mtime.getTime() < cutoff) {
          await fs.unlink(filePath);
          logger.info({ filePath }, 'Removed expired sqlite backup');
        }
      } catch (error) {
        logger.warn({ err: error, filePath }, 'Failed to inspect backup file for cleanup');
      }
    })
  );
};

const performBackup = async (source: string, destinationDir: string, retentionDays: number) => {
  try {
    await fs.mkdir(destinationDir, { recursive: true });
    const timestamp = formatTimestamp(new Date());
    const targetPath = path.join(destinationDir, `${SQLITE_PREFIX}-backup-${timestamp}.sqlite`);
    await fs.copyFile(source, targetPath);
    logger.info({ targetPath }, 'Created sqlite backup');
    await cleanupOldBackups(destinationDir, retentionDays);
  } catch (error) {
    logger.error({ err: error }, 'Failed to create sqlite backup');
  }
};

const computeDelayUntilNextRun = (time: string) => {
  const parts = time.split(':');
  const hours = Number.parseInt(parts[0] ?? '0', 10);
  const minutes = Number.parseInt(parts[1] ?? '0', 10);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
};

export const startDatabaseBackups = () => {
  if (!env.SQLITE_BACKUP_ENABLED) {
    logger.info('Sqlite backup scheduler disabled by configuration');
    return () => {};
  }

  const sqlitePath = resolveSqlitePath(env.DATABASE_URL);
  if (!sqlitePath) {
    logger.info('Skipping sqlite backups: DATABASE_URL is not a file: path');
    return () => {};
  }

  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    const delay = computeDelayUntilNextRun(env.SQLITE_BACKUP_TIME);
    timer = setTimeout(async () => {
      await performBackup(sqlitePath, path.resolve(env.SQLITE_BACKUP_DIR), env.SQLITE_BACKUP_RETENTION_DAYS);
      scheduleNext();
    }, delay);
  };

  scheduleNext();

  logger.info(
    {
      backupDir: path.resolve(env.SQLITE_BACKUP_DIR),
      retentionDays: env.SQLITE_BACKUP_RETENTION_DAYS,
      scheduledTime: env.SQLITE_BACKUP_TIME
    },
    'Scheduled nightly sqlite backups'
  );

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
};

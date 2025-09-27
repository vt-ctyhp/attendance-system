"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDatabaseBackups = void 0;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const env_1 = require("../env");
const logger_1 = require("../logger");
const SQLITE_PREFIX = 'sqlite';
const resolveSqlitePath = (databaseUrl) => {
    if (!databaseUrl.startsWith('file:')) {
        return null;
    }
    const withoutPrefix = databaseUrl.slice(5);
    const [filePath] = withoutPrefix.split('?');
    if (!filePath) {
        return null;
    }
    if (path_1.default.isAbsolute(filePath)) {
        return filePath;
    }
    return path_1.default.resolve(process.cwd(), filePath);
};
const formatTimestamp = (date) => {
    const pad = (value) => value.toString().padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
};
const cleanupOldBackups = async (dir, retentionDays) => {
    const entries = await fs_1.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (!entries.length) {
        return;
    }
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const targets = entries.filter((entry) => entry.isFile() && entry.name.startsWith(`${SQLITE_PREFIX}-backup-`));
    await Promise.all(targets.map(async (entry) => {
        const filePath = path_1.default.join(dir, entry.name);
        try {
            const stats = await fs_1.promises.stat(filePath);
            if (stats.mtime.getTime() < cutoff) {
                await fs_1.promises.unlink(filePath);
                logger_1.logger.info({ filePath }, 'Removed expired sqlite backup');
            }
        }
        catch (error) {
            logger_1.logger.warn({ err: error, filePath }, 'Failed to inspect backup file for cleanup');
        }
    }));
};
const performBackup = async (source, destinationDir, retentionDays) => {
    try {
        await fs_1.promises.mkdir(destinationDir, { recursive: true });
        const timestamp = formatTimestamp(new Date());
        const targetPath = path_1.default.join(destinationDir, `${SQLITE_PREFIX}-backup-${timestamp}.sqlite`);
        await fs_1.promises.copyFile(source, targetPath);
        logger_1.logger.info({ targetPath }, 'Created sqlite backup');
        await cleanupOldBackups(destinationDir, retentionDays);
    }
    catch (error) {
        logger_1.logger.error({ err: error }, 'Failed to create sqlite backup');
    }
};
const computeDelayUntilNextRun = (time) => {
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
const startDatabaseBackups = () => {
    if (!env_1.env.SQLITE_BACKUP_ENABLED) {
        logger_1.logger.info('Sqlite backup scheduler disabled by configuration');
        return () => { };
    }
    const sqlitePath = resolveSqlitePath(env_1.env.DATABASE_URL);
    if (!sqlitePath) {
        logger_1.logger.info('Skipping sqlite backups: DATABASE_URL is not a file: path');
        return () => { };
    }
    let timer = null;
    const scheduleNext = () => {
        const delay = computeDelayUntilNextRun(env_1.env.SQLITE_BACKUP_TIME);
        timer = setTimeout(async () => {
            await performBackup(sqlitePath, path_1.default.resolve(env_1.env.SQLITE_BACKUP_DIR), env_1.env.SQLITE_BACKUP_RETENTION_DAYS);
            scheduleNext();
        }, delay);
    };
    scheduleNext();
    logger_1.logger.info({
        backupDir: path_1.default.resolve(env_1.env.SQLITE_BACKUP_DIR),
        retentionDays: env_1.env.SQLITE_BACKUP_RETENTION_DAYS,
        scheduledTime: env_1.env.SQLITE_BACKUP_TIME
    }, 'Scheduled nightly sqlite backups');
    return () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
};
exports.startDatabaseBackups = startDatabaseBackups;

import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import log from 'electron-log/main';

const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB

export const logger = log;

export const initializeLogging = async () => {
  const logDir = path.join(app.getPath('userData'), 'logs');
  await fs.mkdir(logDir, { recursive: true });

  log.transports.file.resolvePathFn = () => path.join(logDir, 'attendance.log');
  log.transports.file.level = 'info';
  log.transports.file.maxSize = MAX_LOG_SIZE_BYTES;
  log.transports.console.level = 'warn';
  log.catchErrors({ showDialog: false });
};

export default logger;

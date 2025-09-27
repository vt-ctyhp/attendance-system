import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger';

export interface AppConfig {
  deviceId: string;
  serverBaseUrl: string;
  workEmail: string | null;
}

export interface PersistedQueueItem {
  path: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  requiresAuth?: boolean;
  description?: string;
  tokenOverride?: string | null;
  attempt: number;
  nextAttemptAt: number;
}

const CONFIG_FILE_NAME = 'attendance-config.json';
const QUEUE_FILE_NAME = 'offline-queue.json';
const DEFAULT_SERVER_BASE_URL = 'http://localhost:4000';

let cachedConfig: AppConfig | null = null;

const getAppDataPath = () => app.getPath('userData');

const getConfigPath = () => path.join(getAppDataPath(), CONFIG_FILE_NAME);
const getQueuePath = () => path.join(getAppDataPath(), QUEUE_FILE_NAME);

export const getConfig = async (): Promise<AppConfig> => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = getConfigPath();

  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const data = JSON.parse(raw) as Partial<AppConfig>;
    const config: AppConfig = {
      deviceId: data.deviceId ?? randomUUID(),
      serverBaseUrl: data.serverBaseUrl ?? DEFAULT_SERVER_BASE_URL,
      workEmail: typeof data.workEmail === 'string' && data.workEmail.trim().length > 0 ? data.workEmail : null
    };

    if (!data.deviceId || !data.serverBaseUrl || data.workEmail !== config.workEmail) {
      await saveConfig(config);
    }

    cachedConfig = config;
    return config;
  } catch (error) {
    const config: AppConfig = {
      deviceId: randomUUID(),
      serverBaseUrl: DEFAULT_SERVER_BASE_URL,
      workEmail: null
    };
    await saveConfig(config);
    cachedConfig = config;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to read config, recreating', error);
    }
    return config;
  }
};

export const saveConfig = async (config: AppConfig): Promise<void> => {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  cachedConfig = config;
};

export const updateConfig = async (partial: Partial<AppConfig>): Promise<AppConfig> => {
  const current = await getConfig();
  const next: AppConfig = {
    deviceId: current.deviceId,
    serverBaseUrl: current.serverBaseUrl,
    workEmail: current.workEmail,
    ...partial
  };
  if (typeof next.workEmail === 'string') {
    const trimmedEmail = next.workEmail.trim();
    next.workEmail = trimmedEmail.length > 0 ? trimmedEmail : null;
  } else if (next.workEmail !== null) {
    next.workEmail = null;
  }
  await saveConfig(next);
  return next;
};

export const loadQueue = async (): Promise<PersistedQueueItem[]> => {
  const queuePath = getQueuePath();
  try {
    const raw = await fs.readFile(queuePath, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data as PersistedQueueItem[];
    }
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to read offline queue, resetting', error);
    }
    return [];
  }
};

export const saveQueue = async (items: PersistedQueueItem[]): Promise<void> => {
  const queuePath = getQueuePath();
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.writeFile(queuePath, JSON.stringify(items, null, 2), 'utf-8');
};

export const getDefaultServerBaseUrl = () => DEFAULT_SERVER_BASE_URL;

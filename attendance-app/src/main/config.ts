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

const DEV_SERVER_BASE_URL = 'http://localhost:4000';
const PROD_SERVER_PRIMARY_BASE_URL = 'https://attendance-system-j9ns.onrender.com';
const PROD_SERVER_FALLBACK_BASE_URL = 'https://attendance.vvsjewelco.com';

const PROD_SERVER_BASE_URLS = [PROD_SERVER_PRIMARY_BASE_URL, PROD_SERVER_FALLBACK_BASE_URL] as const;

const isProductionLike = () => app.isPackaged || process.env.NODE_ENV === 'production';

const getDefaultServerBaseUrls = (): string[] =>
  isProductionLike() ? [...PROD_SERVER_BASE_URLS] : [DEV_SERVER_BASE_URL];


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
      serverBaseUrl: data.serverBaseUrl ?? getDefaultServerBaseUrl(),
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
      serverBaseUrl: getDefaultServerBaseUrl(),
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

const SERVER_HEALTH_ENDPOINT = '/api/health';
const SERVER_HEALTH_TIMEOUT_MS = 3000;

export type ServerBaseUrlResolutionReason = 'stored' | 'primary' | 'fallback' | 'default' | 'unchanged';

export const getDefaultServerBaseUrl = () => getDefaultServerBaseUrls()[0];

export const getDefaultServerBaseUrlOptions = (): string[] => getDefaultServerBaseUrls();

const isServerReachable = async (baseUrl: string): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${SERVER_HEALTH_ENDPOINT}`, {
      method: 'GET',
      signal: controller.signal
    });
    return response.ok || response.status === 401;
  } catch (error) {
    logger.info('Server health check failed', {
      baseUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

export const resolvePreferredServerBaseUrl = async (
  current?: string
): Promise<{ baseUrl: string; reason: ServerBaseUrlResolutionReason }> => {
  const trimmedCurrent = typeof current === 'string' && current.trim().length > 0 ? current : undefined;

  if (!isProductionLike()) {
    if (trimmedCurrent) {
      return { baseUrl: trimmedCurrent, reason: 'stored' };
    }
    return { baseUrl: getDefaultServerBaseUrl(), reason: 'default' };
  }

  const defaults = getDefaultServerBaseUrls();
  const orderedCandidates = Array.from(new Set([trimmedCurrent, ...defaults].filter(Boolean))) as string[];

  for (const candidate of orderedCandidates) {
    const reachable = await isServerReachable(candidate);
    if (reachable) {
      if (candidate === trimmedCurrent) {
        return { baseUrl: candidate, reason: 'stored' };
      }
      if (candidate === defaults[0]) {
        return { baseUrl: candidate, reason: 'primary' };
      }
      return { baseUrl: candidate, reason: 'fallback' };
    }
  }

  return { baseUrl: trimmedCurrent ?? defaults[0], reason: 'unchanged' };
};

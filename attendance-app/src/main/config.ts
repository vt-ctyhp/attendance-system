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

type SimpleFetch = (input: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export function normalizeServerBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Server URL is required');
  }
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  const withProtocol = /^https?:\/\//i.test(withoutTrailingSlash)
    ? withoutTrailingSlash
    : `https://${withoutTrailingSlash}`;
  const url = new URL(withProtocol);
  const hostname = url.hostname.toLowerCase();
  const shouldForceHttps = hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1';
  if (shouldForceHttps) {
    url.protocol = 'https:';
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '/' || pathname === '') {
    pathname = '';
  }
  return `${url.protocol}//${url.host}${pathname}`;
}

const DEV_SERVER_BASE_URL = normalizeServerBaseUrl('http://localhost:4000');

const RAW_PRODUCTION_SERVER_BASE_URLS = [
  'https://attendance-system-j9ns.onrender.com',
  'https://attendance.vvsjewelco.com'
];

export const PRODUCTION_SERVER_BASE_URLS = Object.freeze(
  RAW_PRODUCTION_SERVER_BASE_URLS.map((url) => normalizeServerBaseUrl(url))
);

const PRODUCTION_HEALTH_PATH = '/api/health';
const PRODUCTION_HEALTH_TIMEOUT_MS = 4_000;

const isProductionRuntime = () => app.isPackaged || process.env.NODE_ENV === 'production';

const resolveDefaultServerBaseUrl = () =>
  isProductionRuntime() ? PRODUCTION_SERVER_BASE_URLS[0] : DEV_SERVER_BASE_URL;

const DEFAULT_SERVER_BASE_URL = resolveDefaultServerBaseUrl();

const getFetch = (): SimpleFetch | null => {
  const candidate = (globalThis as unknown as { fetch?: SimpleFetch }).fetch;
  return typeof candidate === 'function' ? candidate : null;
};

const probeServerHealth = async (baseUrl: string): Promise<boolean> => {
  const fetchFn = getFetch();
  if (!fetchFn) {
    logger.debug('Global fetch implementation unavailable; skipping server health probe');
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRODUCTION_HEALTH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const target = new URL(PRODUCTION_HEALTH_PATH, baseUrl).toString();
    const response = await fetchFn(target, { method: 'GET', signal: controller.signal });
    if (response.ok || response.status === 401) {
      return true;
    }
    logger.debug({ target, status: response.status }, 'config.health_probe_unexpected_status');
    return false;
  } catch (error) {
    logger.debug({ baseUrl, error }, 'config.health_probe_failed');
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

export const isManagedProductionServerBaseUrl = (value: string) =>
  PRODUCTION_SERVER_BASE_URLS.includes(value);

export const resolveAvailableProductionServerBaseUrl = async (
  currentBaseUrl?: string
): Promise<string> => {
  for (const candidate of PRODUCTION_SERVER_BASE_URLS) {
    if (await probeServerHealth(candidate)) {
      return candidate;
    }
  }
  if (currentBaseUrl && isManagedProductionServerBaseUrl(currentBaseUrl)) {
    return currentBaseUrl;
  }
  return PRODUCTION_SERVER_BASE_URLS[0];
};

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
    const normalizedServerBaseUrl =
      typeof data.serverBaseUrl === 'string' && data.serverBaseUrl.trim().length > 0
        ? normalizeServerBaseUrl(data.serverBaseUrl)
        : DEFAULT_SERVER_BASE_URL;
    const config: AppConfig = {
      deviceId: data.deviceId ?? randomUUID(),
      serverBaseUrl: normalizedServerBaseUrl,
      workEmail: typeof data.workEmail === 'string' && data.workEmail.trim().length > 0 ? data.workEmail : null
    };

    if (
      !data.deviceId ||
      !data.serverBaseUrl ||
      data.serverBaseUrl !== normalizedServerBaseUrl ||
      data.workEmail !== config.workEmail
    ) {
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
  if (typeof partial.serverBaseUrl === 'string') {
    next.serverBaseUrl = normalizeServerBaseUrl(partial.serverBaseUrl);
  }
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

export const getDefaultServerBaseUrl = () => resolveDefaultServerBaseUrl();

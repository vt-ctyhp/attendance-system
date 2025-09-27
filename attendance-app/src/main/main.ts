import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  powerMonitor
} from 'electron';
import path from 'path';
import dotenv from 'dotenv';
import { initializeLogging, logger } from './logger';
import {
  AppConfig,
  PersistedQueueItem,
  getConfig,
  updateConfig,
  loadQueue,
  saveQueue,
  getDefaultServerBaseUrl
} from './config';

type ActiveWindowModule = typeof import('active-win');
type ActiveWindowResult = Awaited<ReturnType<ActiveWindowModule['activeWindow']>>;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let deviceId: string | null = null;
let baseUrl: string = getDefaultServerBaseUrl();
let workEmail: string | null = null;
let cachedQueue: PersistedQueueItem[] = [];
let activeWinUnavailable = false;
let activeWindowModule: ActiveWindowModule | null = null;

type PresencePromptPayload = {
  id: string;
  expiresAt: string;
  message?: string;
};

type PresenceUiMode = 'overlay' | 'popup' | 'both';

const normalizePresenceUiMode = (value?: string | null): PresenceUiMode => {
  if (!value) {
    return 'both';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'overlay' || normalized === 'popup' || normalized === 'both') {
    return normalized;
  }
  return 'both';
};

let presenceUiMode: PresenceUiMode = normalizePresenceUiMode(process.env.PRESENCE_UI);
let presenceWindow: BrowserWindow | null = null;
let activePresencePrompt: PresencePromptPayload | null = null;

const trayIconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NgYGD4DwABBAEAAXcQ0wAAAABJRU5ErkJggg==';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

defaultSecondInstanceHandler();

function defaultSecondInstanceHandler() {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });
}

const normalizeBaseUrl = (input: string) => {
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
};

const shouldOpenPresenceWindow = () => presenceUiMode === 'popup' || presenceUiMode === 'both';

const closePresenceWindow = (promptId?: string, options?: { suppressDismiss?: boolean }) => {
  if (!presenceWindow || presenceWindow.isDestroyed()) {
    presenceWindow = null;
    activePresencePrompt = null;
    return;
  }
  if (promptId && activePresencePrompt && activePresencePrompt.id !== promptId) {
    return;
  }
  const target = presenceWindow;
  const closingPromptId = activePresencePrompt?.id ?? null;
  target.webContents.send('attendance:presence-window-disable');
  presenceWindow = null;
  activePresencePrompt = null;
  if (!options?.suppressDismiss && closingPromptId) {
    mainWindow?.webContents.send('attendance:presence-window-dismiss', closingPromptId);
  }
  target.close();
};

const ensurePresenceWindow = (prompt: PresencePromptPayload) => {
  activePresencePrompt = prompt;

  if (presenceWindow && !presenceWindow.isDestroyed()) {
    presenceWindow.focus();
    presenceWindow.webContents.send('attendance:presence-window-data', prompt);
    return;
  }

  if (!mainWindow) {
    return;
  }

  presenceWindow = new BrowserWindow({
    width: 360,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: true,
    title: 'Presence Check',
    webPreferences: {
      preload: path.join(__dirname, '../renderer/presencePreload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  presenceWindow.setMenu(null);

  presenceWindow.on('close', () => {
    if (activePresencePrompt) {
      const promptId = activePresencePrompt.id;
      activePresencePrompt = null;
      mainWindow?.webContents.send('attendance:presence-window-dismiss', promptId);
    }
  });

  presenceWindow.on('closed', () => {
    presenceWindow = null;
  });

  presenceWindow.loadFile(path.join(__dirname, '../renderer/presence.html')).catch((error) => {
    logger.error({ err: error }, 'Failed to load presence window');
  });
};

const loadEnvironment = () => {
  const cwdEnv = path.join(process.cwd(), '.env');
  dotenv.config({ path: cwdEnv });
  const appEnvPath = app.isPackaged ? path.join(process.resourcesPath, '.env') : path.join(app.getAppPath(), '.env');
  dotenv.config({ path: appEnvPath });
};

const applyAutoLaunch = () => {
  if (!app.isPackaged) {
    return;
  }

  try {
    if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true
      });
    } else if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath
      });
    }
    logger.info('Auto-launch configured');
  } catch (error) {
    logger.warn('Unable to set auto-launch', error);
  }
};

const createTray = () => {
  if (tray) {
    return;
  }
  const icon = nativeImage.createFromDataURL(trayIconDataUrl);
  tray = new Tray(icon);
  tray.setToolTip('Attendance App');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Attendance App',
      click: () => {
        if (mainWindow) {
          if (!mainWindow.isVisible()) {
            mainWindow.show();
          }
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Attendance App',
      click: () => {
        logger.info('Quitting from tray');
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: false,
    title: 'Attendance App',
    webPreferences: {
      preload: path.join(__dirname, '../renderer/preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

const bootstrapConfiguration = async () => {
  const config = await getConfig();
  deviceId = config.deviceId;
  workEmail = config.workEmail ?? null;

  const envOverride = process.env.SERVER_BASE_URL;
  if (envOverride) {
    try {
      const normalized = normalizeBaseUrl(envOverride);
      baseUrl = normalized;
      if (config.serverBaseUrl !== normalized) {
        await updateConfig({ serverBaseUrl: normalized });
      }
      return;
    } catch (error) {
      logger.warn('Invalid SERVER_BASE_URL env value, falling back to stored value', error);
    }
  }

  try {
    const normalizedStored = normalizeBaseUrl(config.serverBaseUrl);
    baseUrl = normalizedStored;
    if (normalizedStored !== config.serverBaseUrl) {
      await updateConfig({ serverBaseUrl: normalizedStored });
    }
  } catch (error) {
    logger.warn('Stored server base URL invalid, resetting to default', error);
    const fallback = normalizeBaseUrl(getDefaultServerBaseUrl());
    const updated = await updateConfig({ serverBaseUrl: fallback });
    baseUrl = updated.serverBaseUrl;
  }
};

const getSystemStatus = async () => {
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const foregroundApp = await getForegroundApp();
  return {
    idleSeconds,
    foregroundApp
  };
};

const loadActiveWindowModule = async (): Promise<ActiveWindowModule | null> => {
  if (activeWinUnavailable) {
    return null;
  }
  if (activeWindowModule) {
    return activeWindowModule;
  }
  try {
    activeWindowModule = await import('active-win');
    return activeWindowModule;
  } catch (error) {
    activeWinUnavailable = true;
    logger.info('Foreground app detection unavailable', error);
    return null;
  }
};

const getForegroundApp = async () => {
  const module = await loadActiveWindowModule();
  if (!module || !module.activeWindow) {
    return null;
  }

  try {
    const result: ActiveWindowResult = await module
      .activeWindow({ accessibilityPermission: false, screenRecordingPermission: false })
      .catch(() => undefined);
    if (!result) {
      return null;
    }
    return {
      title: result.title ?? null,
      owner: result.owner?.name ?? null
    };
  } catch (error) {
    logger.warn('Unable to read foreground window', error);
    return null;
  }
};

const serializeConfig = (): AppConfig => ({
  deviceId: deviceId ?? '',
  serverBaseUrl: baseUrl,
  workEmail
});

const handleIpc = () => {
  ipcMain.handle('attendance:get-bootstrap', async () => {
    if (!deviceId) {
      await bootstrapConfiguration();
    }

    return {
      baseUrl,
      deviceId,
      platform: process.platform,
      presenceUiMode
    };
  });

  ipcMain.handle('attendance:get-system-status', async () => {
    return getSystemStatus();
  });

  ipcMain.handle('attendance:get-settings', async () => {
    if (!deviceId) {
      await bootstrapConfiguration();
    }
    return serializeConfig();
  });

  ipcMain.handle('attendance:update-settings', async (_event, payload: { serverBaseUrl?: string; workEmail?: string | null }) => {
    const serverBaseUrl = typeof payload?.serverBaseUrl === 'string' ? payload.serverBaseUrl : '';
    if (!serverBaseUrl.trim()) {
      throw new Error('Server URL is required');
    }
    const normalized = normalizeBaseUrl(serverBaseUrl);
    const rawEmail = typeof payload?.workEmail === 'string' ? payload.workEmail : null;
    const trimmedEmail = rawEmail && rawEmail.trim().length > 0 ? rawEmail.trim().toLowerCase() : null;
    const updated = await updateConfig({ serverBaseUrl: normalized, workEmail: trimmedEmail });
    baseUrl = updated.serverBaseUrl;
    workEmail = updated.workEmail ?? null;
    logger.info('Settings updated', { baseUrl, workEmail });
    return serializeConfig();
  });

  ipcMain.handle('attendance:test-server-url', async (_event, url: string) => {
    const normalized = normalizeBaseUrl(url);
    const healthUrl = `${normalized}/api/health`;

    try {
      const response = await fetch(healthUrl, { method: 'GET' });
      if (response.ok || response.status === 401) {
        return { ok: true, status: response.status, url: healthUrl };
      }
      return { ok: false, status: response.status, url: healthUrl };
    } catch (error) {
      logger.warn('Server ping failed', { target: healthUrl, error });
      return { ok: false };
    }
  });

  ipcMain.handle('attendance:load-offline-queue', async () => {
    if (cachedQueue.length === 0) {
      cachedQueue = await loadQueue();
    }
    return cachedQueue;
  });

  ipcMain.handle('attendance:save-offline-queue', async (_event, queue: PersistedQueueItem[]) => {
    cachedQueue = queue;
    await saveQueue(queue);
    return { saved: true };
  });

  ipcMain.handle('attendance:clear-offline-queue', async () => {
    cachedQueue = [];
    await saveQueue([]);
    return { cleared: true };
  });

  ipcMain.on('attendance:presence-open', (_event, prompt: PresencePromptPayload) => {
    if (!shouldOpenPresenceWindow()) {
      return;
    }
    ensurePresenceWindow(prompt);
  });

  ipcMain.on('attendance:presence-close', (_event, promptId: string) => {
    closePresenceWindow(promptId, { suppressDismiss: true });
  });

  ipcMain.on('attendance:presence-window-confirm', (_event, promptId: string) => {
    if (mainWindow) {
      mainWindow.webContents.send('attendance:presence-window-confirm', promptId);
    }
    closePresenceWindow(promptId);
  });

  ipcMain.on('attendance:presence-window-dismiss', (_event, promptId: string) => {
    closePresenceWindow(promptId);
  });

  ipcMain.on('attendance:presence-window-ready', (event) => {
    if (presenceWindow && event.sender === presenceWindow.webContents && activePresencePrompt) {
      event.sender.send('attendance:presence-window-data', activePresencePrompt);
    }
  });

  ipcMain.on('attendance-action', (_event, action: string) => {
    logger.info('[Attendance Action]', { action });
  });
};

const setupPowerMonitorLogging = () => {
  powerMonitor.on('suspend', () => logger.info('System suspend detected'));
  powerMonitor.on('resume', () => logger.info('System resume detected'));
  powerMonitor.on('shutdown', () => logger.info('System shutdown event received'));
};

app.whenReady().then(async () => {
  await initializeLogging();
  logger.info('Application starting');
  loadEnvironment();
  await bootstrapConfiguration();
  logger.info('Resolved server base URL', { baseUrl });
  cachedQueue = await loadQueue();
  handleIpc();
  setupPowerMonitorLogging();
  createWindow();
  createTray();
  applyAutoLaunch();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error('Failed to start Attendance App', error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

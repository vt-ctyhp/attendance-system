import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  powerMonitor,
  dialog
} from 'electron';
import type { MenuItemConstructorOptions, MessageBoxOptions } from 'electron';
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
  getDefaultServerBaseUrl,
  normalizeServerBaseUrl,
  resolvePreferredServerBaseUrl
} from './config';
import { autoUpdater } from 'electron-updater';
import type { UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';

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

let updateCheckActive = false;
let updateRequestSource: 'manual' | null = null;

const presentMessageBox = (options: MessageBoxOptions) => {
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  return targetWindow ? dialog.showMessageBox(targetWindow, options) : dialog.showMessageBox(options);
};

const showInfoMessage = (options: MessageBoxOptions) => {
  void presentMessageBox(options).catch((error: unknown) => {
    logger.warn('Failed to display message box', error);
  });
};

const triggerManualUpdateCheck = () => {
  if (!app.isPackaged) {
    showInfoMessage({
      type: 'info',
      title: 'Updates Unavailable',
      message: 'Automatic updates are only available in packaged builds.'
    });
    return;
  }

  if (updateCheckActive) {
    showInfoMessage({
      type: 'info',
      title: 'Update In Progress',
      message: 'An update check is already running.'
    });
    return;
  }

  updateCheckActive = true;
  updateRequestSource = 'manual';
  autoUpdater
    .checkForUpdates()
    .catch((error: unknown) => {
      logger.error('Manual update check failed', error);
      showInfoMessage({
        type: 'error',
        title: 'Update Check Failed',
        message: 'Unable to check for updates.',
        detail: error instanceof Error ? error.message : String(error)
      });
      updateCheckActive = false;
      updateRequestSource = null;
    });
};

const setupAutoUpdates = () => {
  if (!app.isPackaged) {
    logger.info('Auto updates disabled in development mode');
    return;
  }

  autoUpdater.logger = logger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logger.info('Checking for application updates');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info('Update available', { version: info.version });
    if (updateRequestSource === 'manual') {
      showInfoMessage({
        type: 'info',
        title: 'Update Available',
        message: `Version ${info.version} is downloading.`,
        detail: 'You will be prompted to install once the download completes.'
      });
    }
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    logger.info('No updates available', { version: info.version });
    if (updateRequestSource === 'manual') {
      showInfoMessage({
        type: 'info',
        title: 'Up To Date',
        message: 'You already have the latest version installed.',
        detail: `Current version: ${app.getVersion()}`
      });
    }
    updateCheckActive = false;
    updateRequestSource = null;
  });

  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    logger.info('Update downloaded', { version: info.version });
    updateCheckActive = false;
    updateRequestSource = null;
    void presentMessageBox({
        type: 'question',
        buttons: ['Install and Restart', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded.`,
        detail: 'Install the update now?'
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch((error: unknown) => {
        logger.warn('Failed to present update confirmation', error);
      });
  });

  autoUpdater.on('error', (error: Error) => {
    logger.error('Auto update error', error);
    if (updateRequestSource === 'manual') {
      showInfoMessage({
        type: 'error',
        title: 'Update Error',
        message: 'An error occurred while checking for updates.',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    updateCheckActive = false;
    updateRequestSource = null;
  });

  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((error: unknown) => logger.warn('Automatic update check failed', error));
};

const createUpdateMenuItem = (): MenuItemConstructorOptions => ({
  label: 'Check for Updates…',
  click: () => triggerManualUpdateCheck()
});

const buildApplicationMenu = () => {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        createUpdateMenuItem(),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  } else {
    template.push({
      label: 'File',
      submenu: [createUpdateMenuItem(), { type: 'separator' }, { role: 'quit' }]
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  });

  template.push({
    label: 'Window',
    submenu:
      process.platform === 'darwin'
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }]
  });

  if (process.platform !== 'darwin') {
    template.push({
      label: 'Help',
      submenu: [createUpdateMenuItem()]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

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
    {
      label: 'Check for Updates…',
      click: () => triggerManualUpdateCheck()
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
      const normalized = normalizeServerBaseUrl(envOverride);
      baseUrl = normalized;
      if (config.serverBaseUrl !== normalized) {
        await updateConfig({ serverBaseUrl: normalized });
      }
      return;
    } catch (error) {
      logger.warn('Invalid SERVER_BASE_URL env value, falling back to stored value', error);
    }
  }

  let storedBaseUrl = config.serverBaseUrl;

  try {
    const normalizedStored = normalizeServerBaseUrl(storedBaseUrl);
    if (normalizedStored !== storedBaseUrl) {
      const updated = await updateConfig({ serverBaseUrl: normalizedStored });
      storedBaseUrl = updated.serverBaseUrl;
    } else {
      storedBaseUrl = normalizedStored;
    }
  } catch (error) {
    logger.warn('Stored server base URL invalid, resetting to default', error);
    const fallback = getDefaultServerBaseUrl();
    const updated = await updateConfig({ serverBaseUrl: fallback });
    storedBaseUrl = updated.serverBaseUrl;
  }

  const { baseUrl: resolvedBaseUrl, reason } = await resolvePreferredServerBaseUrl(storedBaseUrl);
  if (resolvedBaseUrl !== storedBaseUrl) {
    const updated = await updateConfig({ serverBaseUrl: resolvedBaseUrl });
    storedBaseUrl = updated.serverBaseUrl;
    logger.info('Server base URL auto-updated', { baseUrl: storedBaseUrl, source: reason });
  } else {
    logger.info('Resolved server base URL', { baseUrl: storedBaseUrl, source: reason });
  }

  baseUrl = storedBaseUrl;
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
    const normalized = normalizeServerBaseUrl(serverBaseUrl);
    const rawEmail = typeof payload?.workEmail === 'string' ? payload.workEmail : null;
    const trimmedEmail = rawEmail && rawEmail.trim().length > 0 ? rawEmail.trim().toLowerCase() : null;
    const updated = await updateConfig({ serverBaseUrl: normalized, workEmail: trimmedEmail });
    baseUrl = updated.serverBaseUrl;
    workEmail = updated.workEmail ?? null;
    logger.info('Settings updated', { baseUrl, workEmail });
    return serializeConfig();
  });

  ipcMain.handle('attendance:test-server-url', async (_event, url: string) => {
    const normalized = normalizeServerBaseUrl(url);
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
  buildApplicationMenu();
  applyAutoLaunch();
  setupAutoUpdates();

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

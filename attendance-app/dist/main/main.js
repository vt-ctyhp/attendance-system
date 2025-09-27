"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = require("./logger");
const config_1 = require("./config");
let mainWindow = null;
let tray = null;
let deviceId = null;
let baseUrl = (0, config_1.getDefaultServerBaseUrl)();
let workEmail = null;
let cachedQueue = [];
let activeWinUnavailable = false;
let activeWindowModule = null;
const normalizePresenceUiMode = (value) => {
    if (!value) {
        return 'both';
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'overlay' || normalized === 'popup' || normalized === 'both') {
        return normalized;
    }
    return 'both';
};
let presenceUiMode = normalizePresenceUiMode(process.env.PRESENCE_UI);
let presenceWindow = null;
let activePresencePrompt = null;
const trayIconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NgYGD4DwABBAEAAXcQ0wAAAABJRU5ErkJggg==';
const gotLock = electron_1.app.requestSingleInstanceLock();
if (!gotLock) {
    electron_1.app.quit();
    process.exit(0);
}
defaultSecondInstanceHandler();
function defaultSecondInstanceHandler() {
    electron_1.app.on('second-instance', () => {
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
const normalizeBaseUrl = (input) => {
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
const closePresenceWindow = (promptId, options) => {
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
const ensurePresenceWindow = (prompt) => {
    activePresencePrompt = prompt;
    if (presenceWindow && !presenceWindow.isDestroyed()) {
        presenceWindow.focus();
        presenceWindow.webContents.send('attendance:presence-window-data', prompt);
        return;
    }
    if (!mainWindow) {
        return;
    }
    presenceWindow = new electron_1.BrowserWindow({
        width: 360,
        height: 220,
        resizable: false,
        minimizable: false,
        maximizable: false,
        parent: mainWindow,
        modal: true,
        title: 'Presence Check',
        webPreferences: {
            preload: path_1.default.join(__dirname, '../renderer/presencePreload.js'),
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
    presenceWindow.loadFile(path_1.default.join(__dirname, '../renderer/presence.html')).catch((error) => {
        logger_1.logger.error({ err: error }, 'Failed to load presence window');
    });
};
const loadEnvironment = () => {
    const cwdEnv = path_1.default.join(process.cwd(), '.env');
    dotenv_1.default.config({ path: cwdEnv });
    const appEnvPath = electron_1.app.isPackaged ? path_1.default.join(process.resourcesPath, '.env') : path_1.default.join(electron_1.app.getAppPath(), '.env');
    dotenv_1.default.config({ path: appEnvPath });
};
const applyAutoLaunch = () => {
    if (!electron_1.app.isPackaged) {
        return;
    }
    try {
        if (process.platform === 'darwin') {
            electron_1.app.setLoginItemSettings({
                openAtLogin: true,
                openAsHidden: true
            });
        }
        else if (process.platform === 'win32') {
            electron_1.app.setLoginItemSettings({
                openAtLogin: true,
                path: process.execPath
            });
        }
        logger_1.logger.info('Auto-launch configured');
    }
    catch (error) {
        logger_1.logger.warn('Unable to set auto-launch', error);
    }
};
const createTray = () => {
    if (tray) {
        return;
    }
    const icon = electron_1.nativeImage.createFromDataURL(trayIconDataUrl);
    tray = new electron_1.Tray(icon);
    tray.setToolTip('Attendance App');
    const contextMenu = electron_1.Menu.buildFromTemplate([
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
                logger_1.logger.info('Quitting from tray');
                electron_1.app.quit();
            }
        }
    ]);
    tray.setContextMenu(contextMenu);
};
const createWindow = () => {
    mainWindow = new electron_1.BrowserWindow({
        width: 520,
        height: 640,
        resizable: false,
        title: 'Attendance App',
        webPreferences: {
            preload: path_1.default.join(__dirname, '../renderer/preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    mainWindow.loadFile(path_1.default.join(__dirname, '../renderer/index.html'));
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
};
const bootstrapConfiguration = async () => {
    const config = await (0, config_1.getConfig)();
    deviceId = config.deviceId;
    workEmail = config.workEmail ?? null;
    const envOverride = process.env.SERVER_BASE_URL;
    if (envOverride) {
        try {
            const normalized = normalizeBaseUrl(envOverride);
            baseUrl = normalized;
            if (config.serverBaseUrl !== normalized) {
                await (0, config_1.updateConfig)({ serverBaseUrl: normalized });
            }
            return;
        }
        catch (error) {
            logger_1.logger.warn('Invalid SERVER_BASE_URL env value, falling back to stored value', error);
        }
    }
    try {
        const normalizedStored = normalizeBaseUrl(config.serverBaseUrl);
        baseUrl = normalizedStored;
        if (normalizedStored !== config.serverBaseUrl) {
            await (0, config_1.updateConfig)({ serverBaseUrl: normalizedStored });
        }
    }
    catch (error) {
        logger_1.logger.warn('Stored server base URL invalid, resetting to default', error);
        const fallback = normalizeBaseUrl((0, config_1.getDefaultServerBaseUrl)());
        const updated = await (0, config_1.updateConfig)({ serverBaseUrl: fallback });
        baseUrl = updated.serverBaseUrl;
    }
};
const getSystemStatus = async () => {
    const idleSeconds = electron_1.powerMonitor.getSystemIdleTime();
    const foregroundApp = await getForegroundApp();
    return {
        idleSeconds,
        foregroundApp
    };
};
const loadActiveWindowModule = async () => {
    if (activeWinUnavailable) {
        return null;
    }
    if (activeWindowModule) {
        return activeWindowModule;
    }
    try {
        activeWindowModule = await Promise.resolve().then(() => __importStar(require('active-win')));
        return activeWindowModule;
    }
    catch (error) {
        activeWinUnavailable = true;
        logger_1.logger.info('Foreground app detection unavailable', error);
        return null;
    }
};
const getForegroundApp = async () => {
    const module = await loadActiveWindowModule();
    if (!module || !module.activeWindow) {
        return null;
    }
    try {
        const result = await module
            .activeWindow({ accessibilityPermission: false, screenRecordingPermission: false })
            .catch(() => undefined);
        if (!result) {
            return null;
        }
        return {
            title: result.title ?? null,
            owner: result.owner?.name ?? null
        };
    }
    catch (error) {
        logger_1.logger.warn('Unable to read foreground window', error);
        return null;
    }
};
const serializeConfig = () => ({
    deviceId: deviceId ?? '',
    serverBaseUrl: baseUrl,
    workEmail
});
const handleIpc = () => {
    electron_1.ipcMain.handle('attendance:get-bootstrap', async () => {
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
    electron_1.ipcMain.handle('attendance:get-system-status', async () => {
        return getSystemStatus();
    });
    electron_1.ipcMain.handle('attendance:get-settings', async () => {
        if (!deviceId) {
            await bootstrapConfiguration();
        }
        return serializeConfig();
    });
    electron_1.ipcMain.handle('attendance:update-settings', async (_event, payload) => {
        const serverBaseUrl = typeof payload?.serverBaseUrl === 'string' ? payload.serverBaseUrl : '';
        if (!serverBaseUrl.trim()) {
            throw new Error('Server URL is required');
        }
        const normalized = normalizeBaseUrl(serverBaseUrl);
        const rawEmail = typeof payload?.workEmail === 'string' ? payload.workEmail : null;
        const trimmedEmail = rawEmail && rawEmail.trim().length > 0 ? rawEmail.trim().toLowerCase() : null;
        const updated = await (0, config_1.updateConfig)({ serverBaseUrl: normalized, workEmail: trimmedEmail });
        baseUrl = updated.serverBaseUrl;
        workEmail = updated.workEmail ?? null;
        logger_1.logger.info('Settings updated', { baseUrl, workEmail });
        return serializeConfig();
    });
    electron_1.ipcMain.handle('attendance:test-server-url', async (_event, url) => {
        const normalized = normalizeBaseUrl(url);
        const healthUrl = `${normalized}/api/health`;
        try {
            const response = await fetch(healthUrl, { method: 'GET' });
            if (response.ok || response.status === 401) {
                return { ok: true, status: response.status, url: healthUrl };
            }
            return { ok: false, status: response.status, url: healthUrl };
        }
        catch (error) {
            logger_1.logger.warn('Server ping failed', { target: healthUrl, error });
            return { ok: false };
        }
    });
    electron_1.ipcMain.handle('attendance:load-offline-queue', async () => {
        if (cachedQueue.length === 0) {
            cachedQueue = await (0, config_1.loadQueue)();
        }
        return cachedQueue;
    });
    electron_1.ipcMain.handle('attendance:save-offline-queue', async (_event, queue) => {
        cachedQueue = queue;
        await (0, config_1.saveQueue)(queue);
        return { saved: true };
    });
    electron_1.ipcMain.handle('attendance:clear-offline-queue', async () => {
        cachedQueue = [];
        await (0, config_1.saveQueue)([]);
        return { cleared: true };
    });
    electron_1.ipcMain.on('attendance:presence-open', (_event, prompt) => {
        if (!shouldOpenPresenceWindow()) {
            return;
        }
        ensurePresenceWindow(prompt);
    });
    electron_1.ipcMain.on('attendance:presence-close', (_event, promptId) => {
        closePresenceWindow(promptId, { suppressDismiss: true });
    });
    electron_1.ipcMain.on('attendance:presence-window-confirm', (_event, promptId) => {
        if (mainWindow) {
            mainWindow.webContents.send('attendance:presence-window-confirm', promptId);
        }
        closePresenceWindow(promptId);
    });
    electron_1.ipcMain.on('attendance:presence-window-dismiss', (_event, promptId) => {
        closePresenceWindow(promptId);
    });
    electron_1.ipcMain.on('attendance:presence-window-ready', (event) => {
        if (presenceWindow && event.sender === presenceWindow.webContents && activePresencePrompt) {
            event.sender.send('attendance:presence-window-data', activePresencePrompt);
        }
    });
    electron_1.ipcMain.on('attendance-action', (_event, action) => {
        logger_1.logger.info('[Attendance Action]', { action });
    });
};
const setupPowerMonitorLogging = () => {
    electron_1.powerMonitor.on('suspend', () => logger_1.logger.info('System suspend detected'));
    electron_1.powerMonitor.on('resume', () => logger_1.logger.info('System resume detected'));
    electron_1.powerMonitor.on('shutdown', () => logger_1.logger.info('System shutdown event received'));
};
electron_1.app.whenReady().then(async () => {
    await (0, logger_1.initializeLogging)();
    logger_1.logger.info('Application starting');
    loadEnvironment();
    await bootstrapConfiguration();
    logger_1.logger.info('Resolved server base URL', { baseUrl });
    cachedQueue = await (0, config_1.loadQueue)();
    handleIpc();
    setupPowerMonitorLogging();
    createWindow();
    createTray();
    applyAutoLaunch();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
}).catch((error) => {
    console.error('Failed to start Attendance App', error);
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});

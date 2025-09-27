"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultServerBaseUrl = exports.saveQueue = exports.loadQueue = exports.updateConfig = exports.saveConfig = exports.getConfig = void 0;
const electron_1 = require("electron");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const logger_1 = require("./logger");
const CONFIG_FILE_NAME = 'attendance-config.json';
const QUEUE_FILE_NAME = 'offline-queue.json';
const DEFAULT_SERVER_BASE_URL = 'http://localhost:4000';
let cachedConfig = null;
const getAppDataPath = () => electron_1.app.getPath('userData');
const getConfigPath = () => path_1.default.join(getAppDataPath(), CONFIG_FILE_NAME);
const getQueuePath = () => path_1.default.join(getAppDataPath(), QUEUE_FILE_NAME);
const getConfig = async () => {
    if (cachedConfig) {
        return cachedConfig;
    }
    const configPath = getConfigPath();
    try {
        const raw = await promises_1.default.readFile(configPath, 'utf-8');
        const data = JSON.parse(raw);
        const config = {
            deviceId: data.deviceId ?? (0, crypto_1.randomUUID)(),
            serverBaseUrl: data.serverBaseUrl ?? DEFAULT_SERVER_BASE_URL,
            workEmail: typeof data.workEmail === 'string' && data.workEmail.trim().length > 0 ? data.workEmail : null
        };
        if (!data.deviceId || !data.serverBaseUrl || data.workEmail !== config.workEmail) {
            await (0, exports.saveConfig)(config);
        }
        cachedConfig = config;
        return config;
    }
    catch (error) {
        const config = {
            deviceId: (0, crypto_1.randomUUID)(),
            serverBaseUrl: DEFAULT_SERVER_BASE_URL,
            workEmail: null
        };
        await (0, exports.saveConfig)(config);
        cachedConfig = config;
        if (error.code !== 'ENOENT') {
            logger_1.logger.warn('Failed to read config, recreating', error);
        }
        return config;
    }
};
exports.getConfig = getConfig;
const saveConfig = async (config) => {
    const configPath = getConfigPath();
    await promises_1.default.mkdir(path_1.default.dirname(configPath), { recursive: true });
    await promises_1.default.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    cachedConfig = config;
};
exports.saveConfig = saveConfig;
const updateConfig = async (partial) => {
    const current = await (0, exports.getConfig)();
    const next = {
        deviceId: current.deviceId,
        serverBaseUrl: current.serverBaseUrl,
        workEmail: current.workEmail,
        ...partial
    };
    if (typeof next.workEmail === 'string') {
        const trimmedEmail = next.workEmail.trim();
        next.workEmail = trimmedEmail.length > 0 ? trimmedEmail : null;
    }
    else if (next.workEmail !== null) {
        next.workEmail = null;
    }
    await (0, exports.saveConfig)(next);
    return next;
};
exports.updateConfig = updateConfig;
const loadQueue = async () => {
    const queuePath = getQueuePath();
    try {
        const raw = await promises_1.default.readFile(queuePath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            return data;
        }
        return [];
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            logger_1.logger.warn('Failed to read offline queue, resetting', error);
        }
        return [];
    }
};
exports.loadQueue = loadQueue;
const saveQueue = async (items) => {
    const queuePath = getQueuePath();
    await promises_1.default.mkdir(path_1.default.dirname(queuePath), { recursive: true });
    await promises_1.default.writeFile(queuePath, JSON.stringify(items, null, 2), 'utf-8');
};
exports.saveQueue = saveQueue;
const getDefaultServerBaseUrl = () => DEFAULT_SERVER_BASE_URL;
exports.getDefaultServerBaseUrl = getDefaultServerBaseUrl;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeLogging = exports.logger = void 0;
const electron_1 = require("electron");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const main_1 = __importDefault(require("electron-log/main"));
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
exports.logger = main_1.default;
const initializeLogging = async () => {
    const logDir = path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    await promises_1.default.mkdir(logDir, { recursive: true });
    main_1.default.transports.file.resolvePathFn = () => path_1.default.join(logDir, 'attendance.log');
    main_1.default.transports.file.level = 'info';
    main_1.default.transports.file.maxSize = MAX_LOG_SIZE_BYTES;
    main_1.default.transports.console.level = 'warn';
    main_1.default.catchErrors({ showDialog: false });
};
exports.initializeLogging = initializeLogging;
exports.default = exports.logger;

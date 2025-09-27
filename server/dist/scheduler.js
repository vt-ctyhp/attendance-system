"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSchedulers = void 0;
const node_schedule_1 = __importDefault(require("node-schedule"));
const accruals_1 = require("./services/accruals");
const logger_1 = require("./logger");
const startSchedulers = () => {
    node_schedule_1.default.scheduleJob('0 0 2 1 * *', async () => {
        try {
            await (0, accruals_1.applyAccrualsForAllUsers)();
        }
        catch (error) {
            logger_1.logger.error({ err: error }, 'Monthly accrual job failed');
        }
    });
};
exports.startSchedulers = startSchedulers;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("./env");
const app_1 = require("./app");
const bootstrap_1 = require("./bootstrap");
const logger_1 = require("./logger");
const presenceScheduler_1 = require("./services/presenceScheduler");
const prisma_1 = require("./prisma");
const scheduler_1 = require("./scheduler");
const backup_1 = require("./services/backup");
const app = (0, app_1.buildApp)();
const start = async () => {
    await (0, bootstrap_1.bootstrap)();
    (0, presenceScheduler_1.startPresenceMonitor)();
    (0, scheduler_1.startSchedulers)();
    const stopBackups = (0, backup_1.startDatabaseBackups)();
    const server = app.listen(env_1.env.PORT, () => {
        logger_1.logger.info(`Server listening on port ${env_1.env.PORT}`);
    });
    const shutdown = async (signal) => {
        logger_1.logger.info({ signal }, 'Shutting down');
        (0, presenceScheduler_1.stopPresenceMonitor)();
        stopBackups();
        await prisma_1.prisma.$disconnect();
        server.close(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
};
start().catch((err) => {
    logger_1.logger.error({ err }, 'Failed to start server');
    process.exit(1);
});

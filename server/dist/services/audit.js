"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAuthEvent = void 0;
const client_1 = require("@prisma/client");
const prisma_1 = require("../prisma");
const logger_1 = require("../logger");
const createAuditLog = async (data) => {
    try {
        await prisma_1.prisma.authAuditLog.create({ data });
    }
    catch (error) {
        if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
            await prisma_1.prisma.authAuditLog.create({ data: { ...data, userId: null } });
            return;
        }
        throw error;
    }
};
const recordAuthEvent = async (input) => {
    switch (input.event) {
        case 'email_session_attempt':
            await createAuditLog({
                email: input.email,
                userId: input.userId ?? null,
                event: input.event,
                success: input.success,
                reason: input.reason,
                ipAddress: input.ipAddress,
                userAgent: input.userAgent,
                deviceId: input.deviceId
            });
            logger_1.logger.info({
                event: input.event,
                email: input.email,
                userId: input.userId,
                success: input.success,
                reason: input.reason,
                ip: input.ipAddress,
                userAgent: input.userAgent,
                deviceId: input.deviceId
            }, 'Email session attempt');
            break;
        case 'email_session_token_issued':
            await createAuditLog({
                email: input.email,
                userId: input.userId,
                event: input.event,
                success: true,
                reason: 'issued',
                ipAddress: input.ipAddress,
                userAgent: input.userAgent,
                deviceId: input.deviceId
            });
            logger_1.logger.info({
                event: input.event,
                email: input.email,
                userId: input.userId,
                scope: input.scope,
                accessExpiresAt: input.accessExpiresAt.toISOString(),
                refreshExpiresAt: input.refreshExpiresAt.toISOString(),
                ip: input.ipAddress,
                userAgent: input.userAgent,
                deviceId: input.deviceId
            }, 'Issued email-session tokens');
            break;
        default:
            break;
    }
};
exports.recordAuthEvent = recordAuthEvent;

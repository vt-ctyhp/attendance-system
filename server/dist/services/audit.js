"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAuthEvent = void 0;
const prisma_1 = require("../prisma");
const logger_1 = require("../logger");
const recordAuthEvent = async (input) => {
    switch (input.event) {
        case 'email_session_attempt':
            await prisma_1.prisma.authAuditLog.create({
                data: {
                    email: input.email,
                    userId: input.userId ?? null,
                    event: input.event,
                    success: input.success,
                    reason: input.reason,
                    ipAddress: input.ipAddress,
                    userAgent: input.userAgent,
                    deviceId: input.deviceId
                }
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
            await prisma_1.prisma.authAuditLog.create({
                data: {
                    email: input.email,
                    userId: input.userId,
                    event: input.event,
                    success: true,
                    reason: 'issued',
                    ipAddress: input.ipAddress,
                    userAgent: input.userAgent,
                    deviceId: input.deviceId
                }
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

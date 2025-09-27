"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSessionPauses = exports.endSession = exports.startSession = exports.sessionsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const auth_1 = require("../auth");
const prisma_1 = require("../prisma");
const presenceScheduler_1 = require("../services/presenceScheduler");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const errors_1 = require("../errors");
const rateLimit_1 = require("../middleware/rateLimit");
const featureFlags_1 = require("../services/featureFlags");
const tokenService_1 = require("../services/tokenService");
const audit_1 = require("../services/audit");
const metrics_1 = require("../services/metrics");
const logger_1 = require("../logger");
const startSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    deviceId: zod_1.z.string().min(3),
    platform: zod_1.z.string().optional()
});
const endSchema = zod_1.z.object({
    sessionId: zod_1.z.string().min(1)
});
const emailStartSchema = zod_1.z.object({
    flow: zod_1.z.literal('email_only'),
    email: zod_1.z.string().email(),
    deviceId: zod_1.z.string().min(3).optional()
});
const refreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(32)
});
exports.sessionsRouter = (0, express_1.Router)();
const sessionRateLimiter = (0, rateLimit_1.createRateLimiter)({
    windowMs: 60000,
    max: 15,
    message: 'Session endpoint rate limit exceeded'
});
const emailSessionIpLimiter = (0, rateLimit_1.createRateLimiter)({
    windowMs: 60000,
    max: 6,
    message: 'Too many attempts'
});
const emailSessionAddressLimiter = (0, rateLimit_1.createRateLimiter)({
    windowMs: 60000,
    max: 4,
    message: 'Too many attempts',
    keyResolver: (req) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'unknown';
        return `email:${email}`;
    }
});
const refreshLimiter = (0, rateLimit_1.createRateLimiter)({
    windowMs: 60000,
    max: 30,
    message: 'Too many refresh attempts'
});
const runLimiter = (limiter, req, res) => new Promise((resolve, reject) => {
    limiter(req, res, (err) => {
        if (err) {
            reject(err);
        }
        else {
            resolve();
        }
    });
});
const unauthorizedError = () => errors_1.HttpError.unauthorized('Unauthorized');
const handleEmailOnlyStart = async (req, res) => {
    const reqId = req.debugReqId;
    await runLimiter(emailSessionIpLimiter, req, res);
    await runLimiter(emailSessionAddressLimiter, req, res);
    const { email, deviceId } = (0, validation_1.parseWithSchema)(emailStartSchema, req.body);
    const normalizedEmail = email.trim().toLowerCase();
    const ipAddress = req.ip;
    const userAgent = req.get('user-agent') ?? undefined;
    const logAttempt = async (success, reason, userId) => {
        await (0, audit_1.recordAuthEvent)({
            event: 'email_session_attempt',
            email: normalizedEmail,
            userId,
            success,
            reason,
            ipAddress,
            userAgent,
            deviceId
        });
    };
    if (!(await (0, featureFlags_1.isEmailSessionEnabled)())) {
        (0, metrics_1.incrementMetric)('email_session_flag_disabled');
        await logAttempt(false, 'flag_disabled');
        throw unauthorizedError();
    }
    if (!(0, featureFlags_1.isIpAllowed)(req)) {
        (0, metrics_1.incrementMetric)('email_session_ip_blocked');
        await logAttempt(false, 'ip_blocked');
        throw unauthorizedError();
    }
    if (!(0, featureFlags_1.isClientHeaderValid)(req)) {
        (0, metrics_1.incrementMetric)('email_session_header_invalid');
        await logAttempt(false, 'client_header_invalid');
        throw unauthorizedError();
    }
    let user = await prisma_1.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
        const passwordHash = await (0, auth_1.hashPassword)((0, crypto_1.randomUUID)());
        const defaultName = normalizedEmail.split('@')[0] || normalizedEmail;
        user = await prisma_1.prisma.user.create({
            data: {
                email: normalizedEmail,
                name: defaultName,
                role: 'employee',
                passwordHash,
                active: true
            }
        });
        await logAttempt(true, 'auto_created', user.id);
    }
    else {
        if (user.role !== 'employee') {
            await logAttempt(false, 'user_not_found');
            throw unauthorizedError();
        }
        if (!user.active) {
            await logAttempt(false, 'user_inactive', user.id);
            throw unauthorizedError();
        }
        await logAttempt(true, 'ok', user.id);
    }
    const tokens = await (0, tokenService_1.issueEmployeeTokens)({
        userId: user.id,
        email: user.email,
        deviceId,
        ipAddress,
        userAgent
    });
    (0, metrics_1.incrementMetric)('email_session_success');
    logger_1.logger.debug({ reqId, email: user.email, userId: user.id }, 'session.email_only.issued_tokens');
    return res.json({
        tokenType: 'Bearer',
        scope: tokens.scope,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString()
    });
};
const startSession = async (req, res) => {
    const reqId = req.debugReqId;
    if (req.body?.flow === 'email_only') {
        return handleEmailOnlyStart(req, res);
    }
    const { email, deviceId, platform } = (0, validation_1.parseWithSchema)(startSchema, req.body);
    const trimmedEmail = email.trim();
    const normalizedEmail = trimmedEmail.toLowerCase();
    let user = await prisma_1.prisma.user.findUnique({ where: { email: trimmedEmail } });
    if (!user && normalizedEmail !== trimmedEmail) {
        user = await prisma_1.prisma.user.findUnique({ where: { email: normalizedEmail } });
    }
    if (!user) {
        const passwordHash = await (0, auth_1.hashPassword)((0, crypto_1.randomUUID)());
        const defaultName = trimmedEmail.split('@')[0] || normalizedEmail;
        user = await prisma_1.prisma.user.create({
            data: {
                email: normalizedEmail,
                name: defaultName,
                role: 'employee',
                passwordHash,
                active: true
            }
        });
    }
    const active = await prisma_1.prisma.session.findFirst({
        where: { userId: user.id, status: 'active' },
        orderBy: { startedAt: 'desc' }
    });
    if (active) {
        const requiresDeviceUpdate = active.deviceId !== deviceId;
        if (requiresDeviceUpdate) {
            await prisma_1.prisma.session.update({
                where: { id: active.id },
                data: { deviceId }
            });
        }
        logger_1.logger.debug({
            reqId,
            userId: user.id,
            deviceId,
            sessionId: active.id,
            existing: true,
            deviceUpdated: requiresDeviceUpdate
        }, 'session.start.reused');
        return res.status(200).json({
            sessionId: active.id,
            email: user.email,
            userId: user.id,
            existing: true
        });
    }
    const session = await prisma_1.prisma.session.create({
        data: {
            userId: user.id,
            deviceId,
            status: 'active'
        }
    });
    const prompts = await (0, presenceScheduler_1.ensurePresencePlan)(session.id, session.startedAt);
    if (session.presencePlanCount !== prompts.length) {
        await prisma_1.prisma.session.update({
            where: { id: session.id },
            data: { presencePlanCount: prompts.length }
        });
    }
    await prisma_1.prisma.event.create({
        data: {
            sessionId: session.id,
            type: 'login',
            payload: JSON.stringify({ platform, deviceId })
        }
    });
    logger_1.logger.debug({ reqId, userId: user.id, sessionId: session.id, deviceId }, 'session.start.created');
    return res.status(201).json({
        sessionId: session.id,
        email: user.email,
        userId: user.id
    });
};
exports.startSession = startSession;
const endSession = async (req, res) => {
    const { sessionId } = (0, validation_1.parseWithSchema)(endSchema, req.body);
    const session = await prisma_1.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
        throw errors_1.HttpError.notFound('Session not found', { field: 'sessionId', hint: 'Start a session before ending it' });
    }
    if (session.status !== 'active') {
        throw errors_1.HttpError.badRequest('Session already ended', {
            field: 'sessionId',
            hint: 'Start a new session before attempting further actions'
        });
    }
    const endedAt = new Date();
    const updated = await prisma_1.prisma.session.update({
        where: { id: sessionId },
        data: {
            status: 'ended',
            endedAt
        }
    });
    await prisma_1.prisma.event.create({
        data: {
            sessionId,
            type: 'logout',
            payload: JSON.stringify({ endedAt })
        }
    });
    return res.json({
        session: {
            id: updated.id,
            startedAt: updated.startedAt,
            endedAt: updated.endedAt,
            status: updated.status
        }
    });
};
exports.endSession = endSession;
exports.sessionsRouter.post('/start', sessionRateLimiter, (0, asyncHandler_1.asyncHandler)(exports.startSession));
exports.sessionsRouter.post('/end', sessionRateLimiter, (0, asyncHandler_1.asyncHandler)(exports.endSession));
const serializeSessionPause = (pause, now) => {
    const durationMinutes = pause.durationMinutes ?? Math.max(0, Math.ceil((now.getTime() - pause.startedAt.getTime()) / 60000));
    return {
        id: pause.id,
        kind: pause.type,
        sequence: pause.sequence,
        startedAt: pause.startedAt.toISOString(),
        endedAt: pause.endedAt ? pause.endedAt.toISOString() : null,
        durationMinutes
    };
};
const getSessionPauses = async (req, res) => {
    const { sessionId } = req.params;
    const session = await prisma_1.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
            pauses: {
                orderBy: { startedAt: 'asc' }
            }
        }
    });
    if (!session) {
        throw errors_1.HttpError.notFound('Session not found');
    }
    const now = new Date();
    const currentPause = session.pauses.find((pause) => pause.endedAt === null);
    const historyPauses = session.pauses.filter((pause) => pause.endedAt !== null);
    return res.json({
        current: currentPause ? serializeSessionPause(currentPause, now) : null,
        history: historyPauses.map((pause) => serializeSessionPause(pause, now))
    });
};
exports.getSessionPauses = getSessionPauses;
exports.sessionsRouter.get('/:sessionId/pauses', sessionRateLimiter, (0, asyncHandler_1.asyncHandler)(exports.getSessionPauses));
const refreshSession = async (req, res) => {
    const { refreshToken } = (0, validation_1.parseWithSchema)(refreshSchema, req.body);
    if (!(await (0, featureFlags_1.isEmailSessionEnabled)())) {
        (0, metrics_1.incrementMetric)('email_session_refresh_flag_disabled');
        throw unauthorizedError();
    }
    try {
        const rotation = await (0, tokenService_1.rotateEmployeeTokens)({
            refreshToken,
            ipAddress: req.ip,
            userAgent: req.get('user-agent') ?? undefined
        });
        (0, metrics_1.incrementMetric)('email_session_refresh_success');
        await (0, audit_1.recordAuthEvent)({
            event: 'email_session_attempt',
            email: rotation.email,
            userId: rotation.userId,
            success: true,
            reason: 'refresh_ok',
            ipAddress: req.ip,
            userAgent: req.get('user-agent') ?? undefined
        });
        return res.json({
            tokenType: 'Bearer',
            scope: rotation.result.scope,
            accessToken: rotation.result.accessToken,
            accessTokenExpiresAt: rotation.result.accessTokenExpiresAt.toISOString(),
            refreshToken: rotation.result.refreshToken,
            refreshTokenExpiresAt: rotation.result.refreshTokenExpiresAt.toISOString()
        });
    }
    catch (error) {
        let reason = 'refresh_failed';
        let emailForLog = 'unknown';
        let userId;
        if (error instanceof Error && 'code' in error) {
            reason = String(error.code ?? error.message ?? 'refresh_failed');
            const meta = error.meta;
            if (meta && typeof meta.userId === 'number') {
                userId = meta.userId;
            }
        }
        else if (error instanceof Error && error.message) {
            reason = error.message;
        }
        if (userId) {
            const user = await prisma_1.prisma.user.findUnique({ where: { id: userId } });
            if (user) {
                emailForLog = user.email;
            }
        }
        (0, metrics_1.incrementMetric)(`email_session_refresh_error_${reason}`);
        logger_1.logger.warn({ reason }, 'Email session refresh denied');
        await (0, audit_1.recordAuthEvent)({
            event: 'email_session_attempt',
            email: emailForLog,
            userId,
            success: false,
            reason,
            ipAddress: req.ip,
            userAgent: req.get('user-agent') ?? undefined
        });
        throw unauthorizedError();
    }
};
exports.sessionsRouter.post('/refresh', refreshLimiter, (0, asyncHandler_1.asyncHandler)(refreshSession));

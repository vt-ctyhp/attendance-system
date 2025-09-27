"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordSimpleEvent = exports.heartbeat = exports.eventsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../prisma");
const presenceScheduler_1 = require("../services/presenceScheduler");
const sessionState_1 = require("../services/sessionState");
const date_fns_1 = require("date-fns");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const errors_1 = require("../errors");
const rateLimit_1 = require("../middleware/rateLimit");
const logger_1 = require("../logger");
const heartbeatSchema = zod_1.z.object({
    sessionId: zod_1.z.string().min(1),
    timestamp: zod_1.z.string().datetime(),
    activeMinute: zod_1.z.boolean(),
    idleFlag: zod_1.z.boolean(),
    idleSeconds: zod_1.z.number().min(0).nullable().optional(),
    keysCount: zod_1.z.number().int().min(0).optional().default(0),
    mouseCount: zod_1.z.number().int().min(0).optional().default(0),
    foregroundAppTitle: zod_1.z.string().optional().nullable(),
    foregroundAppOwner: zod_1.z.string().optional().nullable(),
    activityBuckets: zod_1.z
        .array(zod_1.z.object({
        minute: zod_1.z.string(),
        keys: zod_1.z.number().int().min(0),
        mouse: zod_1.z.number().int().min(0)
    }))
        .optional(),
    platform: zod_1.z.string().optional()
});
const simpleEventSchema = zod_1.z.object({
    sessionId: zod_1.z.string().min(1),
    timestamp: zod_1.z.string().datetime().optional()
});
const presenceConfirmSchema = zod_1.z.object({
    sessionId: zod_1.z.string().min(1),
    promptId: zod_1.z.string().min(1),
    timestamp: zod_1.z.string().datetime()
});
exports.eventsRouter = (0, express_1.Router)();
const heartbeatRateLimiter = (0, rateLimit_1.createRateLimiter)({
    windowMs: 60000,
    max: 240,
    message: 'Heartbeat rate exceeded',
    keyResolver: (req) => {
        const body = req.body;
        if (body && typeof body.sessionId === 'string') {
            return `session:${body.sessionId}`;
        }
        return req.ip ?? 'unknown';
    }
});
const requireActiveSession = async (sessionId, context) => {
    const session = await prisma_1.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
        logger_1.logger.warn({
            reqId: context?.reqId ?? null,
            sessionId,
            type: context?.type ?? null
        }, 'requireActiveSession:not_found');
        throw errors_1.HttpError.notFound('Session not found', { field: 'sessionId', hint: 'Start a session before sending activity events' });
    }
    if (session.status !== 'active') {
        logger_1.logger.warn({
            reqId: context?.reqId ?? null,
            sessionId,
            type: context?.type ?? null,
            status: session.status
        }, 'requireActiveSession:not_active');
        throw errors_1.HttpError.badRequest('Session not active', {
            field: 'sessionId',
            hint: 'Restart the session before submitting break or lunch events'
        });
    }
    logger_1.logger.debug({
        reqId: context?.reqId ?? null,
        sessionId,
        type: context?.type ?? null,
        status: session.status
    }, 'requireActiveSession:ok');
    return session;
};
const heartbeat = async (req, res) => {
    const { sessionId, timestamp, activeMinute, idleFlag, idleSeconds, keysCount, mouseCount, foregroundAppTitle, foregroundAppOwner, activityBuckets, platform } = (0, validation_1.parseWithSchema)(heartbeatSchema, req.body);
    const ts = new Date(timestamp);
    const minuteStart = (0, date_fns_1.startOfMinute)(ts);
    const reqId = req.debugReqId;
    const session = await requireActiveSession(sessionId, { reqId, type: 'heartbeat' });
    logger_1.logger.debug({
        reqId: reqId ?? null,
        sessionId,
        idleFlag,
        activeMinute,
        timestamp,
        keysCount,
        mouseCount
    }, 'events.heartbeat');
    await (0, presenceScheduler_1.ensurePresencePlan)(session.id, session.startedAt);
    await (0, presenceScheduler_1.expirePrompts)(new Date());
    await prisma_1.prisma.minuteStat.upsert({
        where: {
            sessionId_minuteStart: {
                sessionId,
                minuteStart
            }
        },
        update: {
            active: activeMinute,
            idle: idleFlag,
            keysCount,
            mouseCount,
            fgApp: foregroundAppTitle || null
        },
        create: {
            sessionId,
            minuteStart,
            active: activeMinute,
            idle: idleFlag,
            keysCount,
            mouseCount,
            fgApp: foregroundAppTitle || null
        }
    });
    await prisma_1.prisma.event.create({
        data: {
            sessionId,
            type: 'heartbeat',
            ts,
            payload: JSON.stringify({
                activeMinute,
                idleFlag,
                idleSeconds: idleSeconds ?? null,
                keysCount,
                mouseCount,
                foregroundAppTitle,
                foregroundAppOwner,
                activityBuckets,
                platform
            })
        }
    });
    let prompt = await prisma_1.prisma.presencePrompt.findFirst({
        where: {
            sessionId,
            status: 'triggered',
            respondedAt: null
        },
        orderBy: { scheduledAt: 'asc' }
    });
    if (!prompt) {
        const due = await (0, presenceScheduler_1.getDuePrompt)(sessionId, ts);
        if (due) {
            const { onBreak, onLunch } = await (0, sessionState_1.getSessionState)(sessionId);
            if (onBreak || onLunch) {
                await (0, presenceScheduler_1.delayPrompt)(due.id, 5);
            }
            else {
                prompt = await (0, presenceScheduler_1.triggerPrompt)(due.id, ts);
                await prisma_1.prisma.event.create({
                    data: {
                        sessionId,
                        type: 'presence_check',
                        ts,
                        payload: JSON.stringify({
                            promptId: prompt.id,
                            scheduledAt: prompt.scheduledAt,
                            expiresAt: prompt.expiresAt,
                            triggeredAt: prompt.triggeredAt,
                            reason: 'heartbeat_due'
                        })
                    }
                });
            }
        }
    }
    return res.json({
        status: 'ok',
        presencePrompt: prompt
            ? {
                id: prompt.id,
                scheduledAt: prompt.scheduledAt,
                expiresAt: prompt.expiresAt,
                status: prompt.status
            }
            : null
    });
};
exports.heartbeat = heartbeat;
exports.eventsRouter.post('/heartbeat', heartbeatRateLimiter, (0, asyncHandler_1.asyncHandler)(exports.heartbeat));
const pauseMetaByEvent = {
    break_start: { kind: 'break', action: 'start' },
    break_end: { kind: 'break', action: 'end' },
    lunch_start: { kind: 'lunch', action: 'start' },
    lunch_end: { kind: 'lunch', action: 'end' }
};
const createPause = async (sessionId, kind, ts) => {
    const existingOpen = await prisma_1.prisma.sessionPause.findFirst({
        where: { sessionId, type: kind, endedAt: null },
        orderBy: { startedAt: 'desc' }
    });
    if (existingOpen) {
        return {
            kind,
            action: 'start',
            sequence: existingOpen.sequence,
            startedAt: existingOpen.startedAt
        };
    }
    const existingCount = await prisma_1.prisma.sessionPause.count({ where: { sessionId, type: kind } });
    const pause = await prisma_1.prisma.sessionPause.create({
        data: {
            sessionId,
            type: kind,
            sequence: existingCount + 1,
            startedAt: ts
        }
    });
    return { kind, action: 'start', sequence: pause.sequence, startedAt: pause.startedAt };
};
const completePause = async (sessionId, kind, ts) => {
    const pause = await prisma_1.prisma.sessionPause.findFirst({
        where: { sessionId, type: kind, endedAt: null },
        orderBy: { startedAt: 'desc' }
    });
    if (!pause) {
        logger_1.logger.warn({ sessionId, kind }, 'pause.complete.missing_open_record');
        return undefined;
    }
    const durationMinutes = Math.max(0, Math.ceil((ts.getTime() - pause.startedAt.getTime()) / 60000));
    const updated = await prisma_1.prisma.sessionPause.update({
        where: { id: pause.id },
        data: { endedAt: ts, durationMinutes }
    });
    return {
        kind,
        action: 'end',
        sequence: updated.sequence,
        startedAt: updated.startedAt,
        endedAt: updated.endedAt ?? ts,
        durationMinutes: updated.durationMinutes ?? durationMinutes
    };
};
const handlePause = async (sessionId, meta, ts) => (meta.action === 'start' ? createPause(sessionId, meta.kind, ts) : completePause(sessionId, meta.kind, ts));
const serializePause = (pause) => ({
    kind: pause.kind,
    action: pause.action,
    sequence: pause.sequence,
    startedAt: pause.startedAt.toISOString(),
    endedAt: pause.endedAt ? pause.endedAt.toISOString() : null,
    durationMinutes: pause.durationMinutes ?? null
});
const recordSimpleEvent = async (body, type, context) => {
    const { sessionId, timestamp } = (0, validation_1.parseWithSchema)(simpleEventSchema, body);
    await requireActiveSession(sessionId, { reqId: context?.reqId, type });
    const ts = timestamp ? new Date(timestamp) : new Date();
    const pauseMeta = pauseMetaByEvent[type];
    const pause = pauseMeta ? await handlePause(sessionId, pauseMeta, ts) : undefined;
    await prisma_1.prisma.event.create({
        data: {
            sessionId,
            type,
            ts,
            payload: JSON.stringify({ timestamp: ts })
        }
    });
    logger_1.logger.debug({
        reqId: context?.reqId ?? null,
        sessionId,
        type,
        timestamp: ts.toISOString(),
        pause: pause ? { kind: pause.kind, sequence: pause.sequence } : null
    }, 'events.simple');
    return pause ? { pause: serializePause(pause) } : {};
};
exports.recordSimpleEvent = recordSimpleEvent;
const simpleRoutes = [
    { path: '/break/start', type: 'break_start' },
    { path: '/break/end', type: 'break_end' },
    { path: '/lunch/start', type: 'lunch_start' },
    { path: '/lunch/end', type: 'lunch_end' }
];
for (const { path, type } of simpleRoutes) {
    exports.eventsRouter.post(path, heartbeatRateLimiter, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
        const reqId = req.debugReqId;
        logger_1.logger.debug({
            reqId: reqId ?? null,
            path,
            type,
            body: req.body
        }, 'events.simple.request');
        const result = await (0, exports.recordSimpleEvent)(req.body, type, { reqId });
        if (result.pause) {
            return res.status(200).json({ status: 'ok', pause: result.pause });
        }
        return res.status(204).send();
    }));
}
exports.eventsRouter.post('/presence/confirm', heartbeatRateLimiter, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { sessionId, promptId, timestamp } = (0, validation_1.parseWithSchema)(presenceConfirmSchema, req.body);
    await requireActiveSession(sessionId);
    const prompt = await prisma_1.prisma.presencePrompt.findUnique({ where: { id: promptId } });
    if (!prompt) {
        throw errors_1.HttpError.notFound('Prompt not found');
    }
    if (prompt.status === 'missed') {
        throw errors_1.HttpError.conflict('Prompt already missed');
    }
    await (0, presenceScheduler_1.confirmPrompt)(promptId, new Date(timestamp));
    await prisma_1.prisma.event.create({
        data: {
            sessionId,
            type: 'presence_check',
            ts: new Date(timestamp),
            payload: JSON.stringify({
                promptId,
                status: 'confirmed'
            })
        }
    });
    return res.status(204).send();
}));

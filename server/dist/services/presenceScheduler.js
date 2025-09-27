"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.minutesBetweenPrompts = exports.isEligibleForPrompt = exports.stopPresenceMonitor = exports.startPresenceMonitor = exports.expirePrompts = exports.confirmPrompt = exports.delayPrompt = exports.triggerPrompt = exports.getDuePrompt = exports.ensurePresencePlan = void 0;
const date_fns_1 = require("date-fns");
const prisma_1 = require("../prisma");
const logger_1 = require("../logger");
const MIN_GAP_MINUTES = 90;
const FIRST_WINDOW_MINUTES = { min: 30, max: 240 };
const SECOND_EXTRA_MINUTES = { min: MIN_GAP_MINUTES, max: 240 };
const CHECK_EXPIRATION_SECONDS = 60;
const MONITOR_INTERVAL_MS = 15000;
const randBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const ensurePresencePlan = async (sessionId, startedAt) => {
    const existing = await prisma_1.prisma.presencePrompt.findMany({ where: { sessionId }, orderBy: { scheduledAt: 'asc' } });
    if (existing.length >= 2) {
        return existing;
    }
    const firstOffset = randBetween(FIRST_WINDOW_MINUTES.min, FIRST_WINDOW_MINUTES.max);
    const firstAt = (0, date_fns_1.addMinutes)(startedAt, firstOffset);
    const secondOffset = firstOffset + randBetween(SECOND_EXTRA_MINUTES.min, SECOND_EXTRA_MINUTES.max);
    const secondAt = (0, date_fns_1.addMinutes)(startedAt, secondOffset);
    const data = [firstAt, secondAt]
        .slice(existing.length)
        .map((scheduledAt) => ({ sessionId, scheduledAt }));
    if (data.length) {
        await prisma_1.prisma.presencePrompt.createMany({ data });
    }
    return prisma_1.prisma.presencePrompt.findMany({ where: { sessionId }, orderBy: { scheduledAt: 'asc' } });
};
exports.ensurePresencePlan = ensurePresencePlan;
const getDuePrompt = async (sessionId, now) => prisma_1.prisma.presencePrompt.findFirst({
    where: {
        sessionId,
        status: 'scheduled',
        scheduledAt: { lte: now }
    },
    orderBy: { scheduledAt: 'asc' }
});
exports.getDuePrompt = getDuePrompt;
const triggerPrompt = async (promptId, now) => {
    const expiresAt = new Date(now.getTime() + CHECK_EXPIRATION_SECONDS * 1000);
    return prisma_1.prisma.presencePrompt.update({
        where: { id: promptId },
        data: {
            status: 'triggered',
            triggeredAt: now,
            expiresAt
        }
    });
};
exports.triggerPrompt = triggerPrompt;
const delayPrompt = async (promptId, minutes) => {
    const prompt = await prisma_1.prisma.presencePrompt.findUnique({ where: { id: promptId } });
    if (!prompt)
        return null;
    const next = (0, date_fns_1.addMinutes)(new Date(), minutes);
    return prisma_1.prisma.presencePrompt.update({
        where: { id: promptId },
        data: {
            scheduledAt: next,
            status: 'scheduled',
            triggeredAt: null,
            expiresAt: null
        }
    });
};
exports.delayPrompt = delayPrompt;
const confirmPrompt = async (promptId, now) => prisma_1.prisma.presencePrompt.update({
    where: { id: promptId },
    data: {
        status: 'confirmed',
        respondedAt: now
    }
});
exports.confirmPrompt = confirmPrompt;
const expirePrompts = async (now) => {
    const expired = await prisma_1.prisma.presencePrompt.findMany({
        where: {
            status: 'triggered',
            expiresAt: { lte: now },
            respondedAt: null
        },
        take: 20
    });
    if (!expired.length)
        return expired;
    const ids = expired.map((p) => p.id);
    await prisma_1.prisma.presencePrompt.updateMany({
        where: { id: { in: ids } },
        data: {
            status: 'missed',
            respondedAt: now
        }
    });
    for (const prompt of expired) {
        await prisma_1.prisma.event.create({
            data: {
                sessionId: prompt.sessionId,
                type: 'presence_miss',
                payload: JSON.stringify({
                    promptId: prompt.id,
                    scheduledAt: prompt.scheduledAt,
                    triggeredAt: prompt.triggeredAt,
                    expiresAt: prompt.expiresAt,
                    recordedAt: now
                })
            }
        });
        logger_1.logger.warn({ promptId: prompt.id, sessionId: prompt.sessionId }, 'Presence check missed');
    }
    return expired;
};
exports.expirePrompts = expirePrompts;
let monitor = null;
const startPresenceMonitor = () => {
    if (monitor)
        return;
    monitor = setInterval(() => {
        (0, exports.expirePrompts)(new Date()).catch((err) => logger_1.logger.error({ err }, 'Failed to expire prompts'));
    }, MONITOR_INTERVAL_MS);
};
exports.startPresenceMonitor = startPresenceMonitor;
const stopPresenceMonitor = () => {
    if (monitor) {
        clearInterval(monitor);
        monitor = null;
    }
};
exports.stopPresenceMonitor = stopPresenceMonitor;
const isEligibleForPrompt = (events) => {
    const last = [...events].reverse().find((event) => ['break_start', 'break_end', 'lunch_start', 'lunch_end'].includes(event));
    if (!last)
        return true;
    if (last === 'break_start' || last === 'lunch_start')
        return false;
    return true;
};
exports.isEligibleForPrompt = isEligibleForPrompt;
const minutesBetweenPrompts = (promptA, promptB) => Math.abs((0, date_fns_1.differenceInMinutes)(promptA, promptB));
exports.minutesBetweenPrompts = minutesBetweenPrompts;

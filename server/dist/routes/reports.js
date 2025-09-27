"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const date_fns_1 = require("date-fns");
const auth_1 = require("../auth");
const prisma_1 = require("../prisma");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const errors_1 = require("../errors");
const summaryQuerySchema = zod_1.z.object({
    date: zod_1.z.string().optional()
});
const sanitizeDate = (dateString) => {
    if (!dateString)
        return new Date();
    const parsed = new Date(dateString);
    if (Number.isNaN(parsed.getTime())) {
        throw errors_1.HttpError.badRequest('Invalid date');
    }
    return parsed;
};
exports.reportsRouter = (0, express_1.Router)();
exports.reportsRouter.get('/summary', auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { date } = (0, validation_1.parseWithSchema)(summaryQuerySchema, req.query, 'Invalid query');
    const targetDate = sanitizeDate(date);
    const from = (0, date_fns_1.startOfDay)(targetDate);
    const to = (0, date_fns_1.endOfDay)(targetDate);
    const sessions = await prisma_1.prisma.session.findMany({
        where: {
            startedAt: {
                gte: from,
                lte: to
            }
        },
        include: {
            user: true,
            minuteStats: true,
            events: true
        }
    });
    const summaries = new Map();
    for (const session of sessions) {
        const summary = summaries.get(session.userId) ?? buildSummary(session.userId, session.user.name, session.user.email);
        const activeMinutes = session.minuteStats.filter((m) => m.active).length;
        const idleMinutes = session.minuteStats.filter((m) => m.idle).length;
        const presenceMisses = session.events.filter((e) => e.type === 'presence_miss').length;
        const breaks = session.events.filter((e) => e.type === 'break_start').length;
        const lunches = session.events.filter((e) => e.type === 'lunch_start').length;
        summary.sessions.push({
            sessionId: session.id,
            startedAt: session.startedAt,
            endedAt: session.endedAt ?? null,
            status: session.status,
            activeMinutes,
            idleMinutes,
            breaks,
            lunches,
            presenceMisses
        });
        summary.totalActiveMinutes += activeMinutes;
        summary.totalIdleMinutes += idleMinutes;
        summary.totalPresenceMisses += presenceMisses;
        summaries.set(session.userId, summary);
    }
    return res.json({
        date: from.toISOString(),
        summaries: Array.from(summaries.values())
    });
}));
const buildSummary = (userId, name, email) => ({
    userId,
    name,
    email,
    totalActiveMinutes: 0,
    totalIdleMinutes: 0,
    totalPresenceMisses: 0,
    sessions: []
});

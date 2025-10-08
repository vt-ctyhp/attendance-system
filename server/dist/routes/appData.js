"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appDataRouter = exports.getAppOverview = void 0;
const express_1 = require("express");
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const zod_1 = require("zod");
const prisma_1 = require("../prisma");
const asyncHandler_1 = require("../middleware/asyncHandler");
const errors_1 = require("../errors");
const validation_1 = require("../utils/validation");
const timesheets_1 = require("../services/timesheets");
const timeRequestPolicy_1 = require("../services/timeRequestPolicy");
const schedule_1 = require("../services/schedule");
const overviewQuerySchema = zod_1.z.object({
    email: zod_1.z
        .string()
        .trim()
        .min(1)
        .transform((value) => value.toLowerCase())
});
const formatDate = (date, pattern) => (0, date_fns_tz_1.formatInTimeZone)(date, timesheets_1.TIMESHEET_TIME_ZONE, pattern);
const isoDate = (date) => formatDate(date, 'yyyy-MM-dd');
const dayLabel = (date) => formatDate(date, 'EEE, MMM d');
const longDate = (date) => formatDate(date, 'LLLL d, yyyy');
const roundHours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const roundToQuarterHour = (hours) => Math.round(hours * 4) / 4;
const MINUTE_MS = 60000;
const buildIdleActivities = (minuteStats, pauses, reference) => {
    if (!minuteStats.length) {
        return [];
    }
    const pauseWindows = pauses
        .map((pause) => ({ start: pause.startedAt, end: pause.endedAt ?? reference }))
        .filter((window) => window.end.getTime() > window.start.getTime());
    const isDuringPause = (minuteStart) => pauseWindows.some((pause) => minuteStart >= pause.start && minuteStart < pause.end);
    const sortedIdleMinutes = minuteStats
        .filter((stat) => stat.idle)
        .sort((a, b) => a.minuteStart.getTime() - b.minuteStart.getTime());
    if (!sortedIdleMinutes.length) {
        return [];
    }
    const activities = [];
    let streakStart = null;
    let streakEnd = null;
    let streakMinutes = 0;
    const flushStreak = () => {
        if (!streakStart || !streakEnd || streakMinutes <= 0) {
            streakStart = null;
            streakEnd = null;
            streakMinutes = 0;
            return;
        }
        const minutesLabel = streakMinutes === 1 ? '1 minute' : `${streakMinutes} minutes`;
        const rangeLabel = `${formatDate(streakStart, 'h:mm a')} – ${formatDate(streakEnd, 'h:mm a')}`;
        activities.push({
            id: `idle-${streakStart.toISOString()}`,
            timestamp: streakEnd.toISOString(),
            message: `Idle from ${rangeLabel} (${minutesLabel}).`,
            category: 'idle'
        });
        streakStart = null;
        streakEnd = null;
        streakMinutes = 0;
    };
    for (const stat of sortedIdleMinutes) {
        if (isDuringPause(stat.minuteStart)) {
            flushStreak();
            continue;
        }
        const minuteEnd = new Date(stat.minuteStart.getTime() + MINUTE_MS);
        if (!streakStart || !streakEnd) {
            streakStart = stat.minuteStart;
            streakEnd = minuteEnd;
            streakMinutes = 1;
            continue;
        }
        if (stat.minuteStart.getTime() === streakEnd.getTime()) {
            streakEnd = minuteEnd;
            streakMinutes += 1;
            continue;
        }
        flushStreak();
        streakStart = stat.minuteStart;
        streakEnd = minuteEnd;
        streakMinutes = 1;
    }
    flushStreak();
    return activities;
};
const toTimesheetPeriod = async (userId, view, reference) => {
    const summary = await (0, timesheets_1.getUserTimesheet)(userId, view, reference);
    return {
        label: summary.label,
        range: `${summary.rangeStartLabel} – ${summary.rangeEndLabel}`,
        days: summary.days.map((day) => ({
            date: day.date,
            label: day.label,
            activeHours: roundHours(day.activeMinutes),
            idleHours: roundHours(day.idleMinutes),
            breaks: day.breaks,
            lunches: day.lunches,
            tardyMinutes: day.tardyMinutes,
            presenceMisses: day.presenceMisses
        })),
        totals: {
            activeHours: Math.round(summary.totals.activeHours * 100) / 100,
            idleHours: Math.round(summary.totals.idleHours * 100) / 100,
            breaks: summary.totals.breaks,
            lunches: summary.totals.lunches,
            tardyMinutes: summary.totals.tardyMinutes,
            presenceMisses: summary.totals.presenceMisses
        }
    };
};
const resolveSessionStatus = (session) => {
    if (!session) {
        return {
            status: 'clocked_out',
            startedAt: null,
            breakStartedAt: null,
            lunchStartedAt: null,
            lastPresenceCheck: null,
            nextPresenceCheck: null,
            lastClockedInAt: null,
            lastClockedOutAt: null
        };
    }
    const activePause = session.pauses.find((pause) => !pause.endedAt);
    const presenceEvent = session.events.find((event) => event.type.startsWith('presence_'));
    const baseStatus = (() => {
        if (session.endedAt) {
            return 'clocked_out';
        }
        if (activePause?.type === 'break') {
            return 'break';
        }
        if (activePause?.type === 'lunch') {
            return 'lunch';
        }
        return 'working';
    })();
    const lastPresenceCheck = presenceEvent ? presenceEvent.ts : null;
    const nextPresenceCheck = session.endedAt
        ? null
        : (0, date_fns_1.addMinutes)(lastPresenceCheck ?? session.startedAt, 45);
    return {
        status: baseStatus,
        startedAt: baseStatus === 'clocked_out' ? null : session.startedAt,
        breakStartedAt: baseStatus === 'break' ? activePause?.startedAt ?? null : null,
        lunchStartedAt: baseStatus === 'lunch' ? activePause?.startedAt ?? null : null,
        lastPresenceCheck,
        nextPresenceCheck,
        lastClockedInAt: session.startedAt,
        lastClockedOutAt: session.endedAt ?? null
    };
};
const mapRequestType = (type) => {
    if (type === 'make_up') {
        return 'make_up';
    }
    if (type === 'pto') {
        return 'pto';
    }
    if (type === 'uto' || type === 'non_pto') {
        return 'uto';
    }
    if (type === 'timesheet_edit') {
        return 'edit';
    }
    return 'pto';
};
const requestTypeLabel = (type) => {
    switch (type) {
        case 'make_up':
            return 'Make-up Hours';
        case 'pto':
            return 'PTO';
        case 'uto':
            return 'UTO';
        case 'edit':
            return 'Timesheet Edit';
        default:
            return 'Unknown Request';
    }
};
const toRequestItem = (request) => ({
    id: request.id,
    type: mapRequestType(request.type),
    status: request.status,
    startDate: request.startDate.toISOString(),
    endDate: request.endDate.toISOString(),
    hours: Math.round(request.hours * 100) / 100,
    reason: request.reason ?? 'No reason provided.',
    submittedAt: request.createdAt.toISOString()
});
const eventToActivity = (event) => {
    let category = 'session';
    let message = `Event: ${event.type.replace(/_/g, ' ')}`;
    if (event.type === 'presence_miss') {
        category = 'presence';
        message = 'Missed presence check while on shift.';
    }
    else if (event.type === 'presence_confirmed') {
        category = 'presence';
        message = 'Presence confirmed from desktop client.';
    }
    else if (event.type === 'break_started') {
        category = 'break';
        message = 'Break started.';
    }
    else if (event.type === 'lunch_started') {
        category = 'lunch';
        message = 'Lunch started.';
    }
    return {
        id: event.id,
        timestamp: event.ts.toISOString(),
        message,
        category
    };
};
const requestToActivity = (request) => {
    const typeLabel = requestTypeLabel(mapRequestType(request.type));
    return {
        id: `request-${request.id}`,
        timestamp: request.updatedAt.toISOString(),
        message: `${typeLabel} request ${request.status}`,
        category: 'request'
    };
};
exports.getAppOverview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email } = (0, validation_1.parseWithSchema)(overviewQuerySchema, req.query, 'Invalid query parameters');
    const user = await prisma_1.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } }
    });
    if (!user) {
        throw errors_1.HttpError.notFound('User not found');
    }
    const sessionInclude = {
        pauses: { orderBy: { sequence: 'asc' } },
        events: { orderBy: { ts: 'desc' } }
    };
    const [activeSession] = await prisma_1.prisma.session.findMany({
        where: { userId: user.id, status: 'active' },
        orderBy: { startedAt: 'desc' },
        take: 1,
        include: sessionInclude
    });
    const fallbackSession = activeSession
        ? null
        : await prisma_1.prisma.session.findFirst({
            where: { userId: user.id },
            orderBy: { startedAt: 'desc' },
            include: sessionInclude
        });
    const latestSession = activeSession ?? fallbackSession ?? null;
    const balance = await prisma_1.prisma.ptoBalance.findUnique({ where: { userId: user.id } });
    const previousCompleted = await prisma_1.prisma.session.findFirst({
        where: { userId: user.id, endedAt: { not: null } },
        orderBy: { endedAt: 'desc' }
    });
    const sessionStatus = resolveSessionStatus(latestSession);
    const lastClockedOutAt = previousCompleted?.endedAt ?? null;
    const activeSessionId = activeSession?.id ?? null;
    const now = new Date();
    const todayStart = (0, timesheets_1.timesheetDayStart)(now);
    const todayEnd = (0, timesheets_1.timesheetDayEnd)(now);
    const minuteStats = await prisma_1.prisma.minuteStat.findMany({
        where: {
            session: { userId: user.id },
            minuteStart: { gte: todayStart, lt: todayEnd }
        },
        select: { minuteStart: true, active: true, idle: true }
    });
    const pauses = await prisma_1.prisma.sessionPause.findMany({
        where: {
            session: { userId: user.id },
            startedAt: { gte: todayStart, lt: todayEnd }
        },
        select: { type: true, durationMinutes: true, startedAt: true, endedAt: true }
    });
    const presenceMisses = await prisma_1.prisma.event.count({
        where: {
            session: { userId: user.id },
            type: 'presence_miss',
            ts: { gte: todayStart, lt: todayEnd }
        }
    });
    const breakMinutes = pauses
        .filter((pause) => pause.type === 'break')
        .reduce((total, pause) => {
        if (typeof pause.durationMinutes === 'number') {
            return total + pause.durationMinutes;
        }
        const end = pause.endedAt ?? now;
        return total + Math.max(0, (0, date_fns_1.differenceInMinutes)(end, pause.startedAt));
    }, 0);
    const lunchMinutes = pauses
        .filter((pause) => pause.type === 'lunch')
        .reduce((total, pause) => {
        if (typeof pause.durationMinutes === 'number') {
            return total + pause.durationMinutes;
        }
        const end = pause.endedAt ?? now;
        return total + Math.max(0, (0, date_fns_1.differenceInMinutes)(end, pause.startedAt));
    }, 0);
    const todaySnapshot = {
        date: isoDate(now),
        label: dayLabel(now),
        activeMinutes: minuteStats.filter((stat) => stat.active).length,
        idleMinutes: minuteStats.filter((stat) => stat.idle).length,
        breakMinutes,
        lunchMinutes,
        breaksCount: pauses.filter((pause) => pause.type === 'break').length,
        lunchCount: pauses.filter((pause) => pause.type === 'lunch').length,
        presenceMisses,
        tardyMinutes: 0
    };
    const [weekly, payPeriod, monthly] = await Promise.all([
        toTimesheetPeriod(user.id, 'weekly', now),
        toTimesheetPeriod(user.id, 'pay_period', now),
        toTimesheetPeriod(user.id, 'monthly', now)
    ]);
    const todayEntry = weekly.days.find((day) => day.date === todaySnapshot.date);
    if (todayEntry) {
        todaySnapshot.tardyMinutes = todayEntry.tardyMinutes;
    }
    const requests = await prisma_1.prisma.timeRequest.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10
    });
    const requestItems = requests.map(toRequestItem);
    const [events, cap, usedHours, schedule] = await Promise.all([
        prisma_1.prisma.event.findMany({
            where: { session: { userId: user.id } },
            orderBy: { ts: 'desc' },
            take: 10
        }),
        (0, timeRequestPolicy_1.getMakeupCapHoursPerMonth)(),
        (0, timeRequestPolicy_1.getApprovedMakeupHoursThisMonth)(prisma_1.prisma, user.id),
        (0, schedule_1.getUserSchedule)({ userId: user.id, sessionStatus, reference: now })
    ]);
    const idleActivities = buildIdleActivities(minuteStats, pauses, now);
    const activity = [
        ...events.filter((event) => event.type !== 'heartbeat').map(eventToActivity),
        ...requests.map(requestToActivity),
        ...idleActivities
    ]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 12);
    res.json({
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            location: user.role === 'manager' ? 'Market Street HQ' : 'San Francisco Retail Floor'
        },
        session: {
            ...sessionStatus,
            id: activeSessionId,
            lastClockedOutAt
        },
        today: todaySnapshot,
        timesheet: {
            view: 'weekly',
            periods: {
                weekly,
                pay_period: payPeriod,
                monthly
            }
        },
        requests: requestItems,
        schedule,
        activity,
        makeUpCap: {
            used: Math.round(usedHours * 100) / 100,
            cap
        },
        balances: {
            pto: roundToQuarterHour(balance?.ptoHours ?? 0),
            uto: roundToQuarterHour(balance?.utoHours ?? 0),
            makeUp: roundToQuarterHour(balance?.makeUpHours ?? 0)
        },
        meta: {
            generatedAt: new Date().toISOString(),
            referenceDate: longDate(now)
        }
    });
});
exports.appDataRouter = (0, express_1.Router)();
exports.appDataRouter.get('/overview', exports.getAppOverview);

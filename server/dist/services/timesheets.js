"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserTimesheet = exports.TIMESHEET_TIME_ZONE = exports.computeTimesheetRange = exports.timesheetDayEnd = exports.timesheetDayStart = void 0;
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const prisma_1 = require("../prisma");
const ISO_DATE = 'yyyy-MM-dd';
const ISO_LONG = "yyyy-MM-dd'T'HH:mm:ssXXX";
const DATE_LABEL = 'MMM d, yyyy';
const DEFAULT_TIME_ZONE = process.env.TIMESHEET_TIME_ZONE ?? process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';
const WEEK_START = (() => {
    const raw = process.env.TIMESHEET_WEEK_START;
    if (!raw)
        return 1;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed))
        return 1;
    return Math.min(Math.max(parsed, 0), 6);
})();
const toZoned = (date) => (0, date_fns_tz_1.utcToZonedTime)(date, DEFAULT_TIME_ZONE);
const timesheetDayStart = (date) => (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfDay)(toZoned(date)), DEFAULT_TIME_ZONE);
exports.timesheetDayStart = timesheetDayStart;
const timesheetDayEnd = (date) => (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfDay)(toZoned(date)), DEFAULT_TIME_ZONE);
exports.timesheetDayEnd = timesheetDayEnd;
const formatDate = (date, pattern) => (0, date_fns_tz_1.formatInTimeZone)(date, DEFAULT_TIME_ZONE, pattern);
const minutesToHours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const resolveWeeklyRange = (reference) => {
    const zonedRef = toZoned(reference);
    const weekAnchor = (0, date_fns_1.startOfWeek)(zonedRef, { weekStartsOn: WEEK_START });
    const rangeStart = (0, exports.timesheetDayStart)(weekAnchor);
    const rangeEnd = (0, exports.timesheetDayEnd)((0, date_fns_1.addDays)(rangeStart, 6));
    const label = `${formatDate(rangeStart, DATE_LABEL)} – ${formatDate(rangeEnd, DATE_LABEL)}`;
    return { start: rangeStart, end: rangeEnd, label };
};
const resolveMonthlyRange = (reference) => {
    const zonedRef = toZoned(reference);
    const start = (0, exports.timesheetDayStart)((0, date_fns_1.startOfMonth)(zonedRef));
    const end = (0, exports.timesheetDayEnd)((0, date_fns_1.endOfMonth)(zonedRef));
    const label = formatDate(start, 'LLLL yyyy');
    return { start, end, label };
};
const resolvePayPeriodRange = (reference) => {
    const zonedRef = toZoned(reference);
    const dayOfMonth = zonedRef.getDate();
    const monthStart = (0, date_fns_1.startOfMonth)(zonedRef);
    if (dayOfMonth <= 15) {
        const start = (0, exports.timesheetDayStart)(monthStart);
        const end = (0, exports.timesheetDayEnd)((0, date_fns_1.setDate)(monthStart, 15));
        const label = `${formatDate(start, DATE_LABEL)} – ${formatDate(end, DATE_LABEL)}`;
        return { start, end, label };
    }
    const secondHalfStart = (0, date_fns_1.setDate)(monthStart, 16);
    const monthEnd = (0, date_fns_1.endOfMonth)(monthStart);
    const start = (0, exports.timesheetDayStart)(secondHalfStart);
    const end = (0, exports.timesheetDayEnd)(monthEnd);
    const label = `${formatDate(start, DATE_LABEL)} – ${formatDate(end, DATE_LABEL)}`;
    return { start, end, label };
};
const resolveRange = (view, reference) => {
    switch (view) {
        case 'weekly':
            return resolveWeeklyRange(reference);
        case 'monthly':
            return resolveMonthlyRange(reference);
        case 'pay_period':
        default:
            return resolvePayPeriodRange(reference);
    }
};
const computeTimesheetRange = (view, reference) => resolveRange(view, reference);
exports.computeTimesheetRange = computeTimesheetRange;
exports.TIMESHEET_TIME_ZONE = DEFAULT_TIME_ZONE;
const buildEmptyDay = (date) => ({
    date: formatDate(date, ISO_DATE),
    label: formatDate(date, DATE_LABEL),
    activeMinutes: 0,
    idleMinutes: 0,
    breaks: 0,
    lunches: 0,
    presenceMisses: 0,
    editRequests: []
});
const getUserTimesheet = async (userId, view, reference) => {
    const { start, end, label } = resolveRange(view, reference);
    const dayMap = new Map();
    const startZoned = toZoned(start);
    const endZoned = toZoned(end);
    let cursor = startZoned;
    while (cursor <= endZoned) {
        const key = formatDate(cursor, ISO_DATE);
        dayMap.set(key, buildEmptyDay(cursor));
        cursor = (0, date_fns_1.addDays)(cursor, 1);
    }
    const sessions = await prisma_1.prisma.session.findMany({
        where: {
            userId,
            startedAt: { lte: end },
            OR: [{ endedAt: null }, { endedAt: { gte: start } }]
        },
        include: {
            minuteStats: {
                select: { minuteStart: true, active: true, idle: true }
            },
            events: {
                select: { ts: true, type: true }
            }
        }
    });
    const ensureDay = (date) => {
        const key = formatDate(date, ISO_DATE);
        const existing = dayMap.get(key);
        if (existing) {
            return existing;
        }
        const seeded = buildEmptyDay(date);
        dayMap.set(key, seeded);
        return seeded;
    };
    for (const session of sessions) {
        for (const stat of session.minuteStats) {
            if (stat.minuteStart < start || stat.minuteStart > end) {
                continue;
            }
            const zoned = toZoned(stat.minuteStart);
            const bucket = ensureDay(zoned);
            if (stat.active) {
                bucket.activeMinutes += 1;
            }
            if (stat.idle) {
                bucket.idleMinutes += 1;
            }
        }
        for (const event of session.events) {
            if (!event.ts || event.ts < start || event.ts > end) {
                continue;
            }
            const zoned = toZoned(event.ts);
            const bucket = ensureDay(zoned);
            switch (event.type) {
                case 'break_start':
                    bucket.breaks += 1;
                    break;
                case 'lunch_start':
                    bucket.lunches += 1;
                    break;
                case 'presence_miss':
                    bucket.presenceMisses += 1;
                    break;
                default:
                    break;
            }
        }
    }
    const editRequests = await prisma_1.prisma.timesheetEditRequest.findMany({
        where: {
            userId,
            view,
            periodStart: start,
            periodEnd: end
        },
        orderBy: { createdAt: 'desc' }
    });
    const requestSummaries = editRequests.map((request) => ({
        id: request.id,
        status: request.status,
        targetDate: request.targetDate.toISOString(),
        createdAt: request.createdAt.toISOString(),
        updatedAt: request.updatedAt.toISOString(),
        reason: request.reason,
        requestedMinutes: request.requestedMinutes ?? null,
        adminNote: request.adminNote ?? null,
        reviewedAt: request.reviewedAt ? request.reviewedAt.toISOString() : null
    }));
    for (const request of editRequests) {
        const zonedDate = toZoned(request.targetDate);
        const bucket = ensureDay(zonedDate);
        bucket.editRequests.push({
            id: request.id,
            status: request.status,
            targetDate: request.targetDate.toISOString(),
            createdAt: request.createdAt.toISOString(),
            updatedAt: request.updatedAt.toISOString(),
            reason: request.reason,
            requestedMinutes: request.requestedMinutes ?? null,
            adminNote: request.adminNote ?? null,
            reviewedAt: request.reviewedAt ? request.reviewedAt.toISOString() : null
        });
    }
    const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const totals = days.reduce((acc, day) => ({
        activeMinutes: acc.activeMinutes + day.activeMinutes,
        activeHours: 0,
        idleMinutes: acc.idleMinutes + day.idleMinutes,
        idleHours: 0,
        breaks: acc.breaks + day.breaks,
        lunches: acc.lunches + day.lunches,
        presenceMisses: acc.presenceMisses + day.presenceMisses
    }), { activeMinutes: 0, activeHours: 0, idleMinutes: 0, idleHours: 0, breaks: 0, lunches: 0, presenceMisses: 0 });
    totals.activeHours = minutesToHours(totals.activeMinutes);
    totals.idleHours = minutesToHours(totals.idleMinutes);
    return {
        view,
        label,
        rangeStart: start.toISOString(),
        rangeEnd: end.toISOString(),
        rangeStartLabel: formatDate(start, DATE_LABEL),
        rangeEndLabel: formatDate(end, DATE_LABEL),
        totals,
        days,
        editRequests: requestSummaries
    };
};
exports.getUserTimesheet = getUserTimesheet;

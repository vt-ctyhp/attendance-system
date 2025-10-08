"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAttendanceMonthLocked = exports.listAttendanceFactsForMonth = exports.recalcMonthlyAttendanceFacts = exports.getPayrollDayBounds = exports.getMonthKeyForDate = void 0;
const library_1 = require("@prisma/client/runtime/library");
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const prisma_1 = require("../../prisma");
const constants_1 = require("./constants");
const config_1 = require("./config");
const parseMonthKey = (monthKey) => {
    const [year, month] = monthKey.split('-').map((value) => Number.parseInt(value, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
        throw new Error(`Invalid month key: ${monthKey}`);
    }
    const startZoned = (0, date_fns_tz_1.utcToZonedTime)(new Date(Date.UTC(year, month - 1, 1)), constants_1.PAYROLL_TIME_ZONE);
    const rangeStart = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfDay)(startZoned), constants_1.PAYROLL_TIME_ZONE);
    const rangeEnd = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfDay)((0, date_fns_1.endOfMonth)(startZoned)), constants_1.PAYROLL_TIME_ZONE);
    return { rangeStart, rangeEnd };
};
const getMonthKeyForDate = (date) => (0, date_fns_tz_1.formatInTimeZone)(date, constants_1.PAYROLL_TIME_ZONE, constants_1.MONTH_KEY_FORMAT);
exports.getMonthKeyForDate = getMonthKeyForDate;
const getPayrollDayBounds = (date) => {
    const zoned = (0, date_fns_tz_1.utcToZonedTime)(date, constants_1.PAYROLL_TIME_ZONE);
    const dayStart = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfDay)(zoned), constants_1.PAYROLL_TIME_ZONE);
    const dayEnd = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfDay)(zoned), constants_1.PAYROLL_TIME_ZONE);
    return { start: dayStart, end: dayEnd };
};
exports.getPayrollDayBounds = getPayrollDayBounds;
const buildDayKey = (date) => (0, date_fns_tz_1.formatInTimeZone)(date, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT);
const toHours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const sumDayHours = (requests, start, end) => {
    const pto = new Map();
    const uto = new Map();
    const makeUp = new Map();
    const requestSummaries = [];
    for (const request of requests) {
        const overlapStart = request.startDate > start ? request.startDate : start;
        const overlapEnd = request.endDate < end ? request.endDate : end;
        if (overlapEnd < overlapStart)
            continue;
        const days = (0, date_fns_1.eachDayOfInterval)({ start: overlapStart, end: overlapEnd });
        const perDay = request.hours / Math.max(days.length, 1);
        const targetMap = request.type === 'pto' ? pto : request.type === 'uto' ? uto : makeUp;
        for (const day of days) {
            const key = buildDayKey(day);
            const existing = targetMap.get(key) ?? 0;
            targetMap.set(key, Math.round((existing + perDay) * 100) / 100);
        }
        if (request.type === 'make_up') {
            requestSummaries.push({
                id: request.id,
                start: (0, date_fns_tz_1.formatInTimeZone)(overlapStart, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
                end: (0, date_fns_tz_1.formatInTimeZone)(overlapEnd, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
                hours: request.hours
            });
        }
    }
    return { pto, uto, makeUp, requestSummaries };
};
const buildScheduleLookup = (config, weekday) => {
    if (!config)
        return null;
    const normalized = (0, config_1.ensureSchedule)(config.schedule);
    const key = String(weekday);
    return normalized.days[key] ?? null;
};
const computeTardyMinutes = (scheduledStart, actualStart) => {
    const [hours, minutes] = scheduledStart.split(':').map((value) => Number.parseInt(value, 10));
    if (!Number.isFinite(hours) || !Number.isFinite(minutes))
        return 0;
    const zoned = (0, date_fns_tz_1.utcToZonedTime)(actualStart, constants_1.PAYROLL_TIME_ZONE);
    const scheduled = new Date(zoned);
    scheduled.setHours(hours, minutes, 0, 0);
    const tardy = (0, date_fns_1.differenceInCalendarDays)(zoned, scheduled) !== 0
        ? 0
        : Math.max(0, Math.round((zoned.getTime() - scheduled.getTime()) / 60000));
    return tardy;
};
const collectFirstStarts = async (userIds, start, end) => {
    if (!userIds.length)
        return new Map();
    const sessions = await prisma_1.prisma.session.findMany({
        where: {
            userId: { in: userIds },
            startedAt: { lte: end },
            OR: [{ endedAt: null }, { endedAt: { gte: start } }]
        },
        select: { userId: true, startedAt: true }
    });
    const map = new Map();
    for (const session of sessions) {
        const key = buildDayKey(session.startedAt);
        let userMap = map.get(session.userId);
        if (!userMap) {
            userMap = new Map();
            map.set(session.userId, userMap);
        }
        const existing = userMap.get(key);
        if (!existing || session.startedAt < existing) {
            userMap.set(key, session.startedAt);
        }
    }
    return map;
};
const collectWorkedMinutes = async (userIds, start, end) => {
    if (!userIds.length)
        return new Map();
    const stats = await prisma_1.prisma.minuteStat.findMany({
        where: {
            minuteStart: { gte: start, lte: end },
            session: { userId: { in: userIds } }
        },
        select: { minuteStart: true, active: true, idle: true, session: { select: { userId: true } } }
    });
    const map = new Map();
    for (const stat of stats) {
        const worked = stat.active || stat.idle ? 1 : 0;
        if (!worked)
            continue;
        const key = `${stat.session.userId}:${buildDayKey(stat.minuteStart)}`;
        const existing = map.get(key) ?? 0;
        map.set(key, existing + worked);
    }
    return map;
};
const collectApprovedRequests = async (userIds, start, end) => {
    if (!userIds.length)
        return [];
    const requests = await prisma_1.prisma.timeRequest.findMany({
        where: {
            userId: { in: userIds },
            status: 'approved',
            startDate: { lte: end },
            endDate: { gte: start }
        }
    });
    return requests;
};
const collectHolidays = async (start, end) => {
    const holidays = await prisma_1.prisma.holiday.findMany({
        where: { observedOn: { gte: start, lte: end } }
    });
    const set = new Set();
    for (const holiday of holidays) {
        set.add(buildDayKey(holiday.observedOn));
    }
    return set;
};
const mapRequestsByUser = (requests) => {
    const map = new Map();
    for (const request of requests) {
        const bucket = map.get(request.userId);
        if (bucket) {
            bucket.push(request);
        }
        else {
            map.set(request.userId, [request]);
        }
    }
    return map;
};
const recalcMonthlyAttendanceFacts = async (monthKey, actorId, userIds) => {
    const { rangeStart, rangeEnd } = parseMonthKey(monthKey);
    const where = userIds && userIds.length
        ? { active: true, id: { in: userIds } }
        : { active: true };
    const users = await prisma_1.prisma.user.findMany({ where });
    if (!users.length) {
        return [];
    }
    const targetUserIds = users.map((user) => user.id);
    const [firstStarts, workedMinutesMap, requests, holidays] = await Promise.all([
        collectFirstStarts(targetUserIds, rangeStart, rangeEnd),
        collectWorkedMinutes(targetUserIds, rangeStart, rangeEnd),
        collectApprovedRequests(targetUserIds, rangeStart, rangeEnd),
        collectHolidays(rangeStart, rangeEnd)
    ]);
    const requestsByUser = mapRequestsByUser(requests);
    const results = [];
    for (const user of users) {
        const configs = await (0, config_1.getAllConfigsThrough)(user.id, rangeEnd);
        const days = (0, date_fns_1.eachDayOfInterval)({ start: rangeStart, end: rangeEnd });
        const dayDetails = [];
        let assignedHours = 0;
        let workedHours = 0;
        let ptoHours = 0;
        let tardyMinutes = 0;
        const userRequests = requestsByUser.get(user.id) ?? [];
        const { pto, uto, makeUp, requestSummaries } = sumDayHours(userRequests, rangeStart, rangeEnd);
        const absenceLedger = [];
        for (const day of days) {
            const dayKey = buildDayKey(day);
            const zoned = (0, date_fns_tz_1.utcToZonedTime)(day, constants_1.PAYROLL_TIME_ZONE);
            const weekday = zoned.getDay();
            const config = (0, config_1.resolveActiveConfigForRange)(configs, day);
            const schedule = buildScheduleLookup(config, weekday);
            const detail = {
                date: dayKey,
                expectedHours: 0,
                workedHours: 0,
                ptoHours: 0,
                utoHours: 0,
                makeUpHours: 0,
                tardyMinutes: 0,
                holiday: holidays.has(dayKey),
                notes: []
            };
            if (config && schedule && schedule.enabled && !detail.holiday) {
                detail.expectedHours = Math.round(schedule.expectedHours * 100) / 100;
                assignedHours += detail.expectedHours;
            }
            const workedKey = `${user.id}:${dayKey}`;
            const workedMinutes = workedMinutesMap.get(workedKey) ?? 0;
            if (workedMinutes > 0) {
                detail.workedHours = toHours(workedMinutes);
                workedHours += detail.workedHours;
            }
            const ptoDayHours = pto.get(dayKey) ?? 0;
            if (ptoDayHours > 0) {
                detail.ptoHours = Math.round(ptoDayHours * 100) / 100;
                ptoHours += detail.ptoHours;
                detail.notes.push('PTO');
            }
            const utoDayHours = uto.get(dayKey) ?? 0;
            if (utoDayHours > 0) {
                detail.utoHours = Math.round(utoDayHours * 100) / 100;
                detail.notes.push('UTO Request');
            }
            const makeUpDayHours = makeUp.get(dayKey) ?? 0;
            if (makeUpDayHours > 0) {
                detail.makeUpHours = Math.round(makeUpDayHours * 100) / 100;
                detail.notes.push('Make-up');
            }
            const start = firstStarts.get(user.id)?.get(dayKey);
            if (schedule && schedule.enabled && start) {
                const tardy = computeTardyMinutes(schedule.start, start);
                if (tardy > 0) {
                    detail.tardyMinutes = tardy;
                    tardyMinutes += tardy;
                }
            }
            if (detail.tardyMinutes > 0 && (detail.ptoHours > 0 || detail.holiday)) {
                tardyMinutes -= detail.tardyMinutes;
                detail.tardyMinutes = 0;
            }
            const deficit = Math.max(detail.expectedHours -
                (detail.workedHours + detail.ptoHours + detail.utoHours + detail.makeUpHours), 0);
            if (deficit > 0) {
                absenceLedger.push({ date: day, remaining: deficit });
                detail.notes.push('Absence');
            }
            dayDetails.push(detail);
        }
        let matchedMakeUpHours = 0;
        if (userRequests.length) {
            const makeUpRequests = userRequests.filter((request) => request.type === 'make_up');
            makeUpRequests.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
            for (const request of makeUpRequests) {
                let hoursRemaining = request.hours;
                const requestDay = request.startDate;
                for (const entry of absenceLedger) {
                    const diffDays = Math.abs((0, date_fns_1.differenceInCalendarDays)((0, date_fns_tz_1.utcToZonedTime)(entry.date, constants_1.PAYROLL_TIME_ZONE), (0, date_fns_tz_1.utcToZonedTime)(requestDay, constants_1.PAYROLL_TIME_ZONE)));
                    if (diffDays > 14)
                        continue;
                    if (entry.remaining <= 0)
                        continue;
                    if (hoursRemaining <= 0)
                        break;
                    const applied = Math.min(entry.remaining, hoursRemaining);
                    entry.remaining = Math.round((entry.remaining - applied) * 100) / 100;
                    hoursRemaining = Math.round((hoursRemaining - applied) * 100) / 100;
                    matchedMakeUpHours += applied;
                    if (matchedMakeUpHours >= constants_1.MAX_MAKEUP_HOURS_PER_MONTH) {
                        matchedMakeUpHours = constants_1.MAX_MAKEUP_HOURS_PER_MONTH;
                        break;
                    }
                }
                if (matchedMakeUpHours >= constants_1.MAX_MAKEUP_HOURS_PER_MONTH)
                    break;
            }
        }
        matchedMakeUpHours = Math.round(Math.min(matchedMakeUpHours, constants_1.MAX_MAKEUP_HOURS_PER_MONTH) * 100) / 100;
        const residualAbsence = Math.round(absenceLedger.reduce((acc, entry) => acc + Math.max(entry.remaining, 0), 0) * 100) / 100;
        const utoAbsenceHours = residualAbsence;
        const uncoveredAbsence = Math.max(assignedHours - (workedHours + ptoHours + matchedMakeUpHours), 0);
        const isPerfect = tardyMinutes <= constants_1.MAX_TARDY_MINUTES_FOR_BONUS && uncoveredAbsence < 0.01;
        const snapshot = {
            monthKey,
            rangeStart: (0, date_fns_tz_1.formatInTimeZone)(rangeStart, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
            rangeEnd: (0, date_fns_tz_1.formatInTimeZone)(rangeEnd, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
            days: dayDetails,
            holidayCount: dayDetails.filter((detail) => detail.holiday).length,
            makeUpRequests: requestSummaries
        };
        const reasons = dayDetails
            .filter((detail) => detail.notes.length > 0)
            .map((detail) => ({ date: detail.date, notes: detail.notes }));
        const fact = await prisma_1.prisma.attendanceMonthFact.upsert({
            where: { userId_monthKey: { userId: user.id, monthKey } },
            create: {
                userId: user.id,
                monthKey,
                rangeStart,
                rangeEnd,
                assignedHours: new library_1.Decimal(Math.round(assignedHours * 100) / 100),
                workedHours: new library_1.Decimal(Math.round(workedHours * 100) / 100),
                ptoHours: new library_1.Decimal(Math.round(ptoHours * 100) / 100),
                utoAbsenceHours: new library_1.Decimal(Math.round(utoAbsenceHours * 100) / 100),
                tardyMinutes,
                matchedMakeUpHours: new library_1.Decimal(matchedMakeUpHours),
                isPerfect,
                reasons,
                snapshot
            },
            update: {
                rangeStart,
                rangeEnd,
                assignedHours: new library_1.Decimal(Math.round(assignedHours * 100) / 100),
                workedHours: new library_1.Decimal(Math.round(workedHours * 100) / 100),
                ptoHours: new library_1.Decimal(Math.round(ptoHours * 100) / 100),
                utoAbsenceHours: new library_1.Decimal(Math.round(utoAbsenceHours * 100) / 100),
                tardyMinutes,
                matchedMakeUpHours: new library_1.Decimal(matchedMakeUpHours),
                isPerfect,
                reasons,
                snapshot,
                computedAt: new Date()
            }
        });
        results.push(fact);
        if (actorId) {
            await prisma_1.prisma.payrollAuditLog.create({
                data: {
                    actorId,
                    scope: 'attendance',
                    target: `${user.id}:${monthKey}`,
                    action: 'recalc',
                    details: {
                        assignedHours,
                        workedHours,
                        ptoHours,
                        matchedMakeUpHours,
                        tardyMinutes,
                        isPerfect
                    }
                }
            });
        }
    }
    return results;
};
exports.recalcMonthlyAttendanceFacts = recalcMonthlyAttendanceFacts;
const listAttendanceFactsForMonth = async (monthKey) => {
    const { rangeStart, rangeEnd } = parseMonthKey(monthKey);
    const facts = await prisma_1.prisma.attendanceMonthFact.findMany({
        where: { monthKey },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { userId: 'asc' }
    });
    return { rangeStart, rangeEnd, facts };
};
exports.listAttendanceFactsForMonth = listAttendanceFactsForMonth;
const isAttendanceMonthLocked = async (monthKey) => {
    const periodKeys = [`${monthKey}-A`, `${monthKey}-B`];
    const periods = await prisma_1.prisma.payrollPeriod.findMany({
        where: { periodKey: { in: periodKeys } },
        select: { periodKey: true, status: true }
    });
    return periods.some((period) => period.status === 'paid');
};
exports.isAttendanceMonthLocked = isAttendanceMonthLocked;

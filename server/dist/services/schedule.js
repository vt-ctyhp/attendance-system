"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__private__ = exports.getUserSchedule = void 0;
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const prisma_1 = require("../prisma");
const config_1 = require("./payroll/config");
const shiftPlanner_1 = require("./shiftPlanner");
const timesheets_1 = require("./timesheets");
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_LOOKAHEAD_DAYS = 14;
const DEFAULT_UPCOMING_LIMIT = 6;
const formatDate = (date, pattern) => (0, date_fns_tz_1.formatInTimeZone)(date, timesheets_1.TIMESHEET_TIME_ZONE, pattern);
const isoDate = (date) => formatDate(date, 'yyyy-MM-dd');
const dayLabel = (date) => formatDate(date, 'EEE, MMM d');
const formatTime = (date) => formatDate(date, 'HH:mm');
const buildScheduleDefaults = (schedule) => {
    const groups = [];
    let current = null;
    for (let i = 0; i < WEEKDAY_LABELS.length; i += 1) {
        const dayKey = String(i);
        const day = schedule.days[dayKey];
        const enabled = day?.enabled ?? false;
        if (!enabled) {
            if (current) {
                groups.push(current);
                current = null;
            }
            continue;
        }
        const start = day.start;
        const end = day.end;
        if (!current) {
            current = { startIndex: i, endIndex: i, start, end };
            continue;
        }
        const isConsecutive = current.endIndex === i - 1;
        const matchesHours = current.start === start && current.end === end;
        if (isConsecutive && matchesHours) {
            current.endIndex = i;
        }
        else {
            groups.push(current);
            current = { startIndex: i, endIndex: i, start, end };
        }
    }
    if (current) {
        groups.push(current);
    }
    return groups.map(({ startIndex, endIndex, start, end }) => {
        const label = startIndex === endIndex
            ? WEEKDAY_LABELS[startIndex]
            : `${WEEKDAY_LABELS[startIndex]} – ${WEEKDAY_LABELS[endIndex]}`;
        return { label, start, end };
    });
};
const KIND_LABELS = {
    shift: 'Shift',
    pto: 'PTO',
    uto: 'Unpaid Time Off',
    make_up: 'Make-up Hours'
};
const relativeLabel = (reference, target) => {
    const referenceIso = isoDate(reference);
    const targetIso = isoDate(target);
    if (referenceIso === targetIso) {
        return 'Today';
    }
    const tomorrowIso = isoDate((0, date_fns_1.addDays)(reference, 1));
    if (tomorrowIso === targetIso) {
        return 'Tomorrow';
    }
    return dayLabel(target);
};
const determineStatus = (entry, index, sessionStatus, reference) => {
    const nowMs = reference.getTime();
    const startMs = entry.startsAt.getTime();
    const endMs = entry.endsAt.getTime();
    if (entry.kind === 'shift') {
        if (isoDate(entry.startsAt) === isoDate(reference) && index === 0) {
            return sessionStatus.status === 'clocked_out' ? 'completed' : 'in_progress';
        }
        if (endMs <= nowMs) {
            return 'completed';
        }
        if (startMs <= nowMs && nowMs < endMs) {
            return sessionStatus.status === 'clocked_out' ? 'completed' : 'in_progress';
        }
        return 'upcoming';
    }
    if (endMs <= nowMs) {
        return 'completed';
    }
    if (startMs <= nowMs && nowMs < endMs) {
        return 'in_progress';
    }
    return 'upcoming';
};
const buildScheduleEntries = (entries, sessionStatus, reference, limit) => {
    return entries
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .slice(0, limit)
        .map((entry, index) => {
        const baseLabel = relativeLabel(reference, entry.startsAt);
        const typeLabel = KIND_LABELS[entry.kind];
        const label = entry.kind === 'shift' ? baseLabel : `${baseLabel} — ${typeLabel}`;
        return {
            id: entry.id,
            date: isoDate(entry.startsAt),
            label,
            start: formatTime(entry.startsAt),
            end: formatTime(entry.endsAt),
            status: determineStatus(entry, index, sessionStatus, reference),
            kind: entry.kind,
            displayLabel: entry.displayLabel ?? entry.label ?? typeLabel
        };
    });
};
const mapRequestKind = (type) => {
    switch (type) {
        case 'pto':
            return 'pto';
        case 'uto':
        case 'non_pto':
            return 'uto';
        case 'make_up':
        default:
            return 'make_up';
    }
};
const loadScheduleSources = async (userId, windowStart, windowEnd) => {
    const shiftDelegate = prisma_1.prisma.shiftAssignment;
    const [shifts, requests] = await Promise.all([
        shiftDelegate
            ? shiftDelegate.findMany({
                where: {
                    userId,
                    OR: [
                        { startsAt: { gte: windowStart, lt: windowEnd } },
                        { endsAt: { gt: windowStart, lte: windowEnd } },
                        {
                            startsAt: { lte: windowStart },
                            endsAt: { gte: windowStart }
                        }
                    ]
                },
                orderBy: { startsAt: 'asc' }
            })
            : Promise.resolve([]),
        prisma_1.prisma.timeRequest.findMany({
            where: {
                userId,
                status: 'approved',
                type: { in: ['pto', 'uto', 'non_pto', 'make_up'] },
                NOT: {
                    OR: [
                        { endDate: { lt: windowStart } },
                        { startDate: { gt: windowEnd } }
                    ]
                }
            },
            orderBy: { startDate: 'asc' }
        })
    ]);
    const shiftEntries = shifts.map((shift) => ({
        id: `shift-${shift.id}`,
        kind: 'shift',
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        label: shift.label ?? null,
        displayLabel: shift.label ?? null
    }));
    const requestEntries = requests.map((request) => {
        const kind = mapRequestKind(request.type);
        return {
            id: `request-${request.id}`,
            kind,
            startsAt: request.startDate,
            endsAt: request.endDate,
            label: request.reason ?? null,
            displayLabel: KIND_LABELS[kind]
        };
    });
    return [...shiftEntries, ...requestEntries];
};
const getUserSchedule = async ({ userId, sessionStatus, reference = new Date(), limit = DEFAULT_UPCOMING_LIMIT, lookaheadDays = DEFAULT_LOOKAHEAD_DAYS }) => {
    const windowStart = (0, timesheets_1.timesheetDayStart)(reference);
    const windowEnd = (0, timesheets_1.timesheetDayEnd)((0, date_fns_1.addDays)(reference, lookaheadDays));
    await (0, shiftPlanner_1.ensureUpcomingShiftsForUser)({ userId, windowStart, windowEnd });
    const entries = await loadScheduleSources(userId, windowStart, windowEnd);
    const config = await prisma_1.prisma.employeeCompConfig.findFirst({
        where: { userId, effectiveOn: { lte: windowEnd } },
        orderBy: { effectiveOn: 'desc' }
    });
    const schedule = (0, config_1.ensureSchedule)(config?.schedule);
    return {
        defaults: buildScheduleDefaults(schedule),
        upcoming: buildScheduleEntries(entries, sessionStatus, reference, limit)
    };
};
exports.getUserSchedule = getUserSchedule;
exports.__private__ = {
    buildScheduleEntries,
    loadScheduleSources,
    relativeLabel,
    determineStatus
};

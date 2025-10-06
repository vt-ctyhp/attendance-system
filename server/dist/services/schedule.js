"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__private__ = exports.getUserSchedule = void 0;
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const prisma_1 = require("../prisma");
const timesheets_1 = require("./timesheets");
const DEFAULT_SCHEDULE_TEMPLATES = [
    { label: 'Mon – Fri', start: '09:00', end: '17:30' },
    { label: 'Sat', start: '10:00', end: '16:00' }
];
const DEFAULT_LOOKAHEAD_DAYS = 14;
const DEFAULT_UPCOMING_LIMIT = 6;
const formatDate = (date, pattern) => (0, date_fns_tz_1.formatInTimeZone)(date, timesheets_1.TIMESHEET_TIME_ZONE, pattern);
const isoDate = (date) => formatDate(date, 'yyyy-MM-dd');
const dayLabel = (date) => formatDate(date, 'EEE, MMM d');
const formatTime = (date) => formatDate(date, 'HH:mm');
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
        case 'non_pto':
            return 'uto';
        case 'make_up':
        default:
            return 'make_up';
    }
};
const loadScheduleSources = async (userId, windowStart, windowEnd) => {
    const [shifts, requests] = await Promise.all([
        prisma_1.prisma.shiftAssignment.findMany({
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
        }),
        prisma_1.prisma.timeRequest.findMany({
            where: {
                userId,
                status: 'approved',
                type: { in: ['pto', 'non_pto', 'make_up'] },
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
    const entries = await loadScheduleSources(userId, windowStart, windowEnd);
    return {
        defaults: DEFAULT_SCHEDULE_TEMPLATES.slice(),
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

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureUpcomingShiftsForAllUsers = exports.ensureUpcomingShiftsForUser = void 0;
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const prisma_1 = require("../prisma");
const config_1 = require("./payroll/config");
const constants_1 = require("./payroll/constants");
const timesheets_1 = require("./timesheets");
const SHIFT_LABEL = 'Scheduled Shift';
const ensureUpcomingShiftsForUser = async ({ userId, windowStart, windowEnd }) => {
    const config = await prisma_1.prisma.employeeCompConfig.findFirst({
        where: { userId, effectiveOn: { lte: windowEnd } },
        orderBy: { effectiveOn: 'desc' }
    });
    if (!config) {
        return { created: 0, skipped: 0 };
    }
    const schedule = (0, config_1.ensureSchedule)(config.schedule);
    const timeZone = schedule.timeZone || constants_1.PAYROLL_TIME_ZONE;
    const days = schedule.days;
    const existingAssignments = await prisma_1.prisma.shiftAssignment.findMany({
        where: {
            userId,
            startsAt: { gte: windowStart },
            endsAt: { lte: (0, date_fns_1.addDays)(windowEnd, 1) }
        },
        select: { startsAt: true, endsAt: true }
    });
    const existingKeys = new Set(existingAssignments.map((assignment) => `${assignment.startsAt.toISOString()}-${assignment.endsAt.toISOString()}`));
    const now = new Date();
    const candidateDays = (0, date_fns_1.eachDayOfInterval)({ start: windowStart, end: windowEnd });
    let created = 0;
    let skipped = 0;
    for (const day of candidateDays) {
        const localDay = (0, date_fns_tz_1.utcToZonedTime)(day, timeZone);
        const dayKey = String(localDay.getDay());
        const template = days[dayKey];
        if (!template || !template.enabled) {
            skipped += 1;
            continue;
        }
        const dateLabel = (0, date_fns_tz_1.formatInTimeZone)(day, timeZone, 'yyyy-MM-dd');
        const startIso = `${dateLabel}T${template.start}:00`;
        let endIsoDate = dateLabel;
        let endIso = `${endIsoDate}T${template.end}:00`;
        let startsAtUtc = (0, date_fns_tz_1.zonedTimeToUtc)(startIso, timeZone);
        let endsAtUtc = (0, date_fns_tz_1.zonedTimeToUtc)(endIso, timeZone);
        if (endsAtUtc <= startsAtUtc) {
            const nextDay = (0, date_fns_tz_1.formatInTimeZone)((0, date_fns_1.addDays)(day, 1), timeZone, 'yyyy-MM-dd');
            endIsoDate = nextDay;
            endIso = `${endIsoDate}T${template.end}:00`;
            endsAtUtc = (0, date_fns_tz_1.zonedTimeToUtc)(endIso, timeZone);
        }
        if (endsAtUtc <= now) {
            skipped += 1;
            continue;
        }
        const key = `${startsAtUtc.toISOString()}-${endsAtUtc.toISOString()}`;
        if (existingKeys.has(key)) {
            skipped += 1;
            continue;
        }
        await prisma_1.prisma.shiftAssignment.create({
            data: {
                userId,
                startsAt: startsAtUtc,
                endsAt: endsAtUtc,
                label: SHIFT_LABEL
            }
        });
        existingKeys.add(key);
        created += 1;
    }
    return { created, skipped };
};
exports.ensureUpcomingShiftsForUser = ensureUpcomingShiftsForUser;
const ensureUpcomingShiftsForAllUsers = async (lookaheadDays = 14) => {
    const now = new Date();
    const windowStart = (0, timesheets_1.timesheetDayStart)(now);
    const windowEnd = (0, timesheets_1.timesheetDayEnd)((0, date_fns_1.addDays)(now, lookaheadDays));
    const employees = await prisma_1.prisma.user.findMany({
        where: { role: 'employee', active: true },
        select: { id: true }
    });
    let created = 0;
    let skipped = 0;
    for (const employee of employees) {
        const summary = await (0, exports.ensureUpcomingShiftsForUser)({
            userId: employee.id,
            windowStart,
            windowEnd
        });
        created += summary.created;
        skipped += summary.skipped;
    }
    return {
        usersProcessed: employees.length,
        created,
        skipped
    };
};
exports.ensureUpcomingShiftsForAllUsers = ensureUpcomingShiftsForAllUsers;

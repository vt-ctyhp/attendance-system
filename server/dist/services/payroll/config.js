"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveActiveConfigForRange = exports.getAllConfigsThrough = exports.deleteHoliday = exports.createHoliday = exports.listHolidays = exports.deleteEmployeeConfig = exports.deleteFutureConfigs = exports.upsertEmployeeConfig = exports.getEffectiveConfigForDate = exports.listEmployeeConfigs = exports.serializeSchedule = exports.ensureSchedule = void 0;
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const library_1 = require("@prisma/client/runtime/library");
const client_1 = require("@prisma/client");
const prisma_1 = require("../../prisma");
const errors_1 = require("../../errors");
const constants_1 = require("./constants");
const attendanceTrigger_1 = require("./attendanceTrigger");
const attendance_1 = require("./attendance");
const WEEKDAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'];
const DEFAULT_START = '09:00';
const DEFAULT_END = '17:00';
const DEFAULT_BREAK_MINUTES = 0;
const DEFAULT_EXPECTED_HOURS = 8;
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const clampMinutes = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.round(value));
    }
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) {
            return Math.max(0, Math.round(parsed));
        }
    }
    return DEFAULT_BREAK_MINUTES;
};
const sanitizeTime = (value) => {
    if (typeof value !== 'string') {
        return DEFAULT_START;
    }
    const trimmed = value.trim();
    if (/^\d{2}:\d{2}$/.test(trimmed)) {
        return trimmed;
    }
    return DEFAULT_START;
};
const computeExpectedHours = (start, end, breakMinutes, fallback) => {
    if (typeof fallback === 'number' && Number.isFinite(fallback)) {
        return Number(fallback);
    }
    const [startHours, startMinutes] = start.split(':').map((part) => Number.parseInt(part, 10));
    const [endHours, endMinutes] = end.split(':').map((part) => Number.parseInt(part, 10));
    if ([startHours, startMinutes, endHours, endMinutes].some((value) => !Number.isFinite(value))) {
        return DEFAULT_EXPECTED_HOURS;
    }
    const startTotal = startHours * 60 + startMinutes;
    const endTotal = endHours * 60 + endMinutes;
    const rawMinutes = endTotal - startTotal;
    if (rawMinutes <= 0) {
        return DEFAULT_EXPECTED_HOURS;
    }
    const netMinutes = Math.max(0, rawMinutes - breakMinutes);
    return Math.round((netMinutes / 60) * 100) / 100;
};
const DEFAULT_SCHEDULE = {
    version: 2,
    timeZone: constants_1.PAYROLL_TIME_ZONE,
    days: WEEKDAY_KEYS.reduce((acc, key) => {
        acc[key] = {
            enabled: false,
            start: DEFAULT_START,
            end: DEFAULT_END,
            breakMinutes: DEFAULT_BREAK_MINUTES,
            expectedHours: DEFAULT_EXPECTED_HOURS
        };
        return acc;
    }, {})
};
const normalizeDay = (value) => {
    const raw = isPlainObject(value) ? value : {};
    const enabled = Boolean(raw.enabled);
    const start = sanitizeTime(raw.start ?? DEFAULT_START);
    const end = sanitizeTime(raw.end ?? DEFAULT_END);
    const breakMinutes = clampMinutes(raw.breakMinutes ?? raw.unpaidBreakMinutes);
    const expectedHours = computeExpectedHours(start, end, breakMinutes, raw.expectedHours);
    return { enabled, start, end, breakMinutes, expectedHours };
};
const ensureSchedule = (schedule) => {
    if (!isPlainObject(schedule)) {
        return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } };
    }
    const source = schedule;
    const timeZoneCandidate = typeof source.timeZone === 'string' && source.timeZone.trim().length
        ? source.timeZone.trim()
        : constants_1.PAYROLL_TIME_ZONE;
    const daysSource = isPlainObject(source.days) ? source.days : source;
    const days = {};
    for (const key of WEEKDAY_KEYS) {
        days[key] = normalizeDay(daysSource[key]);
    }
    return {
        version: 2,
        timeZone: timeZoneCandidate,
        days
    };
};
exports.ensureSchedule = ensureSchedule;
const serializeSchedule = (schedule) => ({
    version: 2,
    timeZone: schedule.timeZone,
    days: schedule.days
});
exports.serializeSchedule = serializeSchedule;
const toSnapshot = (config) => ({
    id: config.id,
    userId: config.userId,
    effectiveOn: config.effectiveOn,
    baseSemiMonthlySalary: Number(config.baseSemiMonthlySalary),
    monthlyAttendanceBonus: Number(config.monthlyAttendanceBonus),
    quarterlyAttendanceBonus: Number(config.quarterlyAttendanceBonus),
    kpiEligible: config.kpiEligible,
    defaultKpiBonus: config.defaultKpiBonus !== null ? Number(config.defaultKpiBonus) : null,
    schedule: (0, exports.ensureSchedule)(config.schedule),
    accrualEnabled: config.accrualEnabled,
    accrualMethod: config.accrualMethod,
    ptoBalanceHours: Number(config.ptoBalanceHours),
    utoBalanceHours: Number(config.utoBalanceHours),
    submittedById: config.submittedById ?? null,
    submittedBy: config.submittedBy
        ? { id: config.submittedBy.id, name: config.submittedBy.name, email: config.submittedBy.email }
        : null,
    submittedAt: config.submittedAt,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
});
const listEmployeeConfigs = async (userId) => {
    const where = userId
        ? { userId }
        : undefined;
    const configs = await prisma_1.prisma.employeeCompConfig.findMany({
        where,
        orderBy: { effectiveOn: 'desc' },
        include: { submittedBy: { select: { id: true, name: true, email: true } } }
    });
    return configs.map((config) => toSnapshot(config));
};
exports.listEmployeeConfigs = listEmployeeConfigs;
const getEffectiveConfigForDate = async (userId, target) => {
    const config = await prisma_1.prisma.employeeCompConfig.findFirst({
        where: { userId, effectiveOn: { lte: target } },
        orderBy: { effectiveOn: 'desc' },
        include: { submittedBy: { select: { id: true, name: true, email: true } } }
    });
    if (!config)
        return null;
    return toSnapshot(config);
};
exports.getEffectiveConfigForDate = getEffectiveConfigForDate;
const upsertEmployeeConfig = async (input, actorId) => {
    const priorConfig = await prisma_1.prisma.employeeCompConfig.findFirst({
        where: { userId: input.userId, effectiveOn: { lte: input.effectiveOn } },
        orderBy: { effectiveOn: 'desc' }
    });
    const schedule = (0, exports.ensureSchedule)(input.schedule);
    const serializedSchedule = (0, exports.serializeSchedule)(schedule);
    let scheduleChanged = true;
    if (priorConfig) {
        try {
            scheduleChanged = JSON.stringify(priorConfig.schedule) !== JSON.stringify(serializedSchedule);
        }
        catch (error) {
            scheduleChanged = true;
        }
    }
    const data = {
        userId: input.userId,
        effectiveOn: input.effectiveOn,
        baseSemiMonthlySalary: new library_1.Decimal(input.baseSemiMonthlySalary),
        monthlyAttendanceBonus: new library_1.Decimal(input.monthlyAttendanceBonus),
        quarterlyAttendanceBonus: new library_1.Decimal(input.quarterlyAttendanceBonus),
        kpiEligible: input.kpiEligible,
        defaultKpiBonus: input.defaultKpiBonus !== undefined && input.defaultKpiBonus !== null
            ? new library_1.Decimal(input.defaultKpiBonus)
            : null,
        schedule: serializedSchedule,
        accrualEnabled: input.accrualEnabled,
        accrualMethod: input.accrualMethod ?? null,
        ptoBalanceHours: new library_1.Decimal(input.ptoBalanceHours),
        utoBalanceHours: new library_1.Decimal(input.utoBalanceHours),
        submittedById: actorId ?? null,
        submittedAt: new Date()
    };
    try {
        await prisma_1.prisma.employeeCompConfig.create({ data });
    }
    catch (error) {
        if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw errors_1.HttpError.conflict('Configuration already exists for this effective date.', {
                field: 'effectiveOn'
            });
        }
        throw error;
    }
    if (scheduleChanged) {
        const monthKeys = (0, attendanceTrigger_1.collectMonthKeysFromEffectiveDate)(input.effectiveOn);
        await (0, attendanceTrigger_1.triggerAttendanceRecalcForMonths)(monthKeys, {
            userIds: [input.userId],
            actorId
        });
    }
    if (actorId) {
        await prisma_1.prisma.payrollAuditLog.create({
            data: {
                actorId,
                scope: 'employee_config',
                target: `${input.userId}`,
                action: 'upsert',
                details: data
            }
        });
    }
};
exports.upsertEmployeeConfig = upsertEmployeeConfig;
const deleteFutureConfigs = async (userId, effectiveAfter) => {
    const deleted = await prisma_1.prisma.employeeCompConfig.deleteMany({
        where: {
            userId,
            effectiveOn: { gt: effectiveAfter }
        }
    });
    return deleted.count;
};
exports.deleteFutureConfigs = deleteFutureConfigs;
const deleteEmployeeConfig = async (configId, actorId) => {
    const existing = await prisma_1.prisma.employeeCompConfig.findUnique({
        where: { id: configId }
    });
    if (!existing) {
        throw errors_1.HttpError.notFound('Configuration not found');
    }
    await prisma_1.prisma.employeeCompConfig.delete({ where: { id: configId } });
    const monthKeys = (0, attendanceTrigger_1.collectMonthKeysFromEffectiveDate)(existing.effectiveOn);
    await (0, attendanceTrigger_1.triggerAttendanceRecalcForMonths)(monthKeys, {
        userIds: [existing.userId],
        actorId
    });
    if (actorId) {
        await prisma_1.prisma.payrollAuditLog.create({
            data: {
                actorId,
                scope: 'employee_config',
                target: `${existing.userId}`,
                action: 'delete',
                details: { id: configId }
            }
        });
    }
    return toSnapshot({ ...existing, submittedBy: null });
};
exports.deleteEmployeeConfig = deleteEmployeeConfig;
const listHolidays = async (from, to) => {
    const holidays = await prisma_1.prisma.holiday.findMany({
        where: {
            observedOn: {
                gte: (0, date_fns_tz_1.zonedTimeToUtc)(from, constants_1.PAYROLL_TIME_ZONE),
                lte: (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.addDays)(to, 1), constants_1.PAYROLL_TIME_ZONE)
            }
        },
        orderBy: { observedOn: 'asc' }
    });
    return holidays;
};
exports.listHolidays = listHolidays;
const createHoliday = async (name, observedOn, actorId) => {
    const holiday = await prisma_1.prisma.holiday.upsert({
        where: { observedOn },
        update: { name, updatedAt: new Date() },
        create: { name, observedOn, createdById: actorId }
    });
    if (actorId) {
        await prisma_1.prisma.payrollAuditLog.create({
            data: {
                actorId,
                scope: 'holiday',
                target: (0, date_fns_tz_1.formatInTimeZone)(observedOn, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
                action: 'upsert',
                details: { name }
            }
        });
    }
    const monthKey = (0, attendance_1.getMonthKeyForDate)(observedOn);
    await (0, attendanceTrigger_1.triggerAttendanceRecalcForMonths)([monthKey], { actorId });
    return holiday;
};
exports.createHoliday = createHoliday;
const deleteHoliday = async (observedOn, actorId) => {
    const zonedDate = (0, date_fns_tz_1.utcToZonedTime)(observedOn, constants_1.PAYROLL_TIME_ZONE);
    const dayStart = (0, date_fns_1.startOfDay)(zonedDate);
    const nextDayStart = (0, date_fns_1.addDays)(dayStart, 1);
    const startUtc = (0, date_fns_tz_1.zonedTimeToUtc)(dayStart, constants_1.PAYROLL_TIME_ZONE);
    const nextUtc = (0, date_fns_tz_1.zonedTimeToUtc)(nextDayStart, constants_1.PAYROLL_TIME_ZONE);
    const deleted = await prisma_1.prisma.holiday.deleteMany({
        where: {
            observedOn: {
                gte: startUtc,
                lt: nextUtc
            }
        }
    });
    if (deleted.count === 0) {
        throw errors_1.HttpError.notFound('Holiday not found');
    }
    if (actorId) {
        await prisma_1.prisma.payrollAuditLog.create({
            data: {
                actorId,
                scope: 'holiday',
                target: (0, date_fns_tz_1.formatInTimeZone)(observedOn, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
                action: 'delete',
                details: {}
            }
        });
    }
    const monthKey = (0, attendance_1.getMonthKeyForDate)(observedOn);
    await (0, attendanceTrigger_1.triggerAttendanceRecalcForMonths)([monthKey], { actorId });
    return true;
};
exports.deleteHoliday = deleteHoliday;
const getAllConfigsThrough = async (userId, through) => {
    const configs = await prisma_1.prisma.employeeCompConfig.findMany({
        where: { userId, effectiveOn: { lte: through } },
        orderBy: { effectiveOn: 'asc' },
        include: { submittedBy: { select: { id: true, name: true, email: true } } }
    });
    return configs.map((config) => toSnapshot(config));
};
exports.getAllConfigsThrough = getAllConfigsThrough;
const resolveActiveConfigForRange = (configs, date) => {
    if (!configs.length)
        return null;
    let candidate = null;
    for (const config of configs) {
        if ((0, date_fns_1.isAfter)(config.effectiveOn, date)) {
            break;
        }
        candidate = config;
    }
    return candidate;
};
exports.resolveActiveConfigForRange = resolveActiveConfigForRange;

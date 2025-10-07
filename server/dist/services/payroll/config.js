"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveActiveConfigForRange = exports.getAllConfigsThrough = exports.deleteHoliday = exports.createHoliday = exports.listHolidays = exports.deleteFutureConfigs = exports.upsertEmployeeConfig = exports.getEffectiveConfigForDate = exports.listEmployeeConfigs = exports.ensureSchedule = void 0;
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const library_1 = require("@prisma/client/runtime/library");
const prisma_1 = require("../../prisma");
const constants_1 = require("./constants");
const WEEKDAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'];
const ensureSchedule = (schedule) => {
    const result = {};
    for (const key of WEEKDAY_KEYS) {
        const raw = schedule[key];
        if (!raw) {
            result[key] = { enabled: false, start: '09:00', end: '17:00', expectedHours: 8 };
            continue;
        }
        result[key] = {
            enabled: Boolean(raw.enabled),
            start: raw.start ?? '09:00',
            end: raw.end ?? '17:00',
            expectedHours: Number.isFinite(raw.expectedHours) ? Number(raw.expectedHours) : 8
        };
    }
    return result;
};
exports.ensureSchedule = ensureSchedule;
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
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
});
const listEmployeeConfigs = async (userId) => {
    const where = userId
        ? { userId }
        : undefined;
    const configs = await prisma_1.prisma.employeeCompConfig.findMany({
        where,
        orderBy: { effectiveOn: 'desc' }
    });
    return configs.map((config) => toSnapshot(config));
};
exports.listEmployeeConfigs = listEmployeeConfigs;
const getEffectiveConfigForDate = async (userId, target) => {
    const config = await prisma_1.prisma.employeeCompConfig.findFirst({
        where: { userId, effectiveOn: { lte: target } },
        orderBy: { effectiveOn: 'desc' }
    });
    if (!config)
        return null;
    return toSnapshot(config);
};
exports.getEffectiveConfigForDate = getEffectiveConfigForDate;
const upsertEmployeeConfig = async (input, actorId) => {
    const schedule = (0, exports.ensureSchedule)(input.schedule);
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
        schedule,
        accrualEnabled: input.accrualEnabled,
        accrualMethod: input.accrualMethod ?? null,
        ptoBalanceHours: new library_1.Decimal(input.ptoBalanceHours),
        utoBalanceHours: new library_1.Decimal(input.utoBalanceHours)
    };
    await prisma_1.prisma.employeeCompConfig.upsert({
        where: { userId_effectiveOn: { userId: input.userId, effectiveOn: input.effectiveOn } },
        create: data,
        update: data
    });
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
    return holiday;
};
exports.createHoliday = createHoliday;
const deleteHoliday = async (observedOn, actorId) => {
    const deleted = await prisma_1.prisma.holiday.deleteMany({ where: { observedOn } });
    if (actorId && deleted.count > 0) {
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
    return deleted.count > 0;
};
exports.deleteHoliday = deleteHoliday;
const getAllConfigsThrough = async (userId, through) => {
    const configs = await prisma_1.prisma.employeeCompConfig.findMany({
        where: { userId, effectiveOn: { lte: through } },
        orderBy: { effectiveOn: 'asc' }
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

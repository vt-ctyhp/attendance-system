"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportPayrollCsv = exports.markPayrollPaid = exports.approvePayrollPeriod = exports.getPayrollPeriod = exports.recalcPayrollForPayDate = void 0;
const library_1 = require("@prisma/client/runtime/library");
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const prisma_1 = require("../../prisma");
const constants_1 = require("./constants");
const config_1 = require("./config");
const resolvePayPeriod = (payDate) => {
    const zoned = (0, date_fns_tz_1.utcToZonedTime)(payDate, constants_1.PAYROLL_TIME_ZONE);
    const endOfMonthDate = (0, date_fns_1.endOfMonth)(zoned);
    const isFifteenth = zoned.getDate() === 15;
    const isEndOfMonth = zoned.getDate() === endOfMonthDate.getDate();
    if (!isFifteenth && !isEndOfMonth) {
        throw new Error('Pay date must be either the 15th or the end of month');
    }
    if (isFifteenth) {
        const prevMonth = (0, date_fns_1.addMonths)(zoned, -1);
        const start = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfDay)((0, date_fns_1.setDate)(prevMonth, 16)), constants_1.PAYROLL_TIME_ZONE);
        const end = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfDay)((0, date_fns_1.endOfMonth)(prevMonth)), constants_1.PAYROLL_TIME_ZONE);
        const monthKey = (0, date_fns_1.format)(prevMonth, 'yyyy-MM');
        return { periodKey: `${monthKey}-B`, periodStart: start, periodEnd: end };
    }
    const start = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfDay)((0, date_fns_1.setDate)(zoned, 1)), constants_1.PAYROLL_TIME_ZONE);
    const end = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfDay)((0, date_fns_1.setDate)(zoned, 15)), constants_1.PAYROLL_TIME_ZONE);
    const monthKey = (0, date_fns_1.format)(zoned, 'yyyy-MM');
    return { periodKey: `${monthKey}-A`, periodStart: start, periodEnd: end };
};
const computeBaseForUser = (configs, periodStart, periodEnd) => {
    const days = (0, date_fns_1.eachDayOfInterval)({ start: periodStart, end: periodEnd });
    if (!days.length)
        return 0;
    const totalDays = days.length;
    const counts = new Map();
    for (const day of days) {
        const config = (0, config_1.resolveActiveConfigForRange)(configs, day);
        if (!config)
            continue;
        counts.set(config.id, (counts.get(config.id) ?? 0) + 1);
    }
    let total = 0;
    for (const [configId, count] of counts.entries()) {
        const config = configs.find((entry) => entry.id === configId);
        if (!config)
            continue;
        const ratio = count / totalDays;
        total += Number(config.baseSemiMonthlySalary) * ratio;
    }
    return Math.round(total * 100) / 100;
};
const sumCandidateAmount = (candidate) => {
    if (candidate.finalAmount) {
        return Number(candidate.finalAmount);
    }
    return Number(candidate.amount);
};
const isMonthlyDeferred = (candidate, payDate) => {
    const zonedPay = (0, date_fns_tz_1.utcToZonedTime)(payDate, constants_1.PAYROLL_TIME_ZONE);
    const prevMonth = (0, date_fns_1.addMonths)(zonedPay, -1);
    const expected = (0, date_fns_1.format)(prevMonth, 'yyyy-MM');
    return candidate.periodKey !== expected;
};
const categorizeBonuses = (candidates, payDate) => {
    const map = new Map();
    for (const candidate of candidates) {
        const amount = sumCandidateAmount(candidate);
        const bucket = map.get(candidate.userId) ?? {
            monthly: 0,
            monthlyDeferred: 0,
            quarterly: 0,
            kpi: 0
        };
        if (candidate.type === constants_1.BONUS_TYPE_MONTHLY) {
            if (isMonthlyDeferred(candidate, payDate)) {
                bucket.monthlyDeferred += amount;
            }
            else {
                bucket.monthly += amount;
            }
        }
        else if (candidate.type === constants_1.BONUS_TYPE_QUARTERLY) {
            bucket.quarterly += amount;
        }
        else if (candidate.type === constants_1.BONUS_TYPE_KPI) {
            bucket.kpi += amount;
        }
        map.set(candidate.userId, bucket);
    }
    return map;
};
const summarizeTotals = (lines) => {
    const totals = {
        base: 0,
        monthlyAttendance: 0,
        monthlyDeferred: 0,
        quarterlyAttendance: 0,
        kpiBonus: 0,
        finalAmount: 0
    };
    for (const line of lines) {
        totals.base += line.baseAmount;
        totals.monthlyAttendance += line.monthlyAttendance;
        totals.monthlyDeferred += line.monthlyDeferred;
        totals.quarterlyAttendance += line.quarterlyAttendance;
        totals.kpiBonus += line.kpiBonus;
        totals.finalAmount += line.finalAmount;
    }
    return {
        base: Math.round(totals.base * 100) / 100,
        monthlyAttendance: Math.round(totals.monthlyAttendance * 100) / 100,
        monthlyDeferred: Math.round(totals.monthlyDeferred * 100) / 100,
        quarterlyAttendance: Math.round(totals.quarterlyAttendance * 100) / 100,
        kpiBonus: Math.round(totals.kpiBonus * 100) / 100,
        finalAmount: Math.round(totals.finalAmount * 100) / 100
    };
};
const recalcPayrollForPayDate = async (payDate, actorId) => {
    const { periodKey, periodStart, periodEnd } = resolvePayPeriod(payDate);
    const existing = await prisma_1.prisma.payrollPeriod.findUnique({ where: { periodKey } });
    if (existing && existing.status === 'paid') {
        throw new Error('Cannot recalc a paid payroll period');
    }
    const users = await prisma_1.prisma.user.findMany({ where: { active: true } });
    const bonusCandidates = await prisma_1.prisma.bonusCandidate.findMany({
        where: {
            eligiblePayDate: payDate,
            OR: [
                { type: constants_1.BONUS_TYPE_MONTHLY, status: 'earned' },
                { type: constants_1.BONUS_TYPE_QUARTERLY, status: 'earned' },
                { type: constants_1.BONUS_TYPE_KPI, status: 'approved' }
            ]
        }
    });
    const bonusMap = categorizeBonuses(bonusCandidates, payDate);
    const linesData = [];
    for (const user of users) {
        const configs = await (0, config_1.getAllConfigsThrough)(user.id, periodEnd);
        if (!configs.length)
            continue;
        const baseAmount = computeBaseForUser(configs, periodStart, periodEnd);
        const bonuses = bonusMap.get(user.id) ?? {
            monthly: 0,
            monthlyDeferred: 0,
            quarterly: 0,
            kpi: 0
        };
        const monthly = Math.round(bonuses.monthly * 100) / 100;
        const monthlyDeferred = Math.round(bonuses.monthlyDeferred * 100) / 100;
        const quarterly = Math.round(bonuses.quarterly * 100) / 100;
        const kpi = Math.round(bonuses.kpi * 100) / 100;
        const finalAmount = Math.round((baseAmount + monthly + monthlyDeferred + quarterly + kpi) * 100) / 100;
        linesData.push({
            userId: user.id,
            baseAmount,
            monthlyAttendance: monthly,
            monthlyDeferred,
            quarterlyAttendance: quarterly,
            kpiBonus: kpi,
            finalAmount,
            snapshot: {
                baseConfigs: configs.map((config) => ({
                    configId: config.id,
                    effectiveOn: (0, date_fns_tz_1.formatInTimeZone)(config.effectiveOn, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
                    base: Number(config.baseSemiMonthlySalary)
                })),
                bonusSummary: {
                    monthly,
                    monthlyDeferred,
                    quarterly,
                    kpi
                }
            }
        });
    }
    const totals = summarizeTotals(linesData);
    const result = await prisma_1.prisma.$transaction(async (tx) => {
        const period = await tx.payrollPeriod.upsert({
            where: { periodKey },
            create: {
                periodKey,
                periodStart,
                periodEnd,
                payDate,
                status: existing?.status ?? 'draft',
                totals: totals,
                computedAt: new Date()
            },
            update: {
                periodStart,
                periodEnd,
                payDate,
                totals: totals,
                computedAt: new Date()
            }
        });
        await tx.payrollLine.deleteMany({ where: { payrollPeriodId: period.id } });
        if (linesData.length) {
            await tx.payrollLine.createMany({
                data: linesData.map((line) => ({
                    payrollPeriodId: period.id,
                    userId: line.userId,
                    baseAmount: new library_1.Decimal(line.baseAmount),
                    monthlyAttendance: new library_1.Decimal(line.monthlyAttendance),
                    monthlyDeferred: new library_1.Decimal(line.monthlyDeferred),
                    quarterlyAttendance: new library_1.Decimal(line.quarterlyAttendance),
                    kpiBonus: new library_1.Decimal(line.kpiBonus),
                    finalAmount: new library_1.Decimal(line.finalAmount),
                    snapshot: line.snapshot
                }))
            });
        }
        return period;
    });
    if (actorId) {
        await prisma_1.prisma.payrollAuditLog.create({
            data: {
                actorId,
                scope: 'payroll',
                target: periodKey,
                action: 'recalc',
                details: totals
            }
        });
    }
    return result;
};
exports.recalcPayrollForPayDate = recalcPayrollForPayDate;
const getPayrollPeriod = async (payDate) => {
    const { periodKey } = resolvePayPeriod(payDate);
    const period = await prisma_1.prisma.payrollPeriod.findUnique({
        where: { periodKey },
        include: {
            lines: {
                include: {
                    user: { select: { id: true, name: true, email: true } }
                },
                orderBy: { userId: 'asc' }
            }
        }
    });
    return period;
};
exports.getPayrollPeriod = getPayrollPeriod;
const approvePayrollPeriod = async (payDate, actorId) => {
    const { periodKey } = resolvePayPeriod(payDate);
    const period = await prisma_1.prisma.payrollPeriod.update({
        where: { periodKey },
        data: { status: 'approved', approvedAt: new Date(), approvedById: actorId }
    });
    await prisma_1.prisma.payrollAuditLog.create({
        data: {
            actorId,
            scope: 'payroll',
            target: periodKey,
            action: 'approve',
            details: {}
        }
    });
    return period;
};
exports.approvePayrollPeriod = approvePayrollPeriod;
const markPayrollPaid = async (payDate, actorId) => {
    const { periodKey } = resolvePayPeriod(payDate);
    const period = await prisma_1.prisma.payrollPeriod.update({
        where: { periodKey },
        data: { status: 'paid', paidAt: new Date(), paidById: actorId }
    });
    await prisma_1.prisma.payrollAuditLog.create({
        data: {
            actorId,
            scope: 'payroll',
            target: periodKey,
            action: 'pay',
            details: {}
        }
    });
    return period;
};
exports.markPayrollPaid = markPayrollPaid;
const exportPayrollCsv = async (payDate) => {
    const period = await (0, exports.getPayrollPeriod)(payDate);
    if (!period)
        return '';
    const headers = [
        'Employee',
        'Email',
        'Period Start',
        'Period End',
        'Base Amount',
        'Monthly Attendance',
        'Monthly Deferred',
        'Quarterly Attendance',
        'KPI Bonus',
        'Final Amount'
    ];
    const rows = [headers.join(',')];
    for (const line of period.lines) {
        const employee = line.user?.name ?? line.userId.toString();
        const email = line.user?.email ?? '';
        rows.push([
            employee,
            email,
            (0, date_fns_tz_1.formatInTimeZone)(period.periodStart, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
            (0, date_fns_tz_1.formatInTimeZone)(period.periodEnd, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT),
            Number(line.baseAmount).toFixed(2),
            Number(line.monthlyAttendance).toFixed(2),
            Number(line.monthlyDeferred).toFixed(2),
            Number(line.quarterlyAttendance).toFixed(2),
            Number(line.kpiBonus).toFixed(2),
            Number(line.finalAmount).toFixed(2)
        ].join(','));
    }
    return rows.join('\n');
};
exports.exportPayrollCsv = exportPayrollCsv;

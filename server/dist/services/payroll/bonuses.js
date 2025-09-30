"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateKpiBonusStatus = exports.listBonusesForPayDate = exports.recalcMonthlyBonuses = void 0;
const date_fns_1 = require("date-fns");
const library_1 = require("@prisma/client/runtime/library");
const date_fns_tz_1 = require("date-fns-tz");
const prisma_1 = require("../../prisma");
const constants_1 = require("./constants");
const config_1 = require("./config");
const buildMonthKeyDate = (monthKey) => {
    const [year, month] = monthKey.split('-').map((value) => Number.parseInt(value, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
        throw new Error(`Invalid month key: ${monthKey}`);
    }
    return new Date(Date.UTC(year, month - 1, 1));
};
const resolveMonthlyPayDate = (monthKey, computedAt) => {
    const baseDate = buildMonthKeyDate(monthKey);
    const nextMonth = (0, date_fns_1.addMonths)(baseDate, 1);
    const payZoned = (0, date_fns_tz_1.utcToZonedTime)(nextMonth, constants_1.PAYROLL_TIME_ZONE);
    payZoned.setDate(15);
    payZoned.setHours(0, 0, 0, 0);
    let payDate = (0, date_fns_tz_1.zonedTimeToUtc)(payZoned, constants_1.PAYROLL_TIME_ZONE);
    if (computedAt > payDate) {
        const deferred = (0, date_fns_1.addMonths)(payZoned, 1);
        deferred.setDate(15);
        payDate = (0, date_fns_tz_1.zonedTimeToUtc)(deferred, constants_1.PAYROLL_TIME_ZONE);
    }
    return payDate;
};
const resolveQuarterForMonth = (monthKey) => {
    const [year, month] = monthKey.split('-').map((value) => Number.parseInt(value, 10));
    const quarterIndex = Math.floor((month - 1) / 3) + 1;
    const quarterEndMonth = quarterIndex * 3;
    const quarterKey = `${year}-Q${quarterIndex}`;
    return { quarterIndex, quarterEndMonth, quarterKey, year, month };
};
const resolveQuarterPayDate = (year, quarterIndex) => {
    const payMonths = [4, 7, 10, 1];
    const payMonth = payMonths[quarterIndex - 1];
    const payYear = quarterIndex === 4 ? year + 1 : year;
    const zoned = (0, date_fns_tz_1.utcToZonedTime)(new Date(Date.UTC(payYear, payMonth - 1, 1)), constants_1.PAYROLL_TIME_ZONE);
    zoned.setDate(15);
    zoned.setHours(0, 0, 0, 0);
    return (0, date_fns_tz_1.zonedTimeToUtc)(zoned, constants_1.PAYROLL_TIME_ZONE);
};
const upsertBonus = async (data) => {
    const { actorId, ...payload } = data;
    const record = await prisma_1.prisma.bonusCandidate.upsert({
        where: {
            userId_type_periodKey: {
                userId: payload.userId,
                type: payload.type,
                periodKey: payload.periodKey
            }
        },
        create: {
            userId: payload.userId,
            type: payload.type,
            periodKey: payload.periodKey,
            eligiblePayDate: payload.eligiblePayDate,
            amount: new library_1.Decimal(payload.amount),
            status: payload.status,
            finalAmount: payload.finalAmount !== undefined && payload.finalAmount !== null
                ? new library_1.Decimal(payload.finalAmount)
                : null,
            snapshot: payload.snapshot,
            notes: payload.notes ?? null
        },
        update: {
            eligiblePayDate: payload.eligiblePayDate,
            amount: new library_1.Decimal(payload.amount),
            status: payload.status,
            finalAmount: payload.finalAmount !== undefined && payload.finalAmount !== null
                ? new library_1.Decimal(payload.finalAmount)
                : null,
            snapshot: payload.snapshot,
            notes: payload.notes ?? null,
            computedAt: new Date()
        }
    });
    if (actorId) {
        await prisma_1.prisma.payrollAuditLog.create({
            data: {
                actorId,
                scope: 'bonus',
                target: `${payload.userId}:${payload.type}:${payload.periodKey}`,
                action: 'upsert',
                details: {
                    amount: payload.amount,
                    status: payload.status,
                    eligiblePayDate: (0, date_fns_tz_1.formatInTimeZone)(payload.eligiblePayDate, constants_1.PAYROLL_TIME_ZONE, constants_1.DATE_KEY_FORMAT)
                }
            }
        });
    }
    return record;
};
const recalcMonthlyBonuses = async (monthKey, actorId) => {
    const computedAt = new Date();
    const payDate = resolveMonthlyPayDate(monthKey, computedAt);
    const facts = await prisma_1.prisma.attendanceMonthFact.findMany({
        where: { monthKey },
        include: { user: true }
    });
    const monthBonuses = [];
    for (const fact of facts) {
        const config = await (0, config_1.getEffectiveConfigForDate)(fact.userId, fact.rangeEnd);
        if (!config)
            continue;
        if (!fact.isPerfect) {
            await prisma_1.prisma.bonusCandidate.deleteMany({
                where: {
                    userId: fact.userId,
                    type: constants_1.BONUS_TYPE_MONTHLY,
                    periodKey: monthKey
                }
            });
            continue;
        }
        const amount = Number(config.monthlyAttendanceBonus);
        const snapshot = {
            monthKey,
            factId: fact.id,
            tardyMinutes: fact.tardyMinutes,
            matchedMakeUpHours: Number(fact.matchedMakeUpHours),
            assignedHours: Number(fact.assignedHours),
            workedHours: Number(fact.workedHours)
        };
        const record = await upsertBonus({
            userId: fact.userId,
            type: constants_1.BONUS_TYPE_MONTHLY,
            periodKey: monthKey,
            amount,
            eligiblePayDate: payDate,
            status: 'earned',
            finalAmount: amount,
            snapshot,
            actorId
        });
        monthBonuses.push(record);
    }
    const { quarterIndex, quarterEndMonth, quarterKey, year, month } = resolveQuarterForMonth(monthKey);
    if (month === quarterEndMonth) {
        const quarterMonths = [];
        for (let i = 0; i < 3; i += 1) {
            const targetMonth = quarterEndMonth - i;
            const paddedMonth = targetMonth.toString().padStart(2, '0');
            quarterMonths.unshift(`${year}-${paddedMonth}`);
        }
        const quarterFacts = await prisma_1.prisma.attendanceMonthFact.findMany({
            where: { monthKey: { in: quarterMonths } },
            include: { user: true }
        });
        const factsByUser = new Map();
        for (const fact of quarterFacts) {
            const list = factsByUser.get(fact.userId);
            if (list) {
                list.push(fact);
            }
            else {
                factsByUser.set(fact.userId, [fact]);
            }
        }
        const payDateQuarter = resolveQuarterPayDate(year, quarterIndex);
        for (const [userId, userFacts] of factsByUser.entries()) {
            if (userFacts.length !== 3) {
                await prisma_1.prisma.bonusCandidate.deleteMany({
                    where: { userId, type: constants_1.BONUS_TYPE_QUARTERLY, periodKey: quarterKey }
                });
                continue;
            }
            if (!userFacts.every((fact) => fact.isPerfect)) {
                await prisma_1.prisma.bonusCandidate.deleteMany({
                    where: { userId, type: constants_1.BONUS_TYPE_QUARTERLY, periodKey: quarterKey }
                });
                continue;
            }
            const config = await (0, config_1.getEffectiveConfigForDate)(userId, userFacts[2].rangeEnd);
            if (!config)
                continue;
            const amount = Number(config.quarterlyAttendanceBonus);
            const snapshot = {
                quarterKey,
                monthKeys: quarterMonths,
                factIds: userFacts.map((fact) => fact.id)
            };
            await upsertBonus({
                userId,
                type: constants_1.BONUS_TYPE_QUARTERLY,
                periodKey: quarterKey,
                amount,
                eligiblePayDate: payDateQuarter,
                status: 'earned',
                finalAmount: amount,
                snapshot,
                actorId
            });
        }
    }
    for (const fact of facts) {
        const config = await (0, config_1.getEffectiveConfigForDate)(fact.userId, fact.rangeEnd);
        if (!config || !config.kpiEligible) {
            await prisma_1.prisma.bonusCandidate.deleteMany({
                where: {
                    userId: fact.userId,
                    type: constants_1.BONUS_TYPE_KPI,
                    periodKey: monthKey
                }
            });
            continue;
        }
        const amount = config.defaultKpiBonus ? Number(config.defaultKpiBonus) : 0;
        const snapshot = { monthKey, factId: fact.id, defaultAmount: amount };
        const existing = await prisma_1.prisma.bonusCandidate.findUnique({
            where: {
                userId_type_periodKey: {
                    userId: fact.userId,
                    type: constants_1.BONUS_TYPE_KPI,
                    periodKey: monthKey
                }
            }
        });
        if (existing && existing.status !== 'pending') {
            continue;
        }
        await upsertBonus({
            userId: fact.userId,
            type: constants_1.BONUS_TYPE_KPI,
            periodKey: monthKey,
            amount,
            eligiblePayDate: payDate,
            status: existing?.status ?? 'pending',
            finalAmount: existing?.finalAmount ? Number(existing.finalAmount) : null,
            snapshot,
            actorId
        });
    }
    return monthBonuses;
};
exports.recalcMonthlyBonuses = recalcMonthlyBonuses;
const listBonusesForPayDate = async (payDate) => {
    const candidates = await prisma_1.prisma.bonusCandidate.findMany({
        where: { eligiblePayDate: payDate },
        include: { user: { select: { id: true, name: true, email: true } } }
    });
    return candidates;
};
exports.listBonusesForPayDate = listBonusesForPayDate;
const updateKpiBonusStatus = async (id, status, actorId, finalAmount, notes) => {
    const candidate = await prisma_1.prisma.bonusCandidate.update({
        where: { id },
        data: {
            status,
            finalAmount: finalAmount !== undefined ? new library_1.Decimal(finalAmount) : undefined,
            notes: notes ?? null,
            approvedAt: new Date(),
            approvedById: actorId
        }
    });
    await prisma_1.prisma.payrollAuditLog.create({
        data: {
            actorId,
            scope: 'bonus',
            target: `${candidate.userId}:${candidate.type}:${candidate.periodKey}`,
            action: status,
            details: {
                finalAmount: candidate.finalAmount,
                notes
            }
        }
    });
    return candidate;
};
exports.updateKpiBonusStatus = updateKpiBonusStatus;

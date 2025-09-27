"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyAccrualsForAllUsers = exports.applyMonthlyAccrual = void 0;
const date_fns_1 = require("date-fns");
const prisma_1 = require("../prisma");
const balances_1 = require("./balances");
const logger_1 = require("../logger");
const monthKey = (date) => (0, date_fns_1.format)((0, date_fns_1.startOfMonth)(date), 'yyyy-MM');
const getApplicableRule = async (userId) => {
    const [userRule, defaultRule] = await Promise.all([
        prisma_1.prisma.accrualRule.findUnique({ where: { userId } }),
        prisma_1.prisma.accrualRule.findFirst({ where: { isDefault: true } })
    ]);
    return userRule ?? defaultRule ?? null;
};
const applyMonthlyAccrual = async (referenceDate, userId) => {
    const month = monthKey(referenceDate);
    const userWhere = userId ? { id: userId } : undefined;
    const users = await prisma_1.prisma.user.findMany({
        where: userWhere,
        include: {
            balance: true,
            accrualRule: true
        }
    });
    const defaultRule = await prisma_1.prisma.accrualRule.findFirst({ where: { isDefault: true } });
    const results = [];
    for (const user of users) {
        const rule = user.accrualRule ?? defaultRule;
        if (!rule) {
            results.push({ userId: user.id, applied: false, reason: 'no_rule' });
            continue;
        }
        if (rule.startDate && (0, date_fns_1.isBefore)(referenceDate, rule.startDate)) {
            results.push({ userId: user.id, applied: false, reason: 'before_start' });
            continue;
        }
        const balance = user.balance ?? (await (0, balances_1.ensureBalance)(user.id));
        if (balance.lastAccrualMonth === month) {
            results.push({ userId: user.id, applied: false, reason: 'already_applied' });
            continue;
        }
        const hours = rule.hoursPerMonth;
        await prisma_1.prisma.ptoBalance.update({
            where: { id: balance.id },
            data: {
                basePtoHours: balance.basePtoHours + hours,
                ptoHours: balance.ptoHours + hours,
                lastAccrualMonth: month
            }
        });
        results.push({ userId: user.id, applied: true, hoursApplied: hours });
    }
    return results;
};
exports.applyMonthlyAccrual = applyMonthlyAccrual;
const applyAccrualsForAllUsers = async () => {
    const now = new Date();
    const results = await (0, exports.applyMonthlyAccrual)(now);
    const appliedCount = results.filter((r) => r.applied).length;
    logger_1.logger.info({ appliedCount, month: monthKey(now) }, 'Accrual job completed');
    return results;
};
exports.applyAccrualsForAllUsers = applyAccrualsForAllUsers;

import { format, isBefore, startOfMonth } from 'date-fns';
import { prisma } from '../prisma';
import { ensureBalance } from './balances';
import { logger } from '../logger';

interface AccrualResult {
  userId: number;
  applied: boolean;
  hoursApplied?: number;
  reason?: string;
}

const monthKey = (date: Date) => format(startOfMonth(date), 'yyyy-MM');

const getApplicableRule = async (userId: number) => {
  const [userRule, defaultRule] = await Promise.all([
    prisma.accrualRule.findUnique({ where: { userId } }),
    prisma.accrualRule.findFirst({ where: { isDefault: true } })
  ]);

  return userRule ?? defaultRule ?? null;
};

export const applyMonthlyAccrual = async (referenceDate: Date, userId?: number): Promise<AccrualResult[]> => {
  const month = monthKey(referenceDate);
  const userWhere = userId ? { id: userId } : undefined;
  const users = await prisma.user.findMany({
    where: userWhere,
    include: {
      balance: true,
      accrualRule: true
    }
  });

  const defaultRule = await prisma.accrualRule.findFirst({ where: { isDefault: true } });
  const results: AccrualResult[] = [];

  for (const user of users) {
    const rule = user.accrualRule ?? defaultRule;
    if (!rule) {
      results.push({ userId: user.id, applied: false, reason: 'no_rule' });
      continue;
    }

    if (rule.startDate && isBefore(referenceDate, rule.startDate)) {
      results.push({ userId: user.id, applied: false, reason: 'before_start' });
      continue;
    }

    const balance = user.balance ?? (await ensureBalance(user.id));
    if (balance.lastAccrualMonth === month) {
      results.push({ userId: user.id, applied: false, reason: 'already_applied' });
      continue;
    }

    const hours = rule.hoursPerMonth;
    await prisma.ptoBalance.update({
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

export const applyAccrualsForAllUsers = async () => {
  const now = new Date();
  const results = await applyMonthlyAccrual(now);
  const appliedCount = results.filter((r) => r.applied).length;
  logger.info({ appliedCount, month: monthKey(now) }, 'Accrual job completed');
  return results;
};

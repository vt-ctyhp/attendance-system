import { format, isBefore, startOfMonth } from 'date-fns';
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
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

    const ptoHours = rule.ptoHoursPerMonth ?? rule.hoursPerMonth ?? 0;
    const utoHours = rule.utoHoursPerMonth ?? 0;
    const makeUpHours = 0;

    const data: Prisma.PtoBalanceUpdateInput = {
      lastAccrualMonth: month
    };

    if (ptoHours) {
      data.basePtoHours = { increment: ptoHours };
      data.ptoHours = { increment: ptoHours };
    }
    if (utoHours) {
      data.baseUtoHours = { increment: utoHours };
      data.utoHours = { increment: utoHours };
    }
    await prisma.ptoBalance.update({
      where: { id: balance.id },
      data
    });

    results.push({ userId: user.id, applied: true, hoursApplied: ptoHours });
  }

  return results;
};

export const setUserAccrualRule = async ({
  userId,
  ptoHoursPerMonth,
  utoHoursPerMonth,
  actorId
}: {
  userId: number;
  ptoHoursPerMonth?: number | null;
  utoHoursPerMonth?: number | null;
  actorId?: number;
}) => {
  const payloadProvided = [ptoHoursPerMonth, utoHoursPerMonth].some(
    (value) => value !== undefined
  );

  if (!payloadProvided) {
    return null;
  }

  const normalize = (value: number | null | undefined) =>
    value !== null && value !== undefined ? Math.max(0, Math.round(value * 100) / 100) : null;

  const pto = normalize(ptoHoursPerMonth);
  const uto = normalize(utoHoursPerMonth);

  const nullRequested = [pto, uto].every((value) => value === null);
  if (nullRequested) {
    try {
      await prisma.accrualRule.delete({ where: { userId } });
      logger.info({ userId, actorId }, 'accrual.rule.removed');
    } catch (error) {
      // ignore missing custom rule
    }
    return null;
  }

  const rule = await prisma.accrualRule.upsert({
    where: { userId },
    update: {
      hoursPerMonth: pto ?? 0,
      ptoHoursPerMonth: pto ?? 0,
      utoHoursPerMonth: uto ?? 0,
      updatedAt: new Date()
    },
    create: {
      userId,
      isDefault: false,
      startDate: new Date(),
      hoursPerMonth: pto ?? 0,
      ptoHoursPerMonth: pto ?? 0,
      utoHoursPerMonth: uto ?? 0
    }
  });

  logger.info({ userId, actorId, pto, uto }, 'accrual.rule.updated');
  return rule;
};

export const applyAccrualsForAllUsers = async () => {
  const now = new Date();
  const results = await applyMonthlyAccrual(now);
  const appliedCount = results.filter((r) => r.applied).length;
  logger.info({ appliedCount, month: monthKey(now) }, 'Accrual job completed');
  return results;
};

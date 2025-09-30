import { addMonths, set } from 'date-fns';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { getEffectiveConfigForDate } from './config';
import { PAYROLL_TIME_ZONE, type PayrollBonusStatus, type PayrollBonusType } from './types';
import { recordPayrollAudit } from './audit';

const ISO_MONTH = 'yyyy-MM';

const toMonthStart = (date: Date) => {
  const zoned = utcToZonedTime(date, PAYROLL_TIME_ZONE);
  const start = set(zoned, { date: 1, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
  return zonedTimeToUtc(start, PAYROLL_TIME_ZONE);
};

const toPayDate = (month: Date, dayOfMonth: number) => {
  const zoned = utcToZonedTime(month, PAYROLL_TIME_ZONE);
  const candidate = set(zoned, { date: dayOfMonth, hours: 12, minutes: 0, seconds: 0, milliseconds: 0 });
  return zonedTimeToUtc(candidate, PAYROLL_TIME_ZONE);
};

const computeMonthlyBonusPayDate = (month: Date, finalizedAt: Date) => {
  let offset = 1;
  let target = toPayDate(addMonths(month, offset), 15);
  while (target <= finalizedAt) {
    offset += 1;
    target = toPayDate(addMonths(month, offset), 15);
  }
  return target;
};

const quarterStartMonth = (month: Date) => {
  const zoned = utcToZonedTime(month, PAYROLL_TIME_ZONE);
  const quarterIndex = Math.floor(zoned.getMonth() / 3);
  const firstMonth = quarterIndex * 3;
  const start = set(zoned, { month: firstMonth, date: 1, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
  return zonedTimeToUtc(start, PAYROLL_TIME_ZONE);
};

const quarterPayDate = (quarterStart: Date) => toPayDate(addMonths(quarterStart, 3), 15);

interface BonusSyncContext {
  client?: Prisma.TransactionClient | PrismaClient;
}

const resolveClient = (ctx?: BonusSyncContext) => ctx?.client ?? prisma;

export const listBonuses = async (
  filters: {
    type?: 'MONTHLY_ATTENDANCE' | 'QUARTERLY_ATTENDANCE' | 'KPI';
    status?: 'PENDING' | 'ELIGIBLE' | 'APPROVED' | 'DENIED' | 'PAID';
    payableDate?: Date;
  },
  ctx?: BonusSyncContext
) => {
  const client = resolveClient(ctx);
  return client.payrollBonus.findMany({
    where: {
      type: filters.type,
      status: filters.status,
      payableDate: filters.payableDate
    },
    orderBy: { payableDate: 'asc' }
  });
};

export const syncMonthlyAttendanceBonus = async (
  factId: number,
  finalizedAt: Date,
  ctx?: BonusSyncContext
) => {
  const client = resolveClient(ctx);
  const fact = await client.payrollAttendanceFact.findUnique({
    where: { id: factId }
  });
  if (!fact) return null;
  if (!fact.isPerfect) {
    await client.payrollBonus.updateMany({
      where: {
        attendanceFactId: factId,
        type: 'MONTHLY_ATTENDANCE'
      },
      data: { status: 'DENIED', decisionReason: 'Attendance not perfect', decidedAt: finalizedAt }
    });
    return null;
  }

  const monthStart = toMonthStart(fact.month);
  const config = await getEffectiveConfigForDate(fact.userId, monthStart, client);
  const monthlyBonusAmount = config ? Number(config.monthlyAttendanceBonus ?? 0) : 0;
  if (!config || monthlyBonusAmount <= 0) {
    return null;
  }

  const payDate = computeMonthlyBonusPayDate(monthStart, finalizedAt);

  const bonus = await client.payrollBonus.upsert({
    where: {
      userId_type_sourceMonth: {
        userId: fact.userId,
        type: 'MONTHLY_ATTENDANCE',
        sourceMonth: monthStart
      }
    },
    update: {
      amount: monthlyBonusAmount,
      status: 'APPROVED',
      payableDate: payDate,
      attendanceFactId: factId,
      decidedAt: finalizedAt
    },
    create: {
      userId: fact.userId,
      type: 'MONTHLY_ATTENDANCE',
      status: 'APPROVED',
      sourceMonth: monthStart,
      amount: monthlyBonusAmount,
      payableDate: payDate,
      attendanceFactId: factId
    }
  });

  await recordPayrollAudit({
    actorId: null,
    entityType: 'PayrollBonus',
    entityId: String(bonus.id),
    event: 'BONUS_DECISION',
    payload: {
      type: 'MONTHLY_ATTENDANCE',
      status: bonus.status,
      payableDate: bonus.payableDate.toISOString()
    } as Prisma.JsonValue
  });

  return bonus;
};

export const syncQuarterlyAttendanceBonus = async (
  factId: number,
  finalizedAt: Date,
  ctx?: BonusSyncContext
) => {
  const client = resolveClient(ctx);
  const fact = await client.payrollAttendanceFact.findUnique({
    where: { id: factId }
  });
  if (!fact) return null;

  const monthStart = toMonthStart(fact.month);
  const quarterStart = quarterStartMonth(monthStart);
  const months: Date[] = [0, 1, 2].map((offset) => addMonths(quarterStart, offset));
  const facts = await client.payrollAttendanceFact.findMany({
    where: {
      userId: fact.userId,
      month: { in: months }
    }
  });
  if (facts.length !== 3 || facts.some((row) => !row.isPerfect)) {
    await client.payrollBonus.updateMany({
      where: {
        userId: fact.userId,
        type: 'QUARTERLY_ATTENDANCE',
        quarterKey: formatInTimeZone(quarterStart, PAYROLL_TIME_ZONE, 'yyyy-QQ')
      },
      data: { status: 'DENIED', decisionReason: 'Quarter not perfect', decidedAt: finalizedAt }
    });
    return null;
  }

  const config = await getEffectiveConfigForDate(fact.userId, quarterStart, client);
  const quarterlyAmount = config ? Number(config.quarterlyAttendanceBonus ?? 0) : 0;
  if (!config || quarterlyAmount <= 0) {
    return null;
  }

  const payDate = quarterPayDate(quarterStart);
  const quarterKey = formatInTimeZone(quarterStart, PAYROLL_TIME_ZONE, 'yyyy-QQ');

  const bonus = await client.payrollBonus.upsert({
    where: {
      userId_type_sourceMonth: {
        userId: fact.userId,
        type: 'QUARTERLY_ATTENDANCE',
        sourceMonth: quarterStart
      }
    },
    update: {
      amount: quarterlyAmount,
      status: 'APPROVED',
      payableDate: payDate,
      attendanceFactId: factId,
      quarterKey,
      decidedAt: finalizedAt
    },
    create: {
      userId: fact.userId,
      type: 'QUARTERLY_ATTENDANCE',
      status: 'APPROVED',
      sourceMonth: quarterStart,
      amount: quarterlyAmount,
      payableDate: payDate,
      attendanceFactId: factId,
      quarterKey
    }
  });

  await recordPayrollAudit({
    actorId: null,
    entityType: 'PayrollBonus',
    entityId: String(bonus.id),
    event: 'BONUS_DECISION',
    payload: {
      type: 'QUARTERLY_ATTENDANCE',
      status: bonus.status,
      payableDate: bonus.payableDate.toISOString()
    } as Prisma.JsonValue
  });

  return bonus;
};

export const ensureKpiBonusCandidate = async (
  userId: number,
  month: Date,
  ctx?: BonusSyncContext
) => {
  const client = resolveClient(ctx);
  const monthStart = toMonthStart(month);
  const config = await getEffectiveConfigForDate(userId, monthStart, client);
  if (!config || !config.kpiBonusEnabled) {
    return null;
  }

  const payDate = computeMonthlyBonusPayDate(monthStart, new Date());
  const kpiAmount = Number(config.kpiBonusDefaultAmount ?? 0);

  return client.payrollBonus.upsert({
    where: {
      userId_type_sourceMonth: {
        userId,
        type: 'KPI',
        sourceMonth: monthStart
      }
    },
    update: {
      amount: kpiAmount,
      status: 'PENDING',
      payableDate: payDate
    },
    create: {
      userId,
      type: 'KPI',
      status: 'PENDING',
      sourceMonth: monthStart,
      amount: kpiAmount,
      payableDate: payDate
    }
  }).then(async (bonus) => {
    await recordPayrollAudit({
      actorId: null,
      entityType: 'PayrollBonus',
      entityId: String(bonus.id),
      event: 'BONUS_DECISION',
      payload: {
        type: 'KPI',
        status: bonus.status,
        payableDate: bonus.payableDate.toISOString()
      } as Prisma.JsonValue
    });
    return bonus;
  });
};

export const getBonusesPayableOn = async (payDate: Date, ctx?: BonusSyncContext) => {
  const client = resolveClient(ctx);
  return client.payrollBonus.findMany({
    where: {
      payableDate: payDate,
      status: 'APPROVED'
    },
    orderBy: { userId: 'asc' }
  });
};

interface BonusDecisionInput {
  bonusId: number;
  status: 'APPROVED' | 'DENIED';
  amount?: number;
  reason?: string | null;
  actorId?: number;
}

export const decideBonus = async ({ bonusId, status, amount, reason, actorId }: BonusDecisionInput) => {
  const bonus = await prisma.payrollBonus.update({
    where: { id: bonusId },
    data: {
      status,
      approvedAmount: status === 'APPROVED' ? (amount ?? undefined) : null,
      decisionReason: reason ?? null,
      decisionById: actorId ?? null,
      decidedAt: new Date()
    }
  });

  await recordPayrollAudit({
    actorId: actorId ?? null,
    entityType: 'PayrollBonus',
    entityId: String(bonus.id),
    event: 'BONUS_DECISION',
    payload: {
      status: bonus.status,
      approvedAmount: bonus.approvedAmount ? Number(bonus.approvedAmount) : null
    } as Prisma.JsonValue
  });

  return bonus;
};

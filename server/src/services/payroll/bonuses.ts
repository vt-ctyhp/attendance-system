import { addMonths } from 'date-fns';
import { Decimal } from '@prisma/client/runtime/library';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { prisma } from '../../prisma';
import {
  PAYROLL_TIME_ZONE,
  DATE_KEY_FORMAT,
  BONUS_TYPE_MONTHLY,
  BONUS_TYPE_QUARTERLY,
  BONUS_TYPE_KPI
} from './constants';
import { getEffectiveConfigForDate } from './config';
import type { AttendanceMonthFact, BonusCandidate, Prisma } from '@prisma/client';

const buildMonthKeyDate = (monthKey: string) => {
  const [year, month] = monthKey.split('-').map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  return new Date(Date.UTC(year, month - 1, 1));
};

const resolveMonthlyPayDate = (monthKey: string, computedAt: Date) => {
  const baseDate = buildMonthKeyDate(monthKey);
  const nextMonth = addMonths(baseDate, 1);
  const payZoned = utcToZonedTime(nextMonth, PAYROLL_TIME_ZONE);
  payZoned.setDate(15);
  payZoned.setHours(0, 0, 0, 0);
  let payDate = zonedTimeToUtc(payZoned, PAYROLL_TIME_ZONE);
  if (computedAt > payDate) {
    const deferred = addMonths(payZoned, 1);
    deferred.setDate(15);
    payDate = zonedTimeToUtc(deferred, PAYROLL_TIME_ZONE);
  }
  return payDate;
};

const resolveQuarterForMonth = (monthKey: string) => {
  const [year, month] = monthKey.split('-').map((value) => Number.parseInt(value, 10));
  const quarterIndex = Math.floor((month - 1) / 3) + 1;
  const quarterEndMonth = quarterIndex * 3;
  const quarterKey = `${year}-Q${quarterIndex}`;
  return { quarterIndex, quarterEndMonth, quarterKey, year, month };
};

const resolveQuarterPayDate = (year: number, quarterIndex: number) => {
  const payMonths = [4, 7, 10, 1];
  const payMonth = payMonths[quarterIndex - 1];
  const payYear = quarterIndex === 4 ? year + 1 : year;
  const zoned = utcToZonedTime(new Date(Date.UTC(payYear, payMonth - 1, 1)), PAYROLL_TIME_ZONE);
  zoned.setDate(15);
  zoned.setHours(0, 0, 0, 0);
  return zonedTimeToUtc(zoned, PAYROLL_TIME_ZONE);
};

const upsertBonus = async (data: {
  userId: number;
  type: string;
  periodKey: string;
  amount: number;
  eligiblePayDate: Date;
  status: string;
  finalAmount?: number | null;
  snapshot: Record<string, unknown>;
  notes?: string;
  actorId?: number;
}) => {
  const { actorId, ...payload } = data;
  const record = await prisma.bonusCandidate.upsert({
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
      amount: new Decimal(payload.amount),
      status: payload.status,
      finalAmount:
        payload.finalAmount !== undefined && payload.finalAmount !== null
          ? new Decimal(payload.finalAmount)
          : null,
      snapshot: payload.snapshot as Prisma.JsonObject,
      notes: payload.notes ?? null
    },
    update: {
      eligiblePayDate: payload.eligiblePayDate,
      amount: new Decimal(payload.amount),
      status: payload.status,
      finalAmount:
        payload.finalAmount !== undefined && payload.finalAmount !== null
          ? new Decimal(payload.finalAmount)
          : null,
      snapshot: payload.snapshot as Prisma.JsonObject,
      notes: payload.notes ?? null,
      computedAt: new Date()
    }
  });

  if (actorId) {
    await prisma.payrollAuditLog.create({
      data: {
        actorId,
        scope: 'bonus',
        target: `${payload.userId}:${payload.type}:${payload.periodKey}`,
        action: 'upsert',
        details: {
          amount: payload.amount,
          status: payload.status,
          eligiblePayDate: formatInTimeZone(
            payload.eligiblePayDate,
            PAYROLL_TIME_ZONE,
            DATE_KEY_FORMAT
          )
        }
      }
    });
  }

  return record;
};

export const recalcMonthlyBonuses = async (monthKey: string, actorId?: number) => {
  const computedAt = new Date();
  const payDate = resolveMonthlyPayDate(monthKey, computedAt);
  const facts = await prisma.attendanceMonthFact.findMany({
    where: { monthKey },
    include: { user: true }
  });

  const monthBonuses: BonusCandidate[] = [];

  for (const fact of facts) {
    const config = await getEffectiveConfigForDate(fact.userId, fact.rangeEnd);
    if (!config) continue;
    if (!fact.isPerfect) {
      await prisma.bonusCandidate.deleteMany({
        where: {
          userId: fact.userId,
          type: BONUS_TYPE_MONTHLY,
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
      type: BONUS_TYPE_MONTHLY,
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

  const { quarterIndex, quarterEndMonth, quarterKey, year, month } =
    resolveQuarterForMonth(monthKey);
  if (month === quarterEndMonth) {
    const quarterMonths: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const targetMonth = quarterEndMonth - i;
      const paddedMonth = targetMonth.toString().padStart(2, '0');
      quarterMonths.unshift(`${year}-${paddedMonth}`);
    }

    const quarterFacts = await prisma.attendanceMonthFact.findMany({
      where: { monthKey: { in: quarterMonths } },
      include: { user: true }
    });
    const factsByUser = new Map<number, AttendanceMonthFact[]>();
    for (const fact of quarterFacts) {
      const list = factsByUser.get(fact.userId);
      if (list) {
        list.push(fact);
      } else {
        factsByUser.set(fact.userId, [fact]);
      }
    }

    const payDateQuarter = resolveQuarterPayDate(year, quarterIndex);

    for (const [userId, userFacts] of factsByUser.entries()) {
      if (userFacts.length !== 3) {
        await prisma.bonusCandidate.deleteMany({
          where: { userId, type: BONUS_TYPE_QUARTERLY, periodKey: quarterKey }
        });
        continue;
      }
      if (!userFacts.every((fact) => fact.isPerfect)) {
        await prisma.bonusCandidate.deleteMany({
          where: { userId, type: BONUS_TYPE_QUARTERLY, periodKey: quarterKey }
        });
        continue;
      }
      const config = await getEffectiveConfigForDate(userId, userFacts[2].rangeEnd);
      if (!config) continue;
      const amount = Number(config.quarterlyAttendanceBonus);
      const snapshot = {
        quarterKey,
        monthKeys: quarterMonths,
        factIds: userFacts.map((fact) => fact.id)
      };
      await upsertBonus({
        userId,
        type: BONUS_TYPE_QUARTERLY,
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
    const config = await getEffectiveConfigForDate(fact.userId, fact.rangeEnd);
    if (!config || !config.kpiEligible) {
      await prisma.bonusCandidate.deleteMany({
        where: {
          userId: fact.userId,
          type: BONUS_TYPE_KPI,
          periodKey: monthKey
        }
      });
      continue;
    }
    const amount = config.defaultKpiBonus ? Number(config.defaultKpiBonus) : 0;
    const snapshot = { monthKey, factId: fact.id, defaultAmount: amount };
    const existing = await prisma.bonusCandidate.findUnique({
      where: {
        userId_type_periodKey: {
          userId: fact.userId,
          type: BONUS_TYPE_KPI,
          periodKey: monthKey
        }
      }
    });
    if (existing && existing.status !== 'pending') {
      continue;
    }
    await upsertBonus({
      userId: fact.userId,
      type: BONUS_TYPE_KPI,
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

export const listBonusesForPayDate = async (payDate: Date) => {
  const candidates = await prisma.bonusCandidate.findMany({
    where: { eligiblePayDate: payDate },
    include: { user: { select: { id: true, name: true, email: true } } }
  });
  return candidates;
};

export const updateKpiBonusStatus = async (
  id: number,
  status: 'approved' | 'denied',
  actorId: number,
  finalAmount?: number,
  notes?: string
) => {
  const candidate = await prisma.bonusCandidate.update({
    where: { id },
    data: {
      status,
      finalAmount:
        finalAmount !== undefined ? new Decimal(finalAmount) : undefined,
      notes: notes ?? null,
      approvedAt: new Date(),
      approvedById: actorId
    }
  });

  await prisma.payrollAuditLog.create({
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

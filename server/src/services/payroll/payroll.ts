import { Decimal } from '@prisma/client/runtime/library';
import {
  addMonths,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  format,
  setDate,
  startOfDay
} from 'date-fns';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { prisma } from '../../prisma';
import {
  PAYROLL_TIME_ZONE,
  DATE_KEY_FORMAT,
  BONUS_TYPE_MONTHLY,
  BONUS_TYPE_QUARTERLY,
  BONUS_TYPE_KPI
} from './constants';
import { getAllConfigsThrough, resolveActiveConfigForRange, type EmployeeCompSnapshot } from './config';
import type { BonusCandidate, Prisma } from '@prisma/client';

const resolvePayPeriod = (payDate: Date) => {
  const zoned = utcToZonedTime(payDate, PAYROLL_TIME_ZONE);
  const endOfMonthDate = endOfMonth(zoned);
  const isFifteenth = zoned.getDate() === 15;
  const isEndOfMonth = zoned.getDate() === endOfMonthDate.getDate();

  if (!isFifteenth && !isEndOfMonth) {
    throw new Error('Pay date must be either the 15th or the end of month');
  }

  if (isFifteenth) {
    const prevMonth = addMonths(zoned, -1);
    const start = zonedTimeToUtc(startOfDay(setDate(prevMonth, 16)), PAYROLL_TIME_ZONE);
    const end = zonedTimeToUtc(endOfDay(endOfMonth(prevMonth)), PAYROLL_TIME_ZONE);
    const monthKey = format(prevMonth, 'yyyy-MM');
    return { periodKey: `${monthKey}-B`, periodStart: start, periodEnd: end };
  }

  const start = zonedTimeToUtc(startOfDay(setDate(zoned, 1)), PAYROLL_TIME_ZONE);
  const end = zonedTimeToUtc(endOfDay(setDate(zoned, 15)), PAYROLL_TIME_ZONE);
  const monthKey = format(zoned, 'yyyy-MM');
  return { periodKey: `${monthKey}-A`, periodStart: start, periodEnd: end };
};

const computeBaseForUser = (
  configs: EmployeeCompSnapshot[],
  periodStart: Date,
  periodEnd: Date
) => {
  const days = eachDayOfInterval({ start: periodStart, end: periodEnd });
  if (!days.length) return 0;
  const totalDays = days.length;
  const counts = new Map<number, number>();
  for (const day of days) {
    const config = resolveActiveConfigForRange(configs, day);
    if (!config) continue;
    counts.set(config.id, (counts.get(config.id) ?? 0) + 1);
  }
  let total = 0;
  for (const [configId, count] of counts.entries()) {
    const config = configs.find((entry) => entry.id === configId);
    if (!config) continue;
    const ratio = count / totalDays;
    total += Number(config.baseSemiMonthlySalary) * ratio;
  }
  return Math.round(total * 100) / 100;
};

const sumCandidateAmount = (candidate: BonusCandidate) => {
  if (candidate.finalAmount) {
    return Number(candidate.finalAmount);
  }
  return Number(candidate.amount);
};

const isMonthlyDeferred = (candidate: BonusCandidate, payDate: Date) => {
  const zonedPay = utcToZonedTime(payDate, PAYROLL_TIME_ZONE);
  const prevMonth = addMonths(zonedPay, -1);
  const expected = format(prevMonth, 'yyyy-MM');
  return candidate.periodKey !== expected;
};

const categorizeBonuses = (candidates: BonusCandidate[], payDate: Date) => {
  const map = new Map<number, { monthly: number; monthlyDeferred: number; quarterly: number; kpi: number }>();
  for (const candidate of candidates) {
    const amount = sumCandidateAmount(candidate);
    const bucket = map.get(candidate.userId) ?? {
      monthly: 0,
      monthlyDeferred: 0,
      quarterly: 0,
      kpi: 0
    };
    if (candidate.type === BONUS_TYPE_MONTHLY) {
      if (isMonthlyDeferred(candidate, payDate)) {
        bucket.monthlyDeferred += amount;
      } else {
        bucket.monthly += amount;
      }
    } else if (candidate.type === BONUS_TYPE_QUARTERLY) {
      bucket.quarterly += amount;
    } else if (candidate.type === BONUS_TYPE_KPI) {
      bucket.kpi += amount;
    }
    map.set(candidate.userId, bucket);
  }
  return map;
};

type PayrollLineSummary = {
  baseAmount: number;
  monthlyAttendance: number;
  monthlyDeferred: number;
  quarterlyAttendance: number;
  kpiBonus: number;
  finalAmount: number;
};

const summarizeTotals = (lines: PayrollLineSummary[]) => {
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

export const recalcPayrollForPayDate = async (payDate: Date, actorId?: number) => {
  const { periodKey, periodStart, periodEnd } = resolvePayPeriod(payDate);
  const existing = await prisma.payrollPeriod.findUnique({ where: { periodKey } });
  if (existing && existing.status === 'paid') {
    throw new Error('Cannot recalc a paid payroll period');
  }

  const users = await prisma.user.findMany({ where: { active: true } });

  const bonusCandidates = await prisma.bonusCandidate.findMany({
    where: {
      eligiblePayDate: payDate,
      OR: [
        { type: BONUS_TYPE_MONTHLY, status: 'earned' },
        { type: BONUS_TYPE_QUARTERLY, status: 'earned' },
        { type: BONUS_TYPE_KPI, status: 'approved' }
      ]
    }
  });
  const bonusMap = categorizeBonuses(bonusCandidates, payDate);

  const linesData: Array<
    PayrollLineSummary & { userId: number; snapshot: Record<string, unknown> }
  > = [];

  for (const user of users) {
    const configs = await getAllConfigsThrough(user.id, periodEnd);
    if (!configs.length) continue;
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
    const finalAmount =
      Math.round((baseAmount + monthly + monthlyDeferred + quarterly + kpi) * 100) / 100;
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
          effectiveOn: formatInTimeZone(config.effectiveOn, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
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

  const result = await prisma.$transaction(async (tx) => {
    const period = await tx.payrollPeriod.upsert({
      where: { periodKey },
      create: {
        periodKey,
        periodStart,
        periodEnd,
        payDate,
        status: existing?.status ?? 'draft',
        totals: totals as unknown as Prisma.JsonObject,
        computedAt: new Date()
      },
      update: {
        periodStart,
        periodEnd,
        payDate,
        totals: totals as unknown as Prisma.JsonObject,
        computedAt: new Date()
      }
    });

    await tx.payrollLine.deleteMany({ where: { payrollPeriodId: period.id } });
    if (linesData.length) {
      await tx.payrollLine.createMany({
        data: linesData.map((line) => ({
          payrollPeriodId: period.id,
          userId: line.userId,
          baseAmount: new Decimal(line.baseAmount),
          monthlyAttendance: new Decimal(line.monthlyAttendance),
          monthlyDeferred: new Decimal(line.monthlyDeferred),
          quarterlyAttendance: new Decimal(line.quarterlyAttendance),
          kpiBonus: new Decimal(line.kpiBonus),
          finalAmount: new Decimal(line.finalAmount),
          snapshot: line.snapshot as Prisma.JsonObject
        }))
      });
    }

    return period;
  });

  if (actorId) {
    await prisma.payrollAuditLog.create({
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

export const getPayrollPeriod = async (payDate: Date) => {
  const { periodKey } = resolvePayPeriod(payDate);
  const period = await prisma.payrollPeriod.findUnique({
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

export const approvePayrollPeriod = async (payDate: Date, actorId: number) => {
  const { periodKey } = resolvePayPeriod(payDate);
  const period = await prisma.payrollPeriod.update({
    where: { periodKey },
    data: { status: 'approved', approvedAt: new Date(), approvedById: actorId }
  });
  await prisma.payrollAuditLog.create({
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

export const markPayrollPaid = async (payDate: Date, actorId: number) => {
  const { periodKey } = resolvePayPeriod(payDate);
  const period = await prisma.payrollPeriod.update({
    where: { periodKey },
    data: { status: 'paid', paidAt: new Date(), paidById: actorId }
  });
  await prisma.payrollAuditLog.create({
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

export const exportPayrollCsv = async (payDate: Date) => {
  const period = await getPayrollPeriod(payDate);
  if (!period) return '';
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
    rows.push(
      [
        employee,
        email,
        formatInTimeZone(period.periodStart, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
        formatInTimeZone(period.periodEnd, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
        Number(line.baseAmount).toFixed(2),
        Number(line.monthlyAttendance).toFixed(2),
        Number(line.monthlyDeferred).toFixed(2),
        Number(line.quarterlyAttendance).toFixed(2),
        Number(line.kpiBonus).toFixed(2),
        Number(line.finalAmount).toFixed(2)
      ].join(',')
    );
  }
  return rows.join('\n');
};

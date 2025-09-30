import { addMonths, endOfDay, endOfMonth, set, setDate, startOfDay, startOfMonth } from 'date-fns';
import { utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { PAYROLL_TIME_ZONE, type PayrollPeriodStatus } from './types';
import { getEffectiveConfigForDate } from './config';
import { getBonusesPayableOn } from './bonus';
import { recordPayrollAudit } from './audit';

interface PeriodResolveResult {
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
}

const toZoned = (date: Date) => utcToZonedTime(date, PAYROLL_TIME_ZONE);
const fromZoned = (date: Date) => zonedTimeToUtc(date, PAYROLL_TIME_ZONE);
const ISO_DATE = 'yyyy-MM-dd';

const startUtc = (zoned: Date) => zonedTimeToUtc(startOfDay(zoned), PAYROLL_TIME_ZONE);
const endUtc = (zoned: Date) => zonedTimeToUtc(endOfDay(zoned), PAYROLL_TIME_ZONE);
const payUtc = (zoned: Date) => zonedTimeToUtc(set(zoned, { hours: 12, minutes: 0, seconds: 0, milliseconds: 0 }), PAYROLL_TIME_ZONE);

const resolvePeriod = (reference: Date): PeriodResolveResult => {
  const zoned = toZoned(reference);
  const startOfCurrentMonth = startOfMonth(zoned);
  const endOfCurrentMonth = endOfMonth(zoned);
  const day = zoned.getDate();

  if (day <= 15) {
    const periodStart = startUtc(startOfCurrentMonth);
    const periodEnd = endUtc(setDate(startOfCurrentMonth, 15));
    const payDate = payUtc(endOfCurrentMonth);
    return { periodStart, periodEnd, payDate };
  }

  const secondHalfStart = setDate(startOfCurrentMonth, 16);
  const periodStart = startUtc(secondHalfStart);
  const periodEnd = endUtc(endOfCurrentMonth);
  const nextMonth = addMonths(startOfCurrentMonth, 1);
  const payDate = payUtc(setDate(nextMonth, 15));
  return { periodStart, periodEnd, payDate };
};

const resolveClient = (tx?: Prisma.TransactionClient | PrismaClient) => tx ?? prisma;

export const ensurePayrollPeriod = async (reference: Date, tx?: Prisma.TransactionClient | PrismaClient) => {
  const { periodStart, periodEnd, payDate } = resolvePeriod(reference);
  const client = resolveClient(tx);
  return client.payrollPeriod.upsert({
    where: { periodStart_periodEnd: { periodStart, periodEnd } },
    update: {},
    create: {
      periodStart,
      periodEnd,
      payDate,
      status: 'DRAFT'
    }
  });
};

interface RecalcOptions {
  actorId?: number;
  autoApprove?: boolean;
}

export const recalcPayrollPeriod = async (
  periodId: number,
  options: RecalcOptions = {}
) => {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) {
    throw new Error('Payroll period not found');
  }

  const employees = await prisma.user.findMany({ where: { role: 'employee', active: true } });

  const payableBonuses = await getBonusesPayableOn(period.payDate);
  const bonusesByUser = new Map<number, typeof payableBonuses>();
  for (const bonus of payableBonuses) {
    const list = bonusesByUser.get(bonus.userId) ?? [];
    list.push(bonus);
    bonusesByUser.set(bonus.userId, list);
  }

  await prisma.$transaction(async (tx) => {
    for (const employee of employees) {
      const config = await getEffectiveConfigForDate(employee.id, period.periodStart, tx);
      const baseAmount = config ? Number(config.baseSemiMonthlySalary) : 0;
      const bonuses = bonusesByUser.get(employee.id) ?? [];
      const monthlyAttendanceBonus = bonuses
        .filter((bonus) => bonus.type === 'MONTHLY_ATTENDANCE' && bonus.status === 'APPROVED')
        .reduce((total: number, bonus) => total + Number(bonus.approvedAmount ?? bonus.amount ?? 0), 0);
      const deferredMonthlyBonus = 0;
      const quarterlyBonus = bonuses
        .filter((bonus) => bonus.type === 'QUARTERLY_ATTENDANCE' && bonus.status === 'APPROVED')
        .reduce((total: number, bonus) => total + Number(bonus.approvedAmount ?? bonus.amount ?? 0), 0);
      const kpiBonus = bonuses
        .filter((bonus) => bonus.type === 'KPI' && bonus.status === 'APPROVED')
        .reduce((total: number, bonus) => total + Number(bonus.approvedAmount ?? bonus.amount ?? 0), 0);

      const totalAmount = baseAmount + monthlyAttendanceBonus + deferredMonthlyBonus + quarterlyBonus + kpiBonus;

      const check = await tx.payrollCheck.upsert({
        where: { periodId_userId: { periodId: period.id, userId: employee.id } },
        update: {
          baseAmount,
          monthlyAttendanceBonus,
          deferredMonthlyBonus,
          quarterlyAttendanceBonus: quarterlyBonus,
          kpiBonus,
          totalAmount,
          status: options.autoApprove ? 'APPROVED' : 'DRAFT',
          snapshot: {
            baseAmount,
            monthlyAttendanceBonus,
            deferredMonthlyBonus,
            quarterlyBonus,
            kpiBonus
          } as Prisma.InputJsonValue
        },
        create: {
          periodId: period.id,
          userId: employee.id,
          baseAmount,
          monthlyAttendanceBonus,
          deferredMonthlyBonus,
          quarterlyAttendanceBonus: quarterlyBonus,
          kpiBonus,
          totalAmount,
          status: options.autoApprove ? 'APPROVED' : 'DRAFT',
          snapshot: {
            baseAmount,
            monthlyAttendanceBonus,
            deferredMonthlyBonus,
            quarterlyBonus,
            kpiBonus
          } as Prisma.InputJsonValue
        }
      });

      await tx.payrollBonus.updateMany({
        where: {
          id: { in: bonuses.map((bonus) => bonus.id) }
        },
        data: {
          payrollCheckId: check.id
        }
      });
    }
  });

  await recordPayrollAudit({
    actorId: options.actorId ?? null,
    entityType: 'PayrollPeriod',
    entityId: String(period.id),
    event: 'PAYROLL_STATUS_CHANGED',
    payload: {
      action: 'recalc',
      status: period.status,
      payDate: period.payDate.toISOString()
    } as Prisma.JsonValue
  });
};

export const markPayrollPeriodStatus = async (
  periodId: number,
  status: PayrollPeriodStatus,
  actorId?: number
) => {
  const next = await prisma.payrollPeriod.update({
    where: { id: periodId },
    data: {
      status,
      approvedAt: status === 'APPROVED' ? new Date() : undefined,
      approvedById: status === 'APPROVED' ? actorId ?? null : undefined,
      paidAt: status === 'PAID' ? new Date() : undefined,
      paidById: status === 'PAID' ? actorId ?? null : undefined
    }
  });

  await recordPayrollAudit({
    actorId: actorId ?? null,
    entityType: 'PayrollPeriod',
    entityId: String(periodId),
    event: 'PAYROLL_STATUS_CHANGED',
    payload: {
      status
    } as Prisma.JsonValue
  });

  if (status === 'PAID') {
    await prisma.payrollCheck.updateMany({
      where: { periodId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paidById: actorId ?? null
      }
    });

    await prisma.payrollBonus.updateMany({
      where: {
        payrollCheck: {
          periodId
        }
      },
      data: {
        status: 'PAID',
        paidAt: new Date()
      }
    });
  }

  return next;
};

import {
  addDays,
  differenceInCalendarDays,
  differenceInMinutes,
  endOfDay,
  endOfMonth,
  startOfDay,
  startOfMonth
} from 'date-fns';
import { utcToZonedTime, zonedTimeToUtc, formatInTimeZone } from 'date-fns-tz';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { PAYROLL_TIME_ZONE, PAYROLL_ACCUMULATOR_WINDOW_DAYS, PAYROLL_MAX_MAKEUP_HOURS_PER_MONTH, type AttendanceDaySnapshot, type MonthlyAttendanceComputation, type PayrollScheduleEntry } from './types';
import { getEffectiveConfigForDate } from './config';
import { recordPayrollAudit } from './audit';

const toZoned = (date: Date) => utcToZonedTime(date, PAYROLL_TIME_ZONE);
const zonedDayStart = (date: Date) => zonedTimeToUtc(startOfDay(toZoned(date)), PAYROLL_TIME_ZONE);
const zonedDayEnd = (date: Date) => zonedTimeToUtc(endOfDay(toZoned(date)), PAYROLL_TIME_ZONE);
const zonedMonthStart = (date: Date) => zonedTimeToUtc(startOfMonth(toZoned(date)), PAYROLL_TIME_ZONE);
const zonedMonthEnd = (date: Date) => zonedTimeToUtc(endOfMonth(toZoned(date)), PAYROLL_TIME_ZONE);

const ISO_DATE = 'yyyy-MM-dd';

interface BudgetsByDay {
  [isoDate: string]: {
    pto: number;
    nonPto: number;
    makeUp: number;
  };
}

const seedBudgets = (): BudgetsByDay => ({
  default: { pto: 0, nonPto: 0, makeUp: 0 }
});

const upsertBudget = (budgets: BudgetsByDay, key: string) => {
  if (!budgets[key]) {
    budgets[key] = { pto: 0, nonPto: 0, makeUp: 0 };
  }
  return budgets[key];
};

const distributeRequestHoursByDay = (
  budgets: BudgetsByDay,
  request: { startDate: Date; endDate: Date; hours: number; type: 'pto' | 'non_pto' | 'make_up' }
) => {
  const { startDate, endDate, hours, type } = request;
  const start = zonedDayStart(startDate);
  const end = zonedDayEnd(endDate);
  const dayCount = Math.max(differenceInCalendarDays(end, start) + 1, 1);
  const hoursPerDay = hours / dayCount;

  let cursor = start;
  while (cursor <= end) {
    const iso = formatInTimeZone(cursor, PAYROLL_TIME_ZONE, ISO_DATE);
    const bucket = upsertBudget(budgets, iso);
    if (type === 'pto') bucket.pto += hoursPerDay;
    if (type === 'non_pto') bucket.nonPto += hoursPerDay;
    if (type === 'make_up') bucket.makeUp += hoursPerDay;
    cursor = addDays(cursor, 1);
  }
};

const sumMinutesByDay = (entries: Array<{ minuteStart: Date; active: boolean }>) => {
  const result = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.active) continue;
    const zoned = toZoned(entry.minuteStart);
    const iso = formatInTimeZone(zoned, PAYROLL_TIME_ZONE, ISO_DATE);
    const current = result.get(iso) ?? 0;
    result.set(iso, current + 1);
  }
  return result;
};

const earliestSessionByDay = (sessions: Array<{ startedAt: Date }>) => {
  const map = new Map<string, Date>();
  for (const session of sessions) {
    const zoned = toZoned(session.startedAt);
    const iso = formatInTimeZone(zoned, PAYROLL_TIME_ZONE, ISO_DATE);
    const current = map.get(iso);
    if (!current || session.startedAt < current) {
      map.set(iso, session.startedAt);
    }
  }
  return map;
};

const computeTardy = (
  isoDate: string,
  dayUtc: Date,
  schedule: PayrollScheduleEntry | null,
  firstSessionMap: Map<string, Date>
): number => {
  if (!schedule || !schedule.isEnabled || schedule.startMinutes == null) {
    return 0;
  }
  const firstSession = firstSessionMap.get(isoDate);
  if (!firstSession) return 0;
  const target = addMinutes(dayUtc, schedule.startMinutes);
  const diff = differenceInMinutes(firstSession, target);
  return diff > 0 ? diff : 0;
};

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

const clamp = (value: number, minValue: number, maxValue: number) => Math.min(Math.max(value, minValue), maxValue);

export const computeMonthlyAttendance = async (
  userId: number,
  referenceMonth: Date,
  tx?: Prisma.TransactionClient
): Promise<MonthlyAttendanceComputation> => {
  const client = tx ?? prisma;
  const monthStartUtc = zonedMonthStart(referenceMonth);
  const monthEndUtc = zonedMonthEnd(referenceMonth);
  const holidays = await client.payrollHoliday.findMany({
    where: {
      date: {
        gte: monthStartUtc,
        lte: monthEndUtc
      }
    }
  });
  const holidaySet = new Set<string>(
    holidays.map((holiday) => formatInTimeZone(holiday.date, PAYROLL_TIME_ZONE, ISO_DATE))
  );

  const minutes = await client.minuteStat.findMany({
    where: {
      session: {
        userId
      }
    },
    select: {
      minuteStart: true,
      active: true
    }
  });

  const sessions = await client.session.findMany({
    where: {
      userId,
      startedAt: {
        gte: monthStartUtc,
        lte: addDays(monthEndUtc, 1)
      }
    },
    select: { startedAt: true }
  });

  const activeMinutes = sumMinutesByDay(
    minutes.filter((entry) => entry.minuteStart >= monthStartUtc && entry.minuteStart <= monthEndUtc)
  );
  const firstSession = earliestSessionByDay(sessions);

  const requestsRaw = await client.timeRequest.findMany({
    where: {
      userId,
      status: 'approved',
      type: { in: ['pto', 'non_pto', 'make_up'] },
      OR: [
        {
          startDate: {
            gte: monthStartUtc,
            lte: monthEndUtc
          }
        },
        {
          endDate: {
            gte: monthStartUtc,
            lte: monthEndUtc
          }
        },
        {
          startDate: {
            lte: monthStartUtc
          },
          endDate: {
            gte: monthEndUtc
          }
        }
      ]
    },
    select: {
      startDate: true,
      endDate: true,
      hours: true,
      type: true,
      approvedAt: true
    }
  });

  const budgets = seedBudgets();
  for (const request of requestsRaw) {
    if (request.type === 'make_up') {
      if (!request.approvedAt) {
        continue;
      }
      const approvalLag = Math.abs(differenceInCalendarDays(request.approvedAt, request.startDate));
      if (approvalLag > PAYROLL_ACCUMULATOR_WINDOW_DAYS) {
        continue;
      }
    }
    const start = request.startDate < monthStartUtc ? monthStartUtc : request.startDate;
    const end = request.endDate > monthEndUtc ? monthEndUtc : request.endDate;
    const totalSpanDays = Math.max(differenceInCalendarDays(request.endDate, request.startDate) + 1, 1);
    const clampedSpanDays = Math.max(differenceInCalendarDays(end, start) + 1, 1);
    const proportionalHours = (request.hours / totalSpanDays) * clampedSpanDays;
    distributeRequestHoursByDay(budgets, {
      startDate: start,
      endDate: end,
      hours: proportionalHours,
      type: request.type as 'pto' | 'non_pto' | 'make_up'
    });
  }

  const days: AttendanceDaySnapshot[] = [];

  let cursor = monthStartUtc;
  let assignedHoursTotal = 0;
  let workedHoursTotal = 0;
  let ptoHoursTotal = 0;
  let nonPtoHoursTotal = 0;
  let tardyMinutesTotal = 0;
  let rawMakeUpHoursTotal = 0;

  while (cursor <= monthEndUtc) {
    const iso = formatInTimeZone(cursor, PAYROLL_TIME_ZONE, ISO_DATE);
    const schedule = await getEffectiveConfigForDate(userId, cursor, client);
    const dailySchedule = schedule?.schedule.find((entry) => entry.weekday === toZoned(cursor).getDay()) ?? null;
    const isHoliday = holidaySet.has(iso);

    const assignedHours = !isHoliday && dailySchedule?.isEnabled && dailySchedule.expectedHours
      ? Number(dailySchedule.expectedHours)
      : 0;

    const workedMinutes = activeMinutes.get(iso) ?? 0;
    const workedHours = Math.round((workedMinutes / 60) * 100) / 100;

    const bucket = budgets[iso] ?? budgets.default;
    const ptoHours = bucket.pto;
    const nonPtoHours = bucket.nonPto;
    const makeUpHours = bucket.makeUp;

    const tardyMinutes = computeTardy(iso, cursor, dailySchedule ?? null, firstSession);

    const notes: string[] = [];

    if (assignedHours > 0 && workedHours === 0 && !isHoliday && ptoHours === 0) {
      notes.push('No recorded work for scheduled day');
    }

    const absenceBeforeMakeup = Math.max(assignedHours - (workedHours + ptoHours + nonPtoHours), 0);
    const totalNonPtoForDay = nonPtoHours + absenceBeforeMakeup;

    assignedHoursTotal += assignedHours;
    workedHoursTotal += workedHours;
    ptoHoursTotal += ptoHours;
    nonPtoHoursTotal += totalNonPtoForDay;
    tardyMinutesTotal += tardyMinutes;
    rawMakeUpHoursTotal += makeUpHours;

    days.push({
      date: iso,
      assignedHours,
      workedHours,
      ptoHours,
      nonPtoHours: totalNonPtoForDay,
      makeUpHours,
      tardyMinutes,
      isHoliday,
      schedule: dailySchedule ?? undefined,
      notes
    });

    cursor = addDays(cursor, 1);
  }

  const matchedMakeUpHours = clamp(
    Math.min(rawMakeUpHoursTotal, nonPtoHoursTotal),
    0,
    PAYROLL_MAX_MAKEUP_HOURS_PER_MONTH
  );

  const uncoveredAfterMakeup = Math.max(nonPtoHoursTotal - matchedMakeUpHours, 0);

  const reasons: string[] = [];
  if (tardyMinutesTotal > 90) {
    reasons.push('Tardy minutes exceeded 90');
  }
  if (uncoveredAfterMakeup > 0) {
    reasons.push('Uncovered absence remaining after applying make-up hours');
  }

  const isPerfect = tardyMinutesTotal <= 90 && uncoveredAfterMakeup === 0;

  return {
    userId,
    month: monthStartUtc,
    assignedHours: Math.round(assignedHoursTotal * 100) / 100,
    workedHours: Math.round(workedHoursTotal * 100) / 100,
    ptoHours: Math.round(ptoHoursTotal * 100) / 100,
    nonPtoAbsenceHours: Math.round(nonPtoHoursTotal * 100) / 100,
    tardyMinutes: tardyMinutesTotal,
    matchedMakeUpHours: Math.round(matchedMakeUpHours * 100) / 100,
    isPerfect,
    reasons,
    days
  };
};

export interface PersistAttendanceOptions {
  finalize?: boolean;
  actorId?: number;
}

export const recalcMonthlyAttendanceFact = async (
  userId: number,
  referenceMonth: Date,
  options: PersistAttendanceOptions = {}
) => {
  const monthStartUtc = zonedMonthStart(referenceMonth);

  const computation = await computeMonthlyAttendance(userId, referenceMonth);

  const result = await prisma.payrollAttendanceFact.upsert({
    where: {
      userId_month: {
        userId,
        month: monthStartUtc
      }
    },
    update: {
      assignedHours: computation.assignedHours,
      workedHours: computation.workedHours,
      ptoHours: computation.ptoHours,
      nonPtoAbsenceHours: computation.nonPtoAbsenceHours,
      tardyMinutes: computation.tardyMinutes,
      matchedMakeUpHours: computation.matchedMakeUpHours,
      status: options.finalize ? 'FINALIZED' : 'PENDING',
      isPerfect: computation.isPerfect,
      finalizedAt: options.finalize ? new Date() : undefined,
      computedAt: new Date(),
      reasons: computation.reasons as unknown as Prisma.InputJsonValue,
      snapshot: computation.days as unknown as Prisma.InputJsonValue
    },
    create: {
      userId,
      month: monthStartUtc,
      assignedHours: computation.assignedHours,
      workedHours: computation.workedHours,
      ptoHours: computation.ptoHours,
      nonPtoAbsenceHours: computation.nonPtoAbsenceHours,
      tardyMinutes: computation.tardyMinutes,
      matchedMakeUpHours: computation.matchedMakeUpHours,
      status: options.finalize ? 'FINALIZED' : 'PENDING',
      isPerfect: computation.isPerfect,
      finalizedAt: options.finalize ? new Date() : null,
      computedAt: new Date(),
      reasons: computation.reasons as unknown as Prisma.InputJsonValue,
      snapshot: computation.days as unknown as Prisma.InputJsonValue
    }
  });

  await recordPayrollAudit({
    actorId: options.actorId ?? null,
    entityType: 'PayrollAttendanceFact',
    entityId: `${result.userId}:${result.month.toISOString()}`,
    event: 'ATTENDANCE_RECALC',
      payload: {
        status: result.status,
        isPerfect: result.isPerfect,
        tardyMinutes: result.tardyMinutes,
        matchedMakeUpHours: Number(result.matchedMakeUpHours)
      }
  });

  return result;
};

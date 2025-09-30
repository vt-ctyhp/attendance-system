import { startOfDay, endOfDay } from 'date-fns';
import { zonedTimeToUtc, utcToZonedTime } from 'date-fns-tz';
import { prisma } from '../prisma';
import { PAYROLL_TIME_ZONE } from './types';
import { recordPayrollAudit } from './audit';

const toUtcDay = (date: Date, boundary: 'start' | 'end') =>
  boundary === 'start'
    ? zonedTimeToUtc(startOfDay(utcToZonedTime(date, PAYROLL_TIME_ZONE)), PAYROLL_TIME_ZONE)
    : zonedTimeToUtc(endOfDay(utcToZonedTime(date, PAYROLL_TIME_ZONE)), PAYROLL_TIME_ZONE);

export const listHolidays = async (from: Date, to: Date) => {
  const start = toUtcDay(from, 'start');
  const end = toUtcDay(to, 'end');
  const rows = await prisma.payrollHoliday.findMany({
    where: {
      date: {
        gte: start,
        lte: end
      }
    },
    orderBy: { date: 'asc' }
  });
  return rows.map((row) => ({
    ...row,
    date: utcToZonedTime(row.date, PAYROLL_TIME_ZONE)
  }));
};

export const upsertHoliday = async (
  date: Date,
  name: string,
  isPaid: boolean,
  actorId?: number
) => {
  const utcDate = toUtcDay(date, 'start');
  const holiday = await prisma.payrollHoliday.upsert({
    where: { date: utcDate },
    update: {
      name,
      isPaid,
      createdById: actorId ?? null
    },
    create: {
      date: utcDate,
      name,
      isPaid,
      createdById: actorId ?? null
    }
  });

  await recordPayrollAudit({
    actorId: actorId ?? null,
    entityType: 'PayrollHoliday',
    entityId: utcDate.toISOString(),
    event: 'HOLIDAY_UPDATED',
    payload: {
      name,
      isPaid
    }
  });

  return holiday;
};

export const deleteHoliday = async (date: Date) => {
  const utcDate = toUtcDay(date, 'start');
  await prisma.payrollHoliday.delete({ where: { date: utcDate } });
};

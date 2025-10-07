import { addDays, eachDayOfInterval } from 'date-fns';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { prisma } from '../prisma';
import { ensureSchedule } from './payroll/config';
import { PAYROLL_TIME_ZONE } from './payroll/constants';
import { timesheetDayEnd, timesheetDayStart } from './timesheets';

type EnsureUpcomingShiftsOptions = {
  userId: number;
  windowStart: Date;
  windowEnd: Date;
};

export type ShiftGenerationSummary = {
  created: number;
  skipped: number;
};

export type ShiftGenerationAggregate = ShiftGenerationSummary & {
  usersProcessed: number;
};

const SHIFT_LABEL = 'Scheduled Shift';

export const ensureUpcomingShiftsForUser = async ({
  userId,
  windowStart,
  windowEnd
}: EnsureUpcomingShiftsOptions): Promise<ShiftGenerationSummary> => {
  const config = await prisma.employeeCompConfig.findFirst({
    where: { userId, effectiveOn: { lte: windowEnd } },
    orderBy: { effectiveOn: 'desc' }
  });

  if (!config) {
    return { created: 0, skipped: 0 };
  }

  const schedule = ensureSchedule(config.schedule);
  const timeZone = schedule.timeZone || PAYROLL_TIME_ZONE;
  const days = schedule.days;

  const existingAssignments = await prisma.shiftAssignment.findMany({
    where: {
      userId,
      startsAt: { gte: windowStart },
      endsAt: { lte: addDays(windowEnd, 1) }
    },
    select: { startsAt: true, endsAt: true }
  });

  const existingKeys = new Set(existingAssignments.map((assignment) => `${assignment.startsAt.toISOString()}-${assignment.endsAt.toISOString()}`));
  const now = new Date();
  const candidateDays = eachDayOfInterval({ start: windowStart, end: windowEnd });
  let created = 0;
  let skipped = 0;

  for (const day of candidateDays) {
    const localDay = utcToZonedTime(day, timeZone);
    const dayKey = String(localDay.getDay());
    const template = days[dayKey];

    if (!template || !template.enabled) {
      skipped += 1;
      continue;
    }

    const dateLabel = formatInTimeZone(day, timeZone, 'yyyy-MM-dd');
    const startIso = `${dateLabel}T${template.start}:00`;
    let endIsoDate = dateLabel;
    let endIso = `${endIsoDate}T${template.end}:00`;

    let startsAtUtc = zonedTimeToUtc(startIso, timeZone);
    let endsAtUtc = zonedTimeToUtc(endIso, timeZone);

    if (endsAtUtc <= startsAtUtc) {
      const nextDay = formatInTimeZone(addDays(day, 1), timeZone, 'yyyy-MM-dd');
      endIsoDate = nextDay;
      endIso = `${endIsoDate}T${template.end}:00`;
      endsAtUtc = zonedTimeToUtc(endIso, timeZone);
    }

    if (endsAtUtc <= now) {
      skipped += 1;
      continue;
    }

    const key = `${startsAtUtc.toISOString()}-${endsAtUtc.toISOString()}`;
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }

    await prisma.shiftAssignment.create({
      data: {
        userId,
        startsAt: startsAtUtc,
        endsAt: endsAtUtc,
        label: SHIFT_LABEL
      }
    });

    existingKeys.add(key);
    created += 1;
  }

  return { created, skipped };
};

export const ensureUpcomingShiftsForAllUsers = async (lookaheadDays = 14): Promise<ShiftGenerationAggregate> => {
  const now = new Date();
  const windowStart = timesheetDayStart(now);
  const windowEnd = timesheetDayEnd(addDays(now, lookaheadDays));

  const employees = await prisma.user.findMany({
    where: { role: 'employee', active: true },
    select: { id: true }
  });

  let created = 0;
  let skipped = 0;

  for (const employee of employees) {
    const summary = await ensureUpcomingShiftsForUser({
      userId: employee.id,
      windowStart,
      windowEnd
    });
    created += summary.created;
    skipped += summary.skipped;
  }

  return {
    usersProcessed: employees.length,
    created,
    skipped
  };
};

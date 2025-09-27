import { addDays, endOfDay, startOfDay, startOfMonth, endOfMonth, setDate, startOfWeek } from 'date-fns';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { prisma } from '../prisma';
import type { TimesheetView } from '../types';

const ISO_DATE = 'yyyy-MM-dd';
const ISO_LONG = "yyyy-MM-dd'T'HH:mm:ssXXX";
const DATE_LABEL = 'MMM d, yyyy';
const DEFAULT_TIME_ZONE =
  process.env.TIMESHEET_TIME_ZONE ?? process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';
const WEEK_START = (() => {
  const raw = process.env.TIMESHEET_WEEK_START;
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(Math.max(parsed, 0), 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
})();

const toZoned = (date: Date) => utcToZonedTime(date, DEFAULT_TIME_ZONE);
export const timesheetDayStart = (date: Date) => zonedTimeToUtc(startOfDay(toZoned(date)), DEFAULT_TIME_ZONE);
export const timesheetDayEnd = (date: Date) => zonedTimeToUtc(endOfDay(toZoned(date)), DEFAULT_TIME_ZONE);

const formatDate = (date: Date, pattern: string) => formatInTimeZone(date, DEFAULT_TIME_ZONE, pattern);

export type TimesheetDaySummary = {
  date: string;
  label: string;
  activeMinutes: number;
  idleMinutes: number;
  breaks: number;
  lunches: number;
  presenceMisses: number;
  editRequests: TimesheetEditRequestSummary[];
};

export type TimesheetTotals = {
  activeMinutes: number;
  activeHours: number;
  idleMinutes: number;
  idleHours: number;
  breaks: number;
  lunches: number;
  presenceMisses: number;
};

export type TimesheetEditRequestSummary = {
  id: string;
  status: string;
  targetDate: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  requestedMinutes: number | null;
  adminNote: string | null;
  reviewedAt: string | null;
};

export type TimesheetSummary = {
  view: TimesheetView;
  label: string;
  rangeStart: string;
  rangeEnd: string;
  rangeStartLabel: string;
  rangeEndLabel: string;
  totals: TimesheetTotals;
  days: TimesheetDaySummary[];
  editRequests: TimesheetEditRequestSummary[];
};

type TimesheetDayAccumulator = Omit<TimesheetDaySummary, 'editRequests'> & {
  editRequests: TimesheetEditRequestSummary[];
};

type RangeResult = {
  start: Date;
  end: Date;
  label: string;
};

export type TimesheetRange = RangeResult;

const minutesToHours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

const resolveWeeklyRange = (reference: Date): RangeResult => {
  const zonedRef = toZoned(reference);
  const weekAnchor = startOfWeek(zonedRef, { weekStartsOn: WEEK_START });
  const rangeStart = timesheetDayStart(weekAnchor);
  const rangeEnd = timesheetDayEnd(addDays(rangeStart, 6));
  const label = `${formatDate(rangeStart, DATE_LABEL)} – ${formatDate(rangeEnd, DATE_LABEL)}`;
  return { start: rangeStart, end: rangeEnd, label };
};

const resolveMonthlyRange = (reference: Date): RangeResult => {
  const zonedRef = toZoned(reference);
  const start = timesheetDayStart(startOfMonth(zonedRef));
  const end = timesheetDayEnd(endOfMonth(zonedRef));
  const label = formatDate(start, 'LLLL yyyy');
  return { start, end, label };
};

const resolvePayPeriodRange = (reference: Date): RangeResult => {
  const zonedRef = toZoned(reference);
  const dayOfMonth = zonedRef.getDate();
  const monthStart = startOfMonth(zonedRef);

  if (dayOfMonth <= 15) {
    const start = timesheetDayStart(monthStart);
    const end = timesheetDayEnd(setDate(monthStart, 15));
    const label = `${formatDate(start, DATE_LABEL)} – ${formatDate(end, DATE_LABEL)}`;
    return { start, end, label };
  }

  const secondHalfStart = setDate(monthStart, 16);
  const monthEnd = endOfMonth(monthStart);
  const start = timesheetDayStart(secondHalfStart);
  const end = timesheetDayEnd(monthEnd);
  const label = `${formatDate(start, DATE_LABEL)} – ${formatDate(end, DATE_LABEL)}`;
  return { start, end, label };
};

const resolveRange = (view: TimesheetView, reference: Date): RangeResult => {
  switch (view) {
    case 'weekly':
      return resolveWeeklyRange(reference);
    case 'monthly':
      return resolveMonthlyRange(reference);
    case 'pay_period':
    default:
      return resolvePayPeriodRange(reference);
  }
};

export const computeTimesheetRange = (view: TimesheetView, reference: Date): RangeResult => resolveRange(view, reference);
export const TIMESHEET_TIME_ZONE = DEFAULT_TIME_ZONE;

const buildEmptyDay = (date: Date): TimesheetDayAccumulator => ({
  date: formatDate(date, ISO_DATE),
  label: formatDate(date, DATE_LABEL),
  activeMinutes: 0,
  idleMinutes: 0,
  breaks: 0,
  lunches: 0,
  presenceMisses: 0,
  editRequests: []
});

export const getUserTimesheet = async (userId: number, view: TimesheetView, reference: Date): Promise<TimesheetSummary> => {
  const { start, end, label } = resolveRange(view, reference);
  const dayMap = new Map<string, TimesheetDayAccumulator>();

  const startZoned = toZoned(start);
  const endZoned = toZoned(end);
  let cursor = startZoned;
  while (cursor <= endZoned) {
    const key = formatDate(cursor, ISO_DATE);
    dayMap.set(key, buildEmptyDay(cursor));
    cursor = addDays(cursor, 1);
  }

  const sessions = await prisma.session.findMany({
    where: {
      userId,
      startedAt: { lte: end },
      OR: [{ endedAt: null }, { endedAt: { gte: start } }]
    },
    include: {
      minuteStats: {
        select: { minuteStart: true, active: true, idle: true }
      },
      events: {
        select: { ts: true, type: true }
      }
    }
  });

  const ensureDay = (date: Date) => {
    const key = formatDate(date, ISO_DATE);
    const existing = dayMap.get(key);
    if (existing) {
      return existing;
    }
    const seeded = buildEmptyDay(date);
    dayMap.set(key, seeded);
    return seeded;
  };

  for (const session of sessions) {
    for (const stat of session.minuteStats) {
      if (stat.minuteStart < start || stat.minuteStart > end) {
        continue;
      }
      const zoned = toZoned(stat.minuteStart);
      const bucket = ensureDay(zoned);
      if (stat.active) {
        bucket.activeMinutes += 1;
      }
      if (stat.idle) {
        bucket.idleMinutes += 1;
      }
    }

    for (const event of session.events) {
      if (!event.ts || event.ts < start || event.ts > end) {
        continue;
      }
      const zoned = toZoned(event.ts);
      const bucket = ensureDay(zoned);
      switch (event.type) {
        case 'break_start':
          bucket.breaks += 1;
          break;
        case 'lunch_start':
          bucket.lunches += 1;
          break;
        case 'presence_miss':
          bucket.presenceMisses += 1;
          break;
        default:
          break;
      }
    }
  }

  const editRequests = await prisma.timesheetEditRequest.findMany({
    where: {
      userId,
      view,
      periodStart: start,
      periodEnd: end
    },
    orderBy: { createdAt: 'desc' }
  });

  const requestSummaries: TimesheetEditRequestSummary[] = editRequests.map((request) => ({
    id: request.id,
    status: request.status,
    targetDate: request.targetDate.toISOString(),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    reason: request.reason,
    requestedMinutes: request.requestedMinutes ?? null,
    adminNote: request.adminNote ?? null,
    reviewedAt: request.reviewedAt ? request.reviewedAt.toISOString() : null
  }));

  for (const request of editRequests) {
    const zonedDate = toZoned(request.targetDate);
    const bucket = ensureDay(zonedDate);
    bucket.editRequests.push({
      id: request.id,
      status: request.status,
      targetDate: request.targetDate.toISOString(),
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
      reason: request.reason,
      requestedMinutes: request.requestedMinutes ?? null,
      adminNote: request.adminNote ?? null,
      reviewedAt: request.reviewedAt ? request.reviewedAt.toISOString() : null
    });
  }

  const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const totals = days.reduce<TimesheetTotals>(
    (acc, day) => ({
      activeMinutes: acc.activeMinutes + day.activeMinutes,
      activeHours: 0,
      idleMinutes: acc.idleMinutes + day.idleMinutes,
      idleHours: 0,
      breaks: acc.breaks + day.breaks,
      lunches: acc.lunches + day.lunches,
      presenceMisses: acc.presenceMisses + day.presenceMisses
    }),
    { activeMinutes: 0, activeHours: 0, idleMinutes: 0, idleHours: 0, breaks: 0, lunches: 0, presenceMisses: 0 }
  );

  totals.activeHours = minutesToHours(totals.activeMinutes);
  totals.idleHours = minutesToHours(totals.idleMinutes);

  return {
    view,
    label,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    rangeStartLabel: formatDate(start, DATE_LABEL),
    rangeEndLabel: formatDate(end, DATE_LABEL),
    totals,
    days,
    editRequests: requestSummaries
  };
};

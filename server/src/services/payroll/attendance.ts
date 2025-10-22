import { Decimal } from '@prisma/client/runtime/library';
import {
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  startOfDay
} from 'date-fns';
import {
  formatInTimeZone,
  utcToZonedTime,
  zonedTimeToUtc
} from 'date-fns-tz';
import { prisma } from '../../prisma';
import type { AttendanceMonthFact, AttendanceReviewStatus } from '@prisma/client';
import {
  MONTH_KEY_FORMAT,
  DATE_KEY_FORMAT,
  MAX_MAKEUP_HOURS_PER_MONTH,
  MAX_TARDY_MINUTES_FOR_BONUS,
  PAYROLL_TIME_ZONE
} from './constants';
import {
  ensureSchedule,
  getAllConfigsThrough,
  resolveActiveConfigForRange,
  type WeekdaySchedule
} from './config';
import type { EmployeeCompSnapshot } from './config';
import type { TimeRequest } from '@prisma/client';

export type AttendanceDayDetail = {
  date: string;
  expectedHours: number;
  workedHours: number;
  ptoHours: number;
  utoHours: number;
  makeUpHours: number;
  tardyMinutes: number;
  holiday: boolean;
  notes: string[];
};

export type AttendanceFactSnapshot = {
  monthKey: string;
  rangeStart: string;
  rangeEnd: string;
  days: AttendanceDayDetail[];
  holidayCount: number;
  makeUpRequests: Array<{ id: string; start: string; end: string; hours: number }>;
};

const parseMonthKey = (monthKey: string) => {
  const [yearRaw, monthRaw] = monthKey.split('-');
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  const paddedMonth = monthRaw.padStart(2, '0');
  const monthStartUtc = zonedTimeToUtc(`${yearRaw}-${paddedMonth}-01T00:00:00`, PAYROLL_TIME_ZONE);
  const monthStartZoned = utcToZonedTime(monthStartUtc, PAYROLL_TIME_ZONE);
  const rangeStart = zonedTimeToUtc(startOfDay(monthStartZoned), PAYROLL_TIME_ZONE);
  const rangeEnd = zonedTimeToUtc(endOfDay(endOfMonth(monthStartZoned)), PAYROLL_TIME_ZONE);
  return { rangeStart, rangeEnd };
};

export const getMonthKeyForDate = (date: Date) =>
  formatInTimeZone(date, PAYROLL_TIME_ZONE, MONTH_KEY_FORMAT);

export const getPayrollDayBounds = (date: Date) => {
  const zoned = utcToZonedTime(date, PAYROLL_TIME_ZONE);
  const dayStart = zonedTimeToUtc(startOfDay(zoned), PAYROLL_TIME_ZONE);
  const dayEnd = zonedTimeToUtc(endOfDay(zoned), PAYROLL_TIME_ZONE);
  return { start: dayStart, end: dayEnd };
};

const buildDayKey = (date: Date) => formatInTimeZone(date, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT);

const toHours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

const sumDayHours = (requests: TimeRequest[], start: Date, end: Date) => {
  const pto = new Map<string, number>();
  const uto = new Map<string, number>();
  const makeUp = new Map<string, number>();
  const requestSummaries: AttendanceFactSnapshot['makeUpRequests'] = [];

  for (const request of requests) {
    const overlapStart = request.startDate > start ? request.startDate : start;
    const overlapEnd = request.endDate < end ? request.endDate : end;
    if (overlapEnd < overlapStart) continue;

    const days = eachDayOfInterval({ start: overlapStart, end: overlapEnd });
    const perDay = request.hours / Math.max(days.length, 1);
    const targetMap =
      request.type === 'pto' ? pto : request.type === 'uto' ? uto : makeUp;

    for (const day of days) {
      const key = buildDayKey(day);
      const existing = targetMap.get(key) ?? 0;
      targetMap.set(key, Math.round((existing + perDay) * 100) / 100);
    }

    if (request.type === 'make_up') {
      requestSummaries.push({
        id: request.id,
        start: formatInTimeZone(overlapStart, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
        end: formatInTimeZone(overlapEnd, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
        hours: request.hours
      });
    }
  }

  return { pto, uto, makeUp, requestSummaries };
};

const buildScheduleLookup = (config: EmployeeCompSnapshot | null, weekday: number) => {
  if (!config) return null;
  const normalized = ensureSchedule(config.schedule);
  const key = String(weekday) as keyof typeof normalized.days;
  return normalized.days[key] ?? null;
};

const computeTardyMinutes = (scheduledStart: string, actualStart: Date) => {
  const [hours, minutes] = scheduledStart.split(':').map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  const zoned = utcToZonedTime(actualStart, PAYROLL_TIME_ZONE);
  const scheduled = new Date(zoned);
  scheduled.setHours(hours, minutes, 0, 0);
  const tardy = differenceInCalendarDays(zoned, scheduled) !== 0
    ? 0
    : Math.max(0, Math.round((zoned.getTime() - scheduled.getTime()) / 60000));
  return tardy;
};

const collectFirstStarts = async (userIds: number[], start: Date, end: Date) => {
  if (!userIds.length) return new Map<number, Map<string, Date>>();
  const sessions = await prisma.session.findMany({
    where: {
      userId: { in: userIds },
      startedAt: { lte: end },
      OR: [{ endedAt: null }, { endedAt: { gte: start } }]
    },
    select: { userId: true, startedAt: true }
  });

  const map = new Map<number, Map<string, Date>>();
  for (const session of sessions) {
    const key = buildDayKey(session.startedAt);
    let userMap = map.get(session.userId);
    if (!userMap) {
      userMap = new Map();
      map.set(session.userId, userMap);
    }
    const existing = userMap.get(key);
    if (!existing || session.startedAt < existing) {
      userMap.set(key, session.startedAt);
    }
  }
  return map;
};

const collectWorkedMinutes = async (userIds: number[], start: Date, end: Date) => {
  if (!userIds.length) return new Map<string, number>();
  const stats = await prisma.minuteStat.findMany({
    where: {
      minuteStart: { gte: start, lte: end },
      session: { userId: { in: userIds } }
    },
    select: { minuteStart: true, active: true, idle: true, session: { select: { userId: true } } }
  });

  const map = new Map<string, number>();
  for (const stat of stats) {
    const worked = stat.active || stat.idle ? 1 : 0;
    if (!worked) continue;
    const key = `${stat.session.userId}:${buildDayKey(stat.minuteStart)}`;
    const existing = map.get(key) ?? 0;
    map.set(key, existing + worked);
  }
  return map;
};

const collectApprovedRequests = async (userIds: number[], start: Date, end: Date) => {
  if (!userIds.length) return [] as TimeRequest[];
  const requests = await prisma.timeRequest.findMany({
    where: {
      userId: { in: userIds },
      status: 'approved',
      startDate: { lte: end },
      endDate: { gte: start }
    }
  });
  return requests;
};

const collectHolidays = async (start: Date, end: Date) => {
  const holidays = await prisma.holiday.findMany({
    where: { observedOn: { gte: start, lte: end } }
  });
  const set = new Set<string>();
  for (const holiday of holidays) {
    set.add(buildDayKey(holiday.observedOn));
  }
  return set;
};

const mapRequestsByUser = (requests: TimeRequest[]) => {
  const map = new Map<number, TimeRequest[]>();
  for (const request of requests) {
    const bucket = map.get(request.userId);
    if (bucket) {
      bucket.push(request);
    } else {
      map.set(request.userId, [request]);
    }
  }
  return map;
};

export const recalcMonthlyAttendanceFacts = async (
  monthKey: string,
  actorId?: number,
  userIds?: number[]
) => {
  const { rangeStart, rangeEnd } = parseMonthKey(monthKey);
  const where: { active: true; id?: { in: number[] } } | { active: true } = userIds && userIds.length
    ? { active: true, id: { in: userIds } }
    : { active: true };
  const users = await prisma.user.findMany({ where });
  if (!users.length) {
    return [] as AttendanceMonthFact[];
  }
  const targetUserIds = users.map((user) => user.id);
  const [firstStarts, workedMinutesMap, requests, holidays] = await Promise.all([
    collectFirstStarts(targetUserIds, rangeStart, rangeEnd),
    collectWorkedMinutes(targetUserIds, rangeStart, rangeEnd),
    collectApprovedRequests(targetUserIds, rangeStart, rangeEnd),
    collectHolidays(rangeStart, rangeEnd)
  ]);

  const requestsByUser = mapRequestsByUser(requests);

  const results: AttendanceMonthFact[] = [];

  for (const user of users) {
    const configs = await getAllConfigsThrough(user.id, rangeEnd);
    const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });
    const dayDetails: AttendanceDayDetail[] = [];
    let assignedHours = 0;
    let workedHours = 0;
    let ptoHours = 0;
    let tardyMinutes = 0;

    const userRequests = requestsByUser.get(user.id) ?? [];
    const { pto, uto, makeUp, requestSummaries } = sumDayHours(
      userRequests,
      rangeStart,
      rangeEnd
    );

    const absenceLedger: Array<{ date: Date; remaining: number }> = [];

    for (const day of days) {
      const dayKey = buildDayKey(day);
      const zoned = utcToZonedTime(day, PAYROLL_TIME_ZONE);
      const weekday = zoned.getDay();
      const config = resolveActiveConfigForRange(configs, day);
      const schedule = buildScheduleLookup(config, weekday);
      const detail: AttendanceDayDetail = {
        date: dayKey,
        expectedHours: 0,
        workedHours: 0,
        ptoHours: 0,
        utoHours: 0,
        makeUpHours: 0,
        tardyMinutes: 0,
        holiday: holidays.has(dayKey),
        notes: []
      };

      if (config && schedule && schedule.enabled && !detail.holiday) {
        detail.expectedHours = Math.round(schedule.expectedHours * 100) / 100;
        assignedHours += detail.expectedHours;
      }

      const workedKey = `${user.id}:${dayKey}`;
      const workedMinutes = workedMinutesMap.get(workedKey) ?? 0;
      if (workedMinutes > 0) {
        detail.workedHours = toHours(workedMinutes);
        workedHours += detail.workedHours;
      }

      const ptoDayHours = pto.get(dayKey) ?? 0;
      if (ptoDayHours > 0) {
        detail.ptoHours = Math.round(ptoDayHours * 100) / 100;
        ptoHours += detail.ptoHours;
        detail.notes.push('PTO');
      }

      const utoDayHours = uto.get(dayKey) ?? 0;
      if (utoDayHours > 0) {
        detail.utoHours = Math.round(utoDayHours * 100) / 100;
        detail.notes.push('UTO Request');
      }

      const makeUpDayHours = makeUp.get(dayKey) ?? 0;
      if (makeUpDayHours > 0) {
        detail.makeUpHours = Math.round(makeUpDayHours * 100) / 100;
        detail.notes.push('Make-up');
      }

      const start = firstStarts.get(user.id)?.get(dayKey);
      if (schedule && schedule.enabled && start) {
        const tardy = computeTardyMinutes(schedule.start, start);
        if (tardy > 0) {
          detail.tardyMinutes = tardy;
          tardyMinutes += tardy;
        }
      }

      if (detail.tardyMinutes > 0 && (detail.ptoHours > 0 || detail.holiday)) {
        tardyMinutes -= detail.tardyMinutes;
        detail.tardyMinutes = 0;
      }

      const deficit = Math.max(
        detail.expectedHours -
          (detail.workedHours + detail.ptoHours + detail.utoHours + detail.makeUpHours),
        0
      );
      if (deficit > 0) {
        absenceLedger.push({ date: day, remaining: deficit });
        detail.notes.push('Absence');
      }

      dayDetails.push(detail);
    }

    let matchedMakeUpHours = 0;
    if (userRequests.length) {
      const makeUpRequests = userRequests.filter((request) => request.type === 'make_up');
      makeUpRequests.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

      for (const request of makeUpRequests) {
        let hoursRemaining = request.hours;
        const requestDay = request.startDate;
        for (const entry of absenceLedger) {
          const diffDays = Math.abs(
            differenceInCalendarDays(
              utcToZonedTime(entry.date, PAYROLL_TIME_ZONE),
              utcToZonedTime(requestDay, PAYROLL_TIME_ZONE)
            )
          );
          if (diffDays > 14) continue;
          if (entry.remaining <= 0) continue;
          if (hoursRemaining <= 0) break;

          const applied = Math.min(entry.remaining, hoursRemaining);
          entry.remaining = Math.round((entry.remaining - applied) * 100) / 100;
          hoursRemaining = Math.round((hoursRemaining - applied) * 100) / 100;
          matchedMakeUpHours += applied;
          if (matchedMakeUpHours >= MAX_MAKEUP_HOURS_PER_MONTH) {
            matchedMakeUpHours = MAX_MAKEUP_HOURS_PER_MONTH;
            break;
          }
        }
        if (matchedMakeUpHours >= MAX_MAKEUP_HOURS_PER_MONTH) break;
      }
    }

    matchedMakeUpHours = Math.round(
      Math.min(matchedMakeUpHours, MAX_MAKEUP_HOURS_PER_MONTH) * 100
    ) / 100;

    const residualAbsence = Math.round(
      absenceLedger.reduce((acc, entry) => acc + Math.max(entry.remaining, 0), 0) * 100
    ) / 100;
    const utoAbsenceHours = residualAbsence;

    const uncoveredAbsence = Math.max(
      assignedHours - (workedHours + ptoHours + matchedMakeUpHours),
      0
    );
    const isPerfect =
      tardyMinutes <= MAX_TARDY_MINUTES_FOR_BONUS && uncoveredAbsence < 0.01;

    const snapshot: AttendanceFactSnapshot = {
      monthKey,
      rangeStart: formatInTimeZone(rangeStart, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
      rangeEnd: formatInTimeZone(rangeEnd, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
      days: dayDetails,
      holidayCount: dayDetails.filter((detail) => detail.holiday).length,
      makeUpRequests: requestSummaries
    };

    const reasons = dayDetails
      .filter((detail) => detail.notes.length > 0)
      .map((detail) => ({ date: detail.date, notes: detail.notes }));

    const createReviewFields = isPerfect
      ? {
          reviewStatus: 'resolved' as AttendanceReviewStatus,
          reviewNotes: null,
          reviewedAt: null,
          reviewedById: null
        }
      : {
          reviewStatus: 'pending' as AttendanceReviewStatus,
          reviewNotes: null,
          reviewedAt: null,
          reviewedById: null
        };

    const updateReviewFields = isPerfect
      ? {
          reviewStatus: 'resolved' as AttendanceReviewStatus,
          reviewNotes: null,
          reviewedAt: null,
          reviewedById: null
        }
      : {
          reviewStatus: 'pending' as AttendanceReviewStatus,
          reviewedAt: null,
          reviewedById: null
        };

    const fact = await prisma.attendanceMonthFact.upsert({
      where: { userId_monthKey: { userId: user.id, monthKey } },
      create: {
        userId: user.id,
        monthKey,
        rangeStart,
        rangeEnd,
        assignedHours: new Decimal(Math.round(assignedHours * 100) / 100),
        workedHours: new Decimal(Math.round(workedHours * 100) / 100),
        ptoHours: new Decimal(Math.round(ptoHours * 100) / 100),
        utoAbsenceHours: new Decimal(Math.round(utoAbsenceHours * 100) / 100),
        tardyMinutes,
        matchedMakeUpHours: new Decimal(matchedMakeUpHours),
        isPerfect,
        reasons,
        snapshot,
        ...createReviewFields
      },
      update: {
        rangeStart,
        rangeEnd,
        assignedHours: new Decimal(Math.round(assignedHours * 100) / 100),
        workedHours: new Decimal(Math.round(workedHours * 100) / 100),
        ptoHours: new Decimal(Math.round(ptoHours * 100) / 100),
        utoAbsenceHours: new Decimal(Math.round(utoAbsenceHours * 100) / 100),
        tardyMinutes,
        matchedMakeUpHours: new Decimal(matchedMakeUpHours),
        isPerfect,
        reasons,
        snapshot,
        computedAt: new Date(),
        ...updateReviewFields
      }
    });

    results.push(fact);

    if (actorId) {
      await prisma.payrollAuditLog.create({
        data: {
          actorId,
          scope: 'attendance',
          target: `${user.id}:${monthKey}`,
          action: 'recalc',
          details: {
            assignedHours,
            workedHours,
            ptoHours,
            matchedMakeUpHours,
            tardyMinutes,
            isPerfect
          }
        }
      });
    }
  }

  return results;
};

export const listAttendanceFactsForMonth = async (monthKey: string) => {
  const { rangeStart, rangeEnd } = parseMonthKey(monthKey);
  const facts = await prisma.attendanceMonthFact.findMany({
    where: { monthKey },
    include: {
      user: { select: { id: true, name: true, email: true } },
      reviewedBy: { select: { id: true, name: true, email: true } }
    },
    orderBy: { userId: 'asc' }
  });
  return { rangeStart, rangeEnd, facts };
};

export const getAttendanceFactForUser = async (monthKey: string, userId: number) => {
  return prisma.attendanceMonthFact.findUnique({
    where: { userId_monthKey: { monthKey, userId } },
    include: {
      user: { select: { id: true, name: true, email: true } },
      reviewedBy: { select: { id: true, name: true, email: true } }
    }
  });
};

export const updateAttendanceReviewStatus = async (
  monthKey: string,
  userId: number,
  status: AttendanceReviewStatus,
  notes: string | null,
  reviewerId: number
) => {
  const resolved = status === 'resolved';
  const updated = await prisma.attendanceMonthFact.update({
    where: { userId_monthKey: { monthKey, userId } },
    data: {
      reviewStatus: status,
      reviewNotes: notes,
      reviewedAt: resolved ? new Date() : null,
      reviewedById: resolved ? reviewerId : null
    },
    include: {
      user: { select: { id: true, name: true, email: true } },
      reviewedBy: { select: { id: true, name: true, email: true } }
    }
  });
  return updated;
};

export const countPendingReviewsForMonth = async (monthKey: string) => {
  return prisma.attendanceMonthFact.count({
    where: { monthKey, reviewStatus: 'pending' }
  });
};

export const isAttendanceMonthLocked = async (monthKey: string) => {
  const periodKeys = [`${monthKey}-A`, `${monthKey}-B`];
  const periods = await prisma.payrollPeriod.findMany({
    where: { periodKey: { in: periodKeys } },
    select: { periodKey: true, status: true }
  });
  return periods.some((period) => period.status === 'paid');
};

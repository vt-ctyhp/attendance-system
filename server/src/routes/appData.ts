import { Router } from 'express';
import { addDays, addMinutes, differenceInMinutes } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../errors';
import { parseWithSchema } from '../utils/validation';
import {
  TIMESHEET_TIME_ZONE,
  getUserTimesheet,
  timesheetDayEnd,
  timesheetDayStart
} from '../services/timesheets';
import {
  getApprovedMakeupHoursThisMonth,
  getMakeupCapHoursPerMonth
} from '../services/timeRequestPolicy';

const overviewQuerySchema = z.object({
  email: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.toLowerCase())
});

const formatDate = (date: Date, pattern: string) => formatInTimeZone(date, TIMESHEET_TIME_ZONE, pattern);

const isoDate = (date: Date) => formatDate(date, 'yyyy-MM-dd');
const dayLabel = (date: Date) => formatDate(date, 'EEE, MMM d');
const longDate = (date: Date) => formatDate(date, 'LLLL d, yyyy');

const roundHours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const MINUTE_MS = 60_000;

type IdleActivity = { id: string; timestamp: string; message: string; category: 'idle' };

const buildIdleActivities = (
  minuteStats: Array<{ minuteStart: Date; idle: boolean }>,
  pauses: Array<{ startedAt: Date; endedAt: Date | null }>,
  reference: Date
): IdleActivity[] => {
  if (!minuteStats.length) {
    return [];
  }

  const pauseWindows = pauses
    .map((pause) => ({ start: pause.startedAt, end: pause.endedAt ?? reference }))
    .filter((window) => window.end.getTime() > window.start.getTime());

  const isDuringPause = (minuteStart: Date) =>
    pauseWindows.some((pause) => minuteStart >= pause.start && minuteStart < pause.end);

  const sortedIdleMinutes = minuteStats
    .filter((stat) => stat.idle)
    .sort((a, b) => a.minuteStart.getTime() - b.minuteStart.getTime());

  if (!sortedIdleMinutes.length) {
    return [];
  }

  const activities: IdleActivity[] = [];

  let streakStart: Date | null = null;
  let streakEnd: Date | null = null;
  let streakMinutes = 0;

  const flushStreak = () => {
    if (!streakStart || !streakEnd || streakMinutes <= 0) {
      streakStart = null;
      streakEnd = null;
      streakMinutes = 0;
      return;
    }

    const minutesLabel = streakMinutes === 1 ? '1 minute' : `${streakMinutes} minutes`;
    const rangeLabel = `${formatDate(streakStart, 'h:mm a')} – ${formatDate(streakEnd, 'h:mm a')}`;

    activities.push({
      id: `idle-${streakStart.toISOString()}`,
      timestamp: streakEnd.toISOString(),
      message: `Idle from ${rangeLabel} (${minutesLabel}).`,
      category: 'idle'
    });

    streakStart = null;
    streakEnd = null;
    streakMinutes = 0;
  };

  for (const stat of sortedIdleMinutes) {
    if (isDuringPause(stat.minuteStart)) {
      flushStreak();
      continue;
    }

    const minuteEnd = new Date(stat.minuteStart.getTime() + MINUTE_MS);

    if (!streakStart || !streakEnd) {
      streakStart = stat.minuteStart;
      streakEnd = minuteEnd;
      streakMinutes = 1;
      continue;
    }

    if (stat.minuteStart.getTime() === streakEnd.getTime()) {
      streakEnd = minuteEnd;
      streakMinutes += 1;
      continue;
    }

    flushStreak();
    streakStart = stat.minuteStart;
    streakEnd = minuteEnd;
    streakMinutes = 1;
  }

  flushStreak();

  return activities;
};

const toTimesheetPeriod = async (userId: number, view: 'weekly' | 'pay_period' | 'monthly', reference: Date) => {
  const summary = await getUserTimesheet(userId, view, reference);
  return {
    label: summary.label,
    range: `${summary.rangeStartLabel} – ${summary.rangeEndLabel}`,
    days: summary.days.map((day) => ({
      date: day.date,
      label: day.label,
      activeHours: roundHours(day.activeMinutes),
      idleHours: roundHours(day.idleMinutes),
      breaks: day.breaks,
      lunches: day.lunches,
      presenceMisses: day.presenceMisses
    })),
    totals: {
      activeHours: Math.round(summary.totals.activeHours * 100) / 100,
      idleHours: Math.round(summary.totals.idleHours * 100) / 100,
      breaks: summary.totals.breaks,
      lunches: summary.totals.lunches,
      presenceMisses: summary.totals.presenceMisses
    }
  };
};

const resolveSessionStatus = (session: Prisma.SessionGetPayload<{ include: { pauses: true; events: true } }> | null) => {
  if (!session) {
    return {
      status: 'clocked_out' as const,
      startedAt: null,
      breakStartedAt: null,
      lunchStartedAt: null,
      lastPresenceCheck: null,
      nextPresenceCheck: null,
      lastClockedInAt: null,
      lastClockedOutAt: null
    };
  }

  const activePause = session.pauses.find((pause) => !pause.endedAt);
  const presenceEvent = session.events.find((event) => event.type.startsWith('presence_'));

  const baseStatus: 'clocked_out' | 'working' | 'break' | 'lunch' = (() => {
    if (session.endedAt) {
      return 'clocked_out';
    }
    if (activePause?.type === 'break') {
      return 'break';
    }
    if (activePause?.type === 'lunch') {
      return 'lunch';
    }
    return 'working';
  })();

  const lastPresenceCheck = presenceEvent ? presenceEvent.ts : null;
  const nextPresenceCheck = session.endedAt
    ? null
    : addMinutes(lastPresenceCheck ?? session.startedAt, 45);

  return {
    status: baseStatus,
    startedAt: baseStatus === 'clocked_out' ? null : session.startedAt,
    breakStartedAt: baseStatus === 'break' ? activePause?.startedAt ?? null : null,
    lunchStartedAt: baseStatus === 'lunch' ? activePause?.startedAt ?? null : null,
    lastPresenceCheck,
    nextPresenceCheck,
    lastClockedInAt: session.startedAt,
    lastClockedOutAt: session.endedAt ?? null
  };
};

const buildSchedule = (sessionStatus: ReturnType<typeof resolveSessionStatus>) => {
  const now = new Date();
  const defaults = [
    { label: 'Mon – Fri', start: '09:00', end: '17:30' },
    { label: 'Sat', start: '10:00', end: '16:00' }
  ];

  const upcoming = Array.from({ length: 4 }).map((_, index) => {
    const date = addDays(now, index);
    const label = index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : dayLabel(date);
    const status = index === 0
      ? sessionStatus.status === 'clocked_out'
        ? 'completed'
        : 'in_progress'
      : 'upcoming';
    return {
      id: `shift-${isoDate(date)}`,
      date: isoDate(date),
      label,
      start: index === 0 ? '09:00' : '11:00',
      end: index === 0 ? '17:30' : '19:00',
      status
    };
  });

  return { defaults, upcoming };
};

const mapRequestType = (type: string): 'make_up' | 'time_off' | 'edit' => {
  if (type === 'make_up') {
    return 'make_up';
  }
  if (type === 'timesheet_edit') {
    return 'edit';
  }
  return 'time_off';
};

const toRequestItem = (request: {
  id: string;
  type: string;
  status: string;
  startDate: Date;
  endDate: Date;
  hours: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: request.id,
  type: mapRequestType(request.type),
  status: request.status as 'pending' | 'approved' | 'denied',
  startDate: request.startDate.toISOString(),
  endDate: request.endDate.toISOString(),
  hours: Math.round(request.hours * 100) / 100,
  reason: request.reason ?? 'No reason provided.',
  submittedAt: request.createdAt.toISOString()
});

const eventToActivity = (event: { id: string; ts: Date; type: string }) => {
  let category: 'session' | 'presence' | 'break' | 'lunch' = 'session';
  let message = `Event: ${event.type.replace(/_/g, ' ')}`;

  if (event.type === 'presence_miss') {
    category = 'presence';
    message = 'Missed presence check while on shift.';
  } else if (event.type === 'presence_confirmed') {
    category = 'presence';
    message = 'Presence confirmed from desktop client.';
  } else if (event.type === 'break_started') {
    category = 'break';
    message = 'Break started.';
  } else if (event.type === 'lunch_started') {
    category = 'lunch';
    message = 'Lunch started.';
  }

  return {
    id: event.id,
    timestamp: event.ts.toISOString(),
    message,
    category
  };
};

const requestToActivity = (request: {
  id: string;
  type: string;
  status: string;
  updatedAt: Date;
  startDate: Date;
  endDate: Date;
}) => {
  const typeLabel = mapRequestType(request.type).replace('_', ' ');
  return {
    id: `request-${request.id}`,
    timestamp: request.updatedAt.toISOString(),
    message: `${typeLabel} request ${request.status}`,
    category: 'request' as const
  };
};

export const getAppOverview = asyncHandler(async (req, res) => {
    const { email } = parseWithSchema(overviewQuerySchema, req.query, 'Invalid query parameters');

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } }
    });

    if (!user) {
      throw HttpError.notFound('User not found');
    }

    const [latestSession] = await prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { startedAt: 'desc' },
      take: 1,
      include: {
        pauses: { orderBy: { sequence: 'asc' } },
        events: { orderBy: { ts: 'desc' } }
      }
    });

    const previousCompleted = latestSession?.endedAt
      ? latestSession
      : await prisma.session.findFirst({
          where: { userId: user.id, endedAt: { not: null } },
          orderBy: { endedAt: 'desc' }
        });

    const sessionStatus = resolveSessionStatus(latestSession ?? null);
    const lastClockedOutAt = previousCompleted?.endedAt ?? null;
    const activeSessionId = !latestSession || latestSession.status !== 'active' ? null : latestSession.id;

    const now = new Date();
    const todayStart = timesheetDayStart(now);
    const todayEnd = timesheetDayEnd(now);

    const minuteStats = await prisma.minuteStat.findMany({
      where: {
        session: { userId: user.id },
        minuteStart: { gte: todayStart, lt: todayEnd }
      },
      select: { minuteStart: true, active: true, idle: true }
    });

    const pauses = await prisma.sessionPause.findMany({
      where: {
        session: { userId: user.id },
        startedAt: { gte: todayStart, lt: todayEnd }
      },
      select: { type: true, durationMinutes: true, startedAt: true, endedAt: true }
    });

    const presenceMisses = await prisma.event.count({
      where: {
        session: { userId: user.id },
        type: 'presence_miss',
        ts: { gte: todayStart, lt: todayEnd }
      }
    });

    const breakMinutes = pauses
      .filter((pause) => pause.type === 'break')
      .reduce((total, pause) => {
        if (typeof pause.durationMinutes === 'number') {
          return total + pause.durationMinutes;
        }
        const end = pause.endedAt ?? now;
        return total + Math.max(0, differenceInMinutes(end, pause.startedAt));
      }, 0);

    const lunchMinutes = pauses
      .filter((pause) => pause.type === 'lunch')
      .reduce((total, pause) => {
        if (typeof pause.durationMinutes === 'number') {
          return total + pause.durationMinutes;
        }
        const end = pause.endedAt ?? now;
        return total + Math.max(0, differenceInMinutes(end, pause.startedAt));
      }, 0);

    const todaySnapshot = {
      date: isoDate(now),
      label: dayLabel(now),
      activeMinutes: minuteStats.filter((stat) => stat.active).length,
      idleMinutes: minuteStats.filter((stat) => stat.idle).length,
      breakMinutes,
      lunchMinutes,
      breaksCount: pauses.filter((pause) => pause.type === 'break').length,
      lunchCount: pauses.filter((pause) => pause.type === 'lunch').length,
      presenceMisses
    };

    const [weekly, payPeriod, monthly] = await Promise.all([
      toTimesheetPeriod(user.id, 'weekly', now),
      toTimesheetPeriod(user.id, 'pay_period', now),
      toTimesheetPeriod(user.id, 'monthly', now)
    ]);

    const requests = await prisma.timeRequest.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    const requestItems = requests.map(toRequestItem);

    const [events, cap, usedHours] = await Promise.all([
      prisma.event.findMany({
        where: { session: { userId: user.id } },
        orderBy: { ts: 'desc' },
        take: 10
      }),
      getMakeupCapHoursPerMonth(),
      getApprovedMakeupHoursThisMonth(prisma, user.id)
    ]);

    const idleActivities = buildIdleActivities(minuteStats, pauses, now);

    const activity = [
      ...events.map(eventToActivity),
      ...requests.map(requestToActivity),
      ...idleActivities
    ]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 12);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        location: user.role === 'manager' ? 'Market Street HQ' : 'San Francisco Retail Floor'
      },
      session: {
        ...sessionStatus,
        id: activeSessionId,
        lastClockedOutAt
      },
      today: todaySnapshot,
      timesheet: {
        view: 'weekly' as const,
        periods: {
          weekly,
          pay_period: payPeriod,
          monthly
        }
      },
      requests: requestItems,
      schedule: buildSchedule(sessionStatus),
      activity,
      makeUpCap: {
        used: Math.round(usedHours * 100) / 100,
        cap
      },
      meta: {
        generatedAt: new Date().toISOString(),
        referenceDate: longDate(now)
      }
    });
  });

export const appDataRouter = Router();

appDataRouter.get('/overview', getAppOverview);

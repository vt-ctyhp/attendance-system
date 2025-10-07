import { addDays } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../prisma';
import { ensureSchedule, type EmployeeSchedule } from './payroll/config';
import { ensureUpcomingShiftsForUser } from './shiftPlanner';

type DbShift = {
  id: number;
  userId: number;
  startsAt: Date;
  endsAt: Date;
  label: string | null;
};

type TimeRequestRecord = Awaited<ReturnType<typeof prisma.timeRequest.findMany>>[number];
import { TIMESHEET_TIME_ZONE, timesheetDayEnd, timesheetDayStart } from './timesheets';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const DEFAULT_LOOKAHEAD_DAYS = 14;
const DEFAULT_UPCOMING_LIMIT = 6;

const formatDate = (date: Date, pattern: string) => formatInTimeZone(date, TIMESHEET_TIME_ZONE, pattern);
const isoDate = (date: Date) => formatDate(date, 'yyyy-MM-dd');
const dayLabel = (date: Date) => formatDate(date, 'EEE, MMM d');
const formatTime = (date: Date) => formatDate(date, 'HH:mm');

type ScheduleTemplate = {
  label: string;
  start: string;
  end: string;
};

const buildScheduleDefaults = (schedule: EmployeeSchedule): ScheduleTemplate[] => {
  const groups: Array<{ startIndex: number; endIndex: number; start: string; end: string }> = [];
  let current: { startIndex: number; endIndex: number; start: string; end: string } | null = null;

  for (let i = 0; i < WEEKDAY_LABELS.length; i += 1) {
    const dayKey = String(i) as keyof EmployeeSchedule['days'];
    const day = schedule.days[dayKey];
    const enabled = day?.enabled ?? false;

    if (!enabled) {
      if (current) {
        groups.push(current);
        current = null;
      }
      continue;
    }

    const start = day.start;
    const end = day.end;

    if (!current) {
      current = { startIndex: i, endIndex: i, start, end };
      continue;
    }

    const isConsecutive = current.endIndex === i - 1;
    const matchesHours = current.start === start && current.end === end;
    if (isConsecutive && matchesHours) {
      current.endIndex = i;
    } else {
      groups.push(current);
      current = { startIndex: i, endIndex: i, start, end };
    }
  }

  if (current) {
    groups.push(current);
  }

  return groups.map(({ startIndex, endIndex, start, end }) => {
    const label = startIndex === endIndex
      ? WEEKDAY_LABELS[startIndex]
      : `${WEEKDAY_LABELS[startIndex]} – ${WEEKDAY_LABELS[endIndex]}`;
    return { label, start, end };
  });
};

export type ScheduleEntryKind = 'shift' | 'pto' | 'uto' | 'make_up';

export type ScheduleSessionStatus = { status: 'clocked_out' | 'working' | 'break' | 'lunch' };

type ScheduleSourceEntry = {
  id: string;
  kind: ScheduleEntryKind;
  startsAt: Date;
  endsAt: Date;
  label?: string | null;
  displayLabel?: string | null;
};

type BuildOptions = {
  userId: number;
  sessionStatus: ScheduleSessionStatus;
  reference?: Date;
  limit?: number;
  lookaheadDays?: number;
};

type ScheduleEntry = {
  id: string;
  date: string;
  label: string;
  start: string;
  end: string;
  status: 'upcoming' | 'in_progress' | 'completed';
  kind?: ScheduleEntryKind;
  displayLabel?: string;
};

const KIND_LABELS: Record<ScheduleEntryKind, string> = {
  shift: 'Shift',
  pto: 'PTO',
  uto: 'Unpaid Time Off',
  make_up: 'Make-up Hours'
};

const relativeLabel = (reference: Date, target: Date) => {
  const referenceIso = isoDate(reference);
  const targetIso = isoDate(target);

  if (referenceIso === targetIso) {
    return 'Today';
  }

  const tomorrowIso = isoDate(addDays(reference, 1));
  if (tomorrowIso === targetIso) {
    return 'Tomorrow';
  }

  return dayLabel(target);
};

const determineStatus = (
  entry: ScheduleSourceEntry,
  index: number,
  sessionStatus: ScheduleSessionStatus,
  reference: Date
): 'upcoming' | 'in_progress' | 'completed' => {
  const nowMs = reference.getTime();
  const startMs = entry.startsAt.getTime();
  const endMs = entry.endsAt.getTime();

  if (entry.kind === 'shift') {
    if (isoDate(entry.startsAt) === isoDate(reference) && index === 0) {
      return sessionStatus.status === 'clocked_out' ? 'completed' : 'in_progress';
    }

    if (endMs <= nowMs) {
      return 'completed';
    }

    if (startMs <= nowMs && nowMs < endMs) {
      return sessionStatus.status === 'clocked_out' ? 'completed' : 'in_progress';
    }

    return 'upcoming';
  }

  if (endMs <= nowMs) {
    return 'completed';
  }

  if (startMs <= nowMs && nowMs < endMs) {
    return 'in_progress';
  }

  return 'upcoming';
};

const buildScheduleEntries = (
  entries: ScheduleSourceEntry[],
  sessionStatus: ScheduleSessionStatus,
  reference: Date,
  limit: number
): ScheduleEntry[] => {
  return entries
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, limit)
    .map((entry, index) => {
      const baseLabel = relativeLabel(reference, entry.startsAt);
      const typeLabel = KIND_LABELS[entry.kind];
      const label = entry.kind === 'shift' ? baseLabel : `${baseLabel} — ${typeLabel}`;

      return {
        id: entry.id,
        date: isoDate(entry.startsAt),
        label,
        start: formatTime(entry.startsAt),
        end: formatTime(entry.endsAt),
        status: determineStatus(entry, index, sessionStatus, reference),
        kind: entry.kind,
        displayLabel: entry.displayLabel ?? entry.label ?? typeLabel
      };
    });
};

const mapRequestKind = (type: string): ScheduleEntryKind => {
  switch (type) {
    case 'pto':
      return 'pto';
    case 'uto':
    case 'non_pto':
      return 'uto';
    case 'make_up':
    default:
      return 'make_up';
  }
};

const loadScheduleSources = async (
  userId: number,
  windowStart: Date,
  windowEnd: Date
): Promise<ScheduleSourceEntry[]> => {
const shiftDelegate = (prisma as unknown as {
  shiftAssignment?: { findMany: (args: unknown) => Promise<DbShift[]> };
}).shiftAssignment;

  const [shifts, requests] = await Promise.all([
    shiftDelegate
      ? shiftDelegate.findMany({
          where: {
            userId,
            OR: [
              { startsAt: { gte: windowStart, lt: windowEnd } },
              { endsAt: { gt: windowStart, lte: windowEnd } },
              {
                startsAt: { lte: windowStart },
                endsAt: { gte: windowStart }
              }
            ]
          },
          orderBy: { startsAt: 'asc' }
        })
      : (Promise.resolve([]) as Promise<DbShift[]>),
    prisma.timeRequest.findMany({
      where: {
        userId,
        status: 'approved',
        type: { in: ['pto', 'uto', 'non_pto', 'make_up'] },
        NOT: {
          OR: [
            { endDate: { lt: windowStart } },
            { startDate: { gt: windowEnd } }
          ]
        }
      },
      orderBy: { startDate: 'asc' }
    })
  ]);

  const shiftEntries: ScheduleSourceEntry[] = shifts.map((shift: DbShift) => ({
    id: `shift-${shift.id}`,
    kind: 'shift',
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    label: shift.label ?? null,
    displayLabel: shift.label ?? null
  }));

  const requestEntries: ScheduleSourceEntry[] = requests.map((request: TimeRequestRecord) => {
    const kind = mapRequestKind(request.type);
    return {
      id: `request-${request.id}`,
      kind,
      startsAt: request.startDate,
      endsAt: request.endDate,
      label: request.reason ?? null,
      displayLabel: KIND_LABELS[kind]
    };
  });

  return [...shiftEntries, ...requestEntries];
};

export const getUserSchedule = async ({
  userId,
  sessionStatus,
  reference = new Date(),
  limit = DEFAULT_UPCOMING_LIMIT,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS
}: BuildOptions) => {
  const windowStart = timesheetDayStart(reference);
  const windowEnd = timesheetDayEnd(addDays(reference, lookaheadDays));

  await ensureUpcomingShiftsForUser({ userId, windowStart, windowEnd });

  const entries = await loadScheduleSources(userId, windowStart, windowEnd);
  const config = await prisma.employeeCompConfig.findFirst({
    where: { userId, effectiveOn: { lte: windowEnd } },
    orderBy: { effectiveOn: 'desc' }
  });
  const schedule = ensureSchedule(config?.schedule);

  return {
    defaults: buildScheduleDefaults(schedule),
    upcoming: buildScheduleEntries(entries, sessionStatus, reference, limit)
  };
};

export type UserSchedule = Awaited<ReturnType<typeof getUserSchedule>>;

export const __private__ = {
  buildScheduleEntries,
  loadScheduleSources,
  relativeLabel,
  determineStatus
};

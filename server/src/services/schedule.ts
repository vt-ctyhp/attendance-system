import { addDays } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../prisma';

type DbShift = {
  id: number;
  userId: number;
  startsAt: Date;
  endsAt: Date;
  label: string | null;
};

type TimeRequestRecord = Awaited<ReturnType<typeof prisma.timeRequest.findMany>>[number];
import { TIMESHEET_TIME_ZONE, timesheetDayEnd, timesheetDayStart } from './timesheets';

const DEFAULT_SCHEDULE_TEMPLATES = [
  { label: 'Mon – Fri', start: '09:00', end: '17:30' },
  { label: 'Sat', start: '10:00', end: '16:00' }
];

const DEFAULT_LOOKAHEAD_DAYS = 14;
const DEFAULT_UPCOMING_LIMIT = 6;

const formatDate = (date: Date, pattern: string) => formatInTimeZone(date, TIMESHEET_TIME_ZONE, pattern);
const isoDate = (date: Date) => formatDate(date, 'yyyy-MM-dd');
const dayLabel = (date: Date) => formatDate(date, 'EEE, MMM d');
const formatTime = (date: Date) => formatDate(date, 'HH:mm');

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
        type: { in: ['pto', 'non_pto', 'make_up'] },
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

  const entries = await loadScheduleSources(userId, windowStart, windowEnd);

  return {
    defaults: DEFAULT_SCHEDULE_TEMPLATES.slice(),
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

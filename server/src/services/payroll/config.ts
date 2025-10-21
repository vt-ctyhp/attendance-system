import { addDays, isAfter, startOfDay } from 'date-fns';
import { zonedTimeToUtc, formatInTimeZone, utcToZonedTime } from 'date-fns-tz';
import { Decimal } from '@prisma/client/runtime/library';
import { Prisma, type EmployeeCompConfig } from '@prisma/client';
import { prisma } from '../../prisma';
import { HttpError } from '../../errors';
import { PAYROLL_TIME_ZONE, DATE_KEY_FORMAT } from './constants';
import { collectMonthKeysFromEffectiveDate, triggerAttendanceRecalcForMonths } from './attendanceTrigger';
import { getMonthKeyForDate } from './attendance';

const WEEKDAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'] as const;
const DEFAULT_START = '09:00';
const DEFAULT_END = '17:00';
const DEFAULT_BREAK_MINUTES = 0;
const DEFAULT_EXPECTED_HOURS = 8;

type UnknownRecord = Record<string, unknown>;

const isPlainObject = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clampMinutes = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed));
    }
  }
  return DEFAULT_BREAK_MINUTES;
};

const sanitizeTime = (value: unknown) => {
  if (typeof value !== 'string') {
    return DEFAULT_START;
  }
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_START;
};

const computeExpectedHours = (start: string, end: string, breakMinutes: number, fallback?: unknown) => {
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return Number(fallback);
  }
  const [startHours, startMinutes] = start.split(':').map((part) => Number.parseInt(part, 10));
  const [endHours, endMinutes] = end.split(':').map((part) => Number.parseInt(part, 10));
  if ([startHours, startMinutes, endHours, endMinutes].some((value) => !Number.isFinite(value))) {
    return DEFAULT_EXPECTED_HOURS;
  }
  const startTotal = startHours * 60 + startMinutes;
  const endTotal = endHours * 60 + endMinutes;
  const rawMinutes = endTotal - startTotal;
  if (rawMinutes <= 0) {
    return DEFAULT_EXPECTED_HOURS;
  }
  const netMinutes = Math.max(0, rawMinutes - breakMinutes);
  return Math.round((netMinutes / 60) * 100) / 100;
};

export type WeekdaySchedule = {
  enabled: boolean;
  start: string;
  end: string;
  breakMinutes: number;
  expectedHours: number;
};

export type EmployeeSchedule = {
  version: 2;
  timeZone: string;
  days: Record<string, WeekdaySchedule>;
};

const DEFAULT_SCHEDULE: EmployeeSchedule = {
  version: 2,
  timeZone: PAYROLL_TIME_ZONE,
  days: WEEKDAY_KEYS.reduce<Record<string, WeekdaySchedule>>((acc, key) => {
    acc[key] = {
      enabled: false,
      start: DEFAULT_START,
      end: DEFAULT_END,
      breakMinutes: DEFAULT_BREAK_MINUTES,
      expectedHours: DEFAULT_EXPECTED_HOURS
    };
    return acc;
  }, {})
};

const normalizeDay = (value: unknown): WeekdaySchedule => {
  const raw = isPlainObject(value) ? (value as UnknownRecord) : {};
  const enabled = Boolean(raw.enabled);
  const start = sanitizeTime(raw.start ?? DEFAULT_START);
  const end = sanitizeTime(raw.end ?? DEFAULT_END);
  const breakMinutes = clampMinutes(raw.breakMinutes ?? raw.unpaidBreakMinutes);
  const expectedHours = computeExpectedHours(start, end, breakMinutes, raw.expectedHours);
  return { enabled, start, end, breakMinutes, expectedHours };
};

export const ensureSchedule = (schedule: unknown): EmployeeSchedule => {
  if (!isPlainObject(schedule)) {
    return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } };
  }

  const source = schedule as UnknownRecord;
  const timeZoneCandidate = typeof source.timeZone === 'string' && source.timeZone.trim().length
    ? source.timeZone.trim()
    : PAYROLL_TIME_ZONE;

  const daysSource = isPlainObject(source.days) ? (source.days as UnknownRecord) : source;

  const days: Record<string, WeekdaySchedule> = {};
  for (const key of WEEKDAY_KEYS) {
    days[key] = normalizeDay(daysSource[key]);
  }

  return {
    version: 2,
    timeZone: timeZoneCandidate,
    days
  };
};

export const serializeSchedule = (schedule: EmployeeSchedule) => ({
  version: 2,
  timeZone: schedule.timeZone,
  days: schedule.days
});

export type EmployeeCompInput = {
  userId: number;
  effectiveOn: Date;
  baseSemiMonthlySalary: number;
  monthlyAttendanceBonus: number;
  quarterlyAttendanceBonus: number;
  kpiEligible: boolean;
  defaultKpiBonus?: number | null;
  schedule: EmployeeSchedule;
  accrualEnabled: boolean;
  accrualMethod?: string | null;
  ptoBalanceHours: number;
  utoBalanceHours: number;
};

export type EmployeeCompSnapshot = EmployeeCompInput & {
  id: number;
  submittedById: number | null;
  submittedBy: { id: number; name: string; email: string } | null;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const toSnapshot = (
  config: EmployeeCompConfig & {
    submittedBy?: { id: number; name: string; email: string } | null;
  }
): EmployeeCompSnapshot => ({
  id: config.id,
  userId: config.userId,
  effectiveOn: config.effectiveOn,
  baseSemiMonthlySalary: Number(config.baseSemiMonthlySalary),
  monthlyAttendanceBonus: Number(config.monthlyAttendanceBonus),
  quarterlyAttendanceBonus: Number(config.quarterlyAttendanceBonus),
  kpiEligible: config.kpiEligible,
  defaultKpiBonus:
    config.defaultKpiBonus !== null ? Number(config.defaultKpiBonus) : null,
  schedule: ensureSchedule(config.schedule),
  accrualEnabled: config.accrualEnabled,
  accrualMethod: config.accrualMethod,
  ptoBalanceHours: Number(config.ptoBalanceHours),
  utoBalanceHours: Number(config.utoBalanceHours),
  submittedById: config.submittedById ?? null,
  submittedBy: config.submittedBy
    ? { id: config.submittedBy.id, name: config.submittedBy.name, email: config.submittedBy.email }
    : null,
  submittedAt: config.submittedAt,
  createdAt: config.createdAt,
  updatedAt: config.updatedAt
});

export const listEmployeeConfigs = async (userId?: number) => {
  const where: Prisma.EmployeeCompConfigWhereInput | undefined = userId
    ? { userId }
    : undefined;
  const configs = await prisma.employeeCompConfig.findMany({
    where,
    orderBy: { effectiveOn: 'desc' },
    include: { submittedBy: { select: { id: true, name: true, email: true } } }
  });
  return configs.map((config) => toSnapshot(config));
};

export const getEffectiveConfigForDate = async (
  userId: number,
  target: Date
) => {
  const config = await prisma.employeeCompConfig.findFirst({
    where: { userId, effectiveOn: { lte: target } },
    orderBy: { effectiveOn: 'desc' },
    include: { submittedBy: { select: { id: true, name: true, email: true } } }
  });
  if (!config) return null;
  return toSnapshot(config);
};

export const upsertEmployeeConfig = async (input: EmployeeCompInput, actorId?: number) => {
  const priorConfig = await prisma.employeeCompConfig.findFirst({
    where: { userId: input.userId, effectiveOn: { lte: input.effectiveOn } },
    orderBy: { effectiveOn: 'desc' }
  });

  const schedule = ensureSchedule(input.schedule);
  const serializedSchedule = serializeSchedule(schedule);

  let scheduleChanged = true;
  if (priorConfig) {
    try {
      scheduleChanged = JSON.stringify(priorConfig.schedule) !== JSON.stringify(serializedSchedule);
    } catch (error) {
      scheduleChanged = true;
    }
  }

  const data: Prisma.EmployeeCompConfigUncheckedCreateInput = {
    userId: input.userId,
    effectiveOn: input.effectiveOn,
    baseSemiMonthlySalary: new Decimal(input.baseSemiMonthlySalary),
    monthlyAttendanceBonus: new Decimal(input.monthlyAttendanceBonus),
    quarterlyAttendanceBonus: new Decimal(input.quarterlyAttendanceBonus),
    kpiEligible: input.kpiEligible,
    defaultKpiBonus:
      input.defaultKpiBonus !== undefined && input.defaultKpiBonus !== null
        ? new Decimal(input.defaultKpiBonus)
        : null,
    schedule: serializedSchedule,
    accrualEnabled: input.accrualEnabled,
    accrualMethod: input.accrualMethod ?? null,
    ptoBalanceHours: new Decimal(input.ptoBalanceHours),
    utoBalanceHours: new Decimal(input.utoBalanceHours),
    submittedById: actorId ?? null,
    submittedAt: new Date()
  };

  try {
    await prisma.employeeCompConfig.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw HttpError.conflict('Configuration already exists for this effective date.', {
        field: 'effectiveOn'
      });
    }
    throw error;
  }

  if (scheduleChanged) {
    const monthKeys = collectMonthKeysFromEffectiveDate(input.effectiveOn);
    await triggerAttendanceRecalcForMonths(monthKeys, {
      userIds: [input.userId],
      actorId
    });
  }

  if (actorId) {
    await prisma.payrollAuditLog.create({
      data: {
        actorId,
        scope: 'employee_config',
        target: `${input.userId}`,
        action: 'upsert',
        details: data as unknown as Prisma.JsonObject
      }
    });
  }
};

export const deleteFutureConfigs = async (userId: number, effectiveAfter: Date) => {
  const deleted = await prisma.employeeCompConfig.deleteMany({
    where: {
      userId,
      effectiveOn: { gt: effectiveAfter }
    }
  });
  return deleted.count;
};

export const deleteEmployeeConfig = async (configId: number, actorId?: number) => {
  const existing = await prisma.employeeCompConfig.findUnique({
    where: { id: configId }
  });
  if (!existing) {
    throw HttpError.notFound('Configuration not found');
  }

  await prisma.employeeCompConfig.delete({ where: { id: configId } });

  const monthKeys = collectMonthKeysFromEffectiveDate(existing.effectiveOn);
  await triggerAttendanceRecalcForMonths(monthKeys, {
    userIds: [existing.userId],
    actorId
  });

  if (actorId) {
    await prisma.payrollAuditLog.create({
      data: {
        actorId,
        scope: 'employee_config',
        target: `${existing.userId}`,
        action: 'delete',
        details: { id: configId }
      }
    });
  }

  return toSnapshot({ ...existing, submittedBy: null });
};

export const listHolidays = async (from: Date, to: Date) => {
  const holidays = await prisma.holiday.findMany({
    where: {
      observedOn: {
        gte: zonedTimeToUtc(from, PAYROLL_TIME_ZONE),
        lte: zonedTimeToUtc(addDays(to, 1), PAYROLL_TIME_ZONE)
      }
    },
    orderBy: { observedOn: 'asc' }
  });
  return holidays;
};

export const createHoliday = async (name: string, observedOn: Date, actorId?: number) => {
  const holiday = await prisma.holiday.upsert({
    where: { observedOn },
    update: { name, updatedAt: new Date() },
    create: { name, observedOn, createdById: actorId }
  });
  if (actorId) {
    await prisma.payrollAuditLog.create({
      data: {
        actorId,
        scope: 'holiday',
        target: formatInTimeZone(observedOn, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
        action: 'upsert',
        details: { name }
      }
    });
  }
  const monthKey = getMonthKeyForDate(observedOn);
  await triggerAttendanceRecalcForMonths([monthKey], { actorId });
  return holiday;
};

export const deleteHoliday = async (observedOn: Date, actorId?: number) => {
  const zonedDate = utcToZonedTime(observedOn, PAYROLL_TIME_ZONE);
  const dayStart = startOfDay(zonedDate);
  const nextDayStart = addDays(dayStart, 1);
  const startUtc = zonedTimeToUtc(dayStart, PAYROLL_TIME_ZONE);
  const nextUtc = zonedTimeToUtc(nextDayStart, PAYROLL_TIME_ZONE);

  const deleted = await prisma.holiday.deleteMany({
    where: {
      observedOn: {
        gte: startUtc,
        lt: nextUtc
      }
    }
  });

  if (deleted.count === 0) {
    throw HttpError.notFound('Holiday not found');
  }

  if (actorId) {
    await prisma.payrollAuditLog.create({
      data: {
        actorId,
        scope: 'holiday',
        target: formatInTimeZone(observedOn, PAYROLL_TIME_ZONE, DATE_KEY_FORMAT),
        action: 'delete',
        details: {}
      }
    });
  }
  const monthKey = getMonthKeyForDate(observedOn);
  await triggerAttendanceRecalcForMonths([monthKey], { actorId });
  return true;
};

export const getAllConfigsThrough = async (userId: number, through: Date) => {
  const configs = await prisma.employeeCompConfig.findMany({
    where: { userId, effectiveOn: { lte: through } },
    orderBy: { effectiveOn: 'asc' },
    include: { submittedBy: { select: { id: true, name: true, email: true } } }
  });
  return configs.map((config) => toSnapshot(config));
};

export const resolveActiveConfigForRange = (
  configs: EmployeeCompSnapshot[],
  date: Date
) => {
  if (!configs.length) return null;
  let candidate: EmployeeCompSnapshot | null = null;
  for (const config of configs) {
    if (isAfter(config.effectiveOn, date)) {
      break;
    }
    candidate = config;
  }
  return candidate;
};

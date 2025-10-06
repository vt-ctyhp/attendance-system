import { addDays, isAfter } from 'date-fns';
import { zonedTimeToUtc, formatInTimeZone } from 'date-fns-tz';
import { Decimal } from '@prisma/client/runtime/library';
import type { Prisma, EmployeeCompConfig } from '@prisma/client';
import { prisma } from '../../prisma';
import { PAYROLL_TIME_ZONE, DATE_KEY_FORMAT } from './constants';

export type WeekdaySchedule = {
  enabled: boolean;
  start: string;
  end: string;
  expectedHours: number;
};

export type EmployeeCompInput = {
  userId: number;
  effectiveOn: Date;
  baseSemiMonthlySalary: number;
  monthlyAttendanceBonus: number;
  quarterlyAttendanceBonus: number;
  kpiEligible: boolean;
  defaultKpiBonus?: number | null;
  schedule: Record<string, WeekdaySchedule>;
  accrualEnabled: boolean;
  accrualMethod?: string | null;
  ptoBalanceHours: number;
  utoBalanceHours: number;
};

export type EmployeeCompSnapshot = EmployeeCompInput & {
  id: number;
  createdAt: Date;
  updatedAt: Date;
};

const WEEKDAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'] as const;

export const ensureSchedule = (
  schedule: Record<string, WeekdaySchedule>
): Record<string, WeekdaySchedule> => {
  const result: Record<string, WeekdaySchedule> = {};
  for (const key of WEEKDAY_KEYS) {
    const raw = schedule[key];
    if (!raw) {
      result[key] = { enabled: false, start: '09:00', end: '17:00', expectedHours: 8 };
      continue;
    }
    result[key] = {
      enabled: Boolean(raw.enabled),
      start: raw.start ?? '09:00',
      end: raw.end ?? '17:00',
      expectedHours: Number.isFinite(raw.expectedHours) ? Number(raw.expectedHours) : 8
    };
  }
  return result;
};

const toSnapshot = (
  config: EmployeeCompConfig
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
  schedule: ensureSchedule(config.schedule as Record<string, WeekdaySchedule>),
  accrualEnabled: config.accrualEnabled,
  accrualMethod: config.accrualMethod,
  ptoBalanceHours: Number(config.ptoBalanceHours),
  utoBalanceHours: Number(config.utoBalanceHours),
  createdAt: config.createdAt,
  updatedAt: config.updatedAt
});

export const listEmployeeConfigs = async (userId?: number) => {
  const where: Prisma.EmployeeCompConfigWhereInput | undefined = userId
    ? { userId }
    : undefined;
  const configs = await prisma.employeeCompConfig.findMany({
    where,
    orderBy: { effectiveOn: 'desc' }
  });
  return configs.map((config) => toSnapshot(config));
};

export const getEffectiveConfigForDate = async (
  userId: number,
  target: Date
) => {
  const config = await prisma.employeeCompConfig.findFirst({
    where: { userId, effectiveOn: { lte: target } },
    orderBy: { effectiveOn: 'desc' }
  });
  if (!config) return null;
  return toSnapshot(config);
};

export const upsertEmployeeConfig = async (input: EmployeeCompInput, actorId?: number) => {
  const schedule = ensureSchedule(input.schedule);
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
    schedule,
    accrualEnabled: input.accrualEnabled,
    accrualMethod: input.accrualMethod ?? null,
    ptoBalanceHours: new Decimal(input.ptoBalanceHours),
    utoBalanceHours: new Decimal(input.utoBalanceHours)
  };

  await prisma.employeeCompConfig.upsert({
    where: { userId_effectiveOn: { userId: input.userId, effectiveOn: input.effectiveOn } },
    create: data,
    update: data
  });

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
  return holiday;
};

export const deleteHoliday = async (observedOn: Date, actorId?: number) => {
  const deleted = await prisma.holiday.deleteMany({ where: { observedOn } });
  if (actorId && deleted.count > 0) {
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
  return deleted.count > 0;
};

export const getAllConfigsThrough = async (userId: number, through: Date) => {
  const configs = await prisma.employeeCompConfig.findMany({
    where: { userId, effectiveOn: { lte: through } },
    orderBy: { effectiveOn: 'asc' }
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

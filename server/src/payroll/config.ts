import { Prisma } from '@prisma/client';
import type { PrismaClient, PayrollEmployeeConfig as PayrollEmployeeConfigModel } from '@prisma/client';
import { utcToZonedTime } from 'date-fns-tz';
import { prisma } from '../prisma';
import { PAYROLL_TIME_ZONE, type PayrollScheduleEntry, type Weekday } from './types';
import { recordPayrollAudit } from './audit';

export interface PayrollConfigInput {
  effectiveOn: Date;
  baseSemiMonthlySalary: number;
  monthlyAttendanceBonus: number;
  quarterlyAttendanceBonus: number;
  kpiBonusDefaultAmount: number;
  kpiBonusEnabled: boolean;
  ptoBalanceHours: number;
  nonPtoBalanceHours: number;
  accrualEnabled: boolean;
  accrualMethod: 'NONE' | 'MANUAL' | 'MONTHLY_HOURS';
  accrualHoursPerMonth?: number | null;
  notes?: string | null;
  schedule: PayrollScheduleEntry[];
}

const fromUtc = (value: Date) => utcToZonedTime(value, PAYROLL_TIME_ZONE);

const NORMALIZED_WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

const normalizeSchedule = (schedule: PayrollScheduleEntry[]): PayrollScheduleEntry[] => {
  const map = new Map<Weekday, PayrollScheduleEntry>();
  for (const entry of schedule) {
    const weekday = Number(entry.weekday) as Weekday;
    if (!NORMALIZED_WEEKDAYS.includes(weekday)) continue;
    map.set(weekday, {
      weekday,
      isEnabled: Boolean(entry.isEnabled),
      startMinutes: entry.startMinutes ?? null,
      endMinutes: entry.endMinutes ?? null,
      expectedHours: entry.expectedHours ?? null
    });
  }

  return NORMALIZED_WEEKDAYS.map((weekday) =>
    map.get(weekday) ?? {
      weekday,
      isEnabled: false,
      startMinutes: null,
      endMinutes: null,
      expectedHours: null
    }
  );
};

const toScheduleCreateMany = (schedule: PayrollScheduleEntry[], configId: number) =>
  schedule.map((entry) => ({
    configId,
    weekday: entry.weekday,
    isEnabled: entry.isEnabled,
    startMinutes: entry.startMinutes ?? null,
    endMinutes: entry.endMinutes ?? null,
    expectedHours: entry.expectedHours ?? null
  }));

export const listEmployeeConfigs = async (userId: number) => {
  return prisma.payrollEmployeeConfig.findMany({
    where: { userId },
    include: { schedule: true },
    orderBy: { effectiveOn: 'asc' }
  });
};

export const upsertEmployeeConfig = async (
  userId: number,
  input: PayrollConfigInput,
  actorId?: number
): Promise<PayrollEmployeeConfigModel> => {
  const normalizedSchedule = normalizeSchedule(input.schedule);

  const result = await prisma.$transaction(async (tx) => {
    const config = await tx.payrollEmployeeConfig.upsert({
      where: { userId_effectiveOn: { userId, effectiveOn: input.effectiveOn } },
      update: {
        baseSemiMonthlySalary: input.baseSemiMonthlySalary,
        monthlyAttendanceBonus: input.monthlyAttendanceBonus,
        quarterlyAttendanceBonus: input.quarterlyAttendanceBonus,
        kpiBonusDefaultAmount: input.kpiBonusDefaultAmount,
        kpiBonusEnabled: input.kpiBonusEnabled,
        ptoBalanceHours: input.ptoBalanceHours,
        nonPtoBalanceHours: input.nonPtoBalanceHours,
        accrualEnabled: input.accrualEnabled,
        accrualMethod: input.accrualMethod,
        accrualHoursPerMonth: input.accrualHoursPerMonth ?? null,
        notes: input.notes ?? null,
        createdById: actorId ?? null
      },
      create: {
        userId,
        effectiveOn: input.effectiveOn,
        baseSemiMonthlySalary: input.baseSemiMonthlySalary,
        monthlyAttendanceBonus: input.monthlyAttendanceBonus,
        quarterlyAttendanceBonus: input.quarterlyAttendanceBonus,
        kpiBonusDefaultAmount: input.kpiBonusDefaultAmount,
        kpiBonusEnabled: input.kpiBonusEnabled,
        ptoBalanceHours: input.ptoBalanceHours,
        nonPtoBalanceHours: input.nonPtoBalanceHours,
        accrualEnabled: input.accrualEnabled,
        accrualMethod: input.accrualMethod,
        accrualHoursPerMonth: input.accrualHoursPerMonth ?? null,
        notes: input.notes ?? null,
        createdById: actorId ?? null,
        schedule: {
          createMany: {
            data: normalizedSchedule.map((entry) => ({
              weekday: entry.weekday,
              isEnabled: entry.isEnabled,
              startMinutes: entry.startMinutes ?? null,
              endMinutes: entry.endMinutes ?? null,
              expectedHours: entry.expectedHours ?? null
            }))
          }
        }
      },
      include: { schedule: true }
    });

    if (config && config.id > 0) {
      await tx.payrollEmployeeSchedule.deleteMany({ where: { configId: config.id } });
      await tx.payrollEmployeeSchedule.createMany({
        data: toScheduleCreateMany(normalizedSchedule, config.id)
      });
    }

    return config;
  });

  await recordPayrollAudit({
    actorId: actorId ?? null,
    entityType: 'PayrollEmployeeConfig',
    entityId: `${userId}:${input.effectiveOn.toISOString()}`,
    event: 'CONFIG_UPDATED',
    payload: {
      baseSemiMonthlySalary: input.baseSemiMonthlySalary,
      monthlyAttendanceBonus: input.monthlyAttendanceBonus,
      quarterlyAttendanceBonus: input.quarterlyAttendanceBonus,
      kpiBonusDefaultAmount: input.kpiBonusDefaultAmount,
      kpiBonusEnabled: input.kpiBonusEnabled,
      ptoBalanceHours: input.ptoBalanceHours,
      nonPtoBalanceHours: input.nonPtoBalanceHours,
      accrualEnabled: input.accrualEnabled,
      accrualMethod: input.accrualMethod,
      accrualHoursPerMonth: input.accrualHoursPerMonth ?? null,
      notes: input.notes ?? null,
      schedule: normalizedSchedule.map((entry) => ({
        weekday: entry.weekday,
        isEnabled: entry.isEnabled,
        startMinutes: entry.startMinutes,
        endMinutes: entry.endMinutes,
        expectedHours: entry.expectedHours
      }))
    } as unknown as Prisma.JsonValue
  });

  return result;
};

export interface EffectiveConfigWithSchedule extends PayrollEmployeeConfigModel {
  schedule: PayrollScheduleEntry[];
}

export const getEffectiveConfigForDate = async (
  userId: number,
  reference: Date,
  tx?: Prisma.TransactionClient | PrismaClient
): Promise<EffectiveConfigWithSchedule | null> => {
  const client = tx ?? prisma;
  const rows = await client.payrollEmployeeConfig.findMany({
    where: {
      userId,
      effectiveOn: {
        lte: reference
      }
    },
    include: {
      schedule: true
    },
    orderBy: { effectiveOn: 'asc' }
  });

  if (!rows.length) return null;

  let winner: Prisma.PayrollEmployeeConfigGetPayload<{ include: { schedule: true } }> | null = null;
  for (const row of rows) {
    if (!winner || row.effectiveOn > winner.effectiveOn) {
      winner = row;
    }
  }

  if (!winner) return null;

  const normalizedSchedule = normalizeSchedule(
    winner.schedule.map((entry) => ({
      weekday: entry.weekday as Weekday,
      isEnabled: entry.isEnabled,
      startMinutes: entry.startMinutes,
      endMinutes: entry.endMinutes,
      expectedHours: entry.expectedHours ? Number(entry.expectedHours) : null
    }))
  );

  return {
    ...winner,
    schedule: normalizedSchedule
  };
};

export const resolveScheduleForDate = async (
  userId: number,
  reference: Date,
  tx?: Prisma.TransactionClient | PrismaClient
): Promise<PayrollScheduleEntry | null> => {
  const config = await getEffectiveConfigForDate(userId, reference, tx);
  if (!config) return null;
  const candidate = config.schedule.find((entry) => entry.weekday === fromUtc(reference).getDay());
  return candidate ?? null;
};

export const getConfigTimelineSnapshot = async (userId: number) => {
  const configs = await listEmployeeConfigs(userId);
  return configs.map((config) => ({
    effectiveOn: config.effectiveOn,
    baseSemiMonthlySalary: Number(config.baseSemiMonthlySalary),
    monthlyAttendanceBonus: Number(config.monthlyAttendanceBonus),
    quarterlyAttendanceBonus: Number(config.quarterlyAttendanceBonus),
    kpiBonusDefaultAmount: Number(config.kpiBonusDefaultAmount),
    kpiBonusEnabled: config.kpiBonusEnabled,
    ptoBalanceHours: Number(config.ptoBalanceHours),
    nonPtoBalanceHours: Number(config.nonPtoBalanceHours),
    accrualEnabled: config.accrualEnabled,
    accrualMethod: config.accrualMethod,
    accrualHoursPerMonth: config.accrualHoursPerMonth ? Number(config.accrualHoursPerMonth) : null,
    notes: config.notes,
    schedule: config.schedule.map((entry) => ({
      weekday: entry.weekday as Weekday,
      isEnabled: entry.isEnabled,
      startMinutes: entry.startMinutes,
      endMinutes: entry.endMinutes,
      expectedHours: entry.expectedHours ? Number(entry.expectedHours) : null
    }))
  }));
};

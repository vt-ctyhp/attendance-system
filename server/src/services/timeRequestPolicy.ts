import { startOfMonth, endOfMonth } from 'date-fns';
import { utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getConfigValue } from './config';

export const MAKEUP_CAP_CONFIG_KEY = 'makeup_cap_hours_per_month';
export const DEFAULT_MAKEUP_CAP_HOURS_PER_MONTH = 8;
const TIME_REQUEST_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';
const HOURS_COMPARISON_EPSILON = 1e-6;

type PrismaClientLike = PrismaClient | Prisma.TransactionClient;

type MonthRange = {
  start: Date;
  end: Date;
};

const parseCapValue = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

export const getCurrentMonthRange = (reference: Date = new Date()): MonthRange => {
  const zonedReference = utcToZonedTime(reference, TIME_REQUEST_TIME_ZONE);
  const start = zonedTimeToUtc(startOfMonth(zonedReference), TIME_REQUEST_TIME_ZONE);
  const end = zonedTimeToUtc(endOfMonth(zonedReference), TIME_REQUEST_TIME_ZONE);
  return { start, end };
};

export const getMakeupCapHoursPerMonth = async (): Promise<number> => {
  const stored = await getConfigValue(MAKEUP_CAP_CONFIG_KEY);
  const parsed = parseCapValue(stored);
  return parsed ?? DEFAULT_MAKEUP_CAP_HOURS_PER_MONTH;
};

export const getApprovedMakeupHoursThisMonthByUser = async (
  client: PrismaClientLike,
  userIds: number[],
  reference: Date = new Date()
): Promise<Map<number, number>> => {
  if (userIds.length === 0) {
    return new Map();
  }

  const { start, end } = getCurrentMonthRange(reference);

  const rows = await client.timeRequest.groupBy({
    by: ['userId'],
    where: {
      userId: { in: userIds },
      type: 'make_up',
      status: 'approved',
      approvedAt: {
        gte: start,
        lte: end
      }
    },
    _sum: { hours: true }
  });

  const map = new Map<number, number>();
  for (const row of rows) {
    map.set(row.userId, row._sum.hours ?? 0);
  }
  return map;
};

export const getApprovedMakeupHoursThisMonth = async (
  client: PrismaClientLike,
  userId: number,
  reference: Date = new Date()
): Promise<number> => {
  const map = await getApprovedMakeupHoursThisMonthByUser(client, [userId], reference);
  return map.get(userId) ?? 0;
};

export const exceedsMonthlyCap = (approvedThisMonth: number, requestedHours: number, cap: number): boolean =>
  approvedThisMonth + requestedHours - cap > HOURS_COMPARISON_EPSILON;

export const remainingHoursWithinCap = (
  approvedThisMonth: number,
  cap: number
): number => Math.max(cap - approvedThisMonth, 0);


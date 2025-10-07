import { min as minDate, max as maxDate, eachDayOfInterval } from 'date-fns';
import { logger } from '../../logger';
import {
  getMonthKeyForDate,
  isAttendanceMonthLocked,
  recalcMonthlyAttendanceFacts
} from './attendance';

const uniqueMonthKeysForRange = (start: Date, end: Date) => {
  const orderedStart = minDate([start, end]);
  const orderedEnd = maxDate([start, end]);
  const days = eachDayOfInterval({ start: orderedStart, end: orderedEnd });
  const keys = new Set<string>();
  for (const day of days) {
    keys.add(getMonthKeyForDate(day));
  }
  return Array.from(keys);
};

const logSkip = (monthKey: string, reason: string) => {
  logger.debug({ monthKey, reason }, 'attendance.recalc.skipped');
};

const runRecalc = async (monthKey: string, userIds: number[] | undefined, actorId?: number) => {
  try {
    await recalcMonthlyAttendanceFacts(monthKey, actorId, userIds);
  } catch (error) {
    logger.error({ error, monthKey, userIds }, 'attendance.recalc.failed');
    throw error;
  }
};

export const triggerAttendanceRecalcForUser = async (
  userId: number,
  referenceDate: Date,
  options?: { actorId?: number; awaitCompletion?: boolean; reason?: string }
) => {
  const monthKey = getMonthKeyForDate(referenceDate);
  if (await isAttendanceMonthLocked(monthKey)) {
    logSkip(monthKey, 'month_locked');
    return;
  }
  const execute = () => runRecalc(monthKey, [userId], options?.actorId);
  if (options?.awaitCompletion) {
    await execute();
  } else {
    void execute();
  }
};

export const triggerAttendanceRecalcForUserRange = async (
  userId: number,
  start: Date,
  end: Date,
  options?: { actorId?: number }
) => {
  const monthKeys = uniqueMonthKeysForRange(start, end);
  for (const monthKey of monthKeys) {
    if (await isAttendanceMonthLocked(monthKey)) {
      logSkip(monthKey, 'month_locked');
      continue;
    }
    await runRecalc(monthKey, [userId], options?.actorId);
  }
};

export const triggerAttendanceRecalcForMonths = async (
  monthKeys: string[],
  options?: { actorId?: number; userIds?: number[] }
) => {
  for (const monthKey of monthKeys) {
    if (await isAttendanceMonthLocked(monthKey)) {
      logSkip(monthKey, 'month_locked');
      continue;
    }
    await runRecalc(monthKey, options?.userIds, options?.actorId);
  }
};

export const collectMonthKeysFromEffectiveDate = (effectiveOn: Date, reference: Date = new Date()) => {
  const orderedStart = minDate([effectiveOn, reference]);
  const orderedEnd = maxDate([effectiveOn, reference]);
  return uniqueMonthKeysForRange(orderedStart, orderedEnd);
};

import { addMinutes } from 'date-fns';
import { zonedTimeToUtc } from 'date-fns-tz';
import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/prisma';
import { PAYROLL_TIME_ZONE, BONUS_TYPE_MONTHLY } from '../src/services/payroll/constants';
import { upsertEmployeeConfig } from '../src/services/payroll/config';
import { getMonthKeyForDate, recalcMonthlyAttendanceFacts } from '../src/services/payroll/attendance';
import { recalcMonthlyBonuses } from '../src/services/payroll/bonuses';
import { getAppOverview } from '../src/routes/appData';
import { approveTimeRequest } from '../src/routes/timeRequests';
import { callHandler } from './utils';

const buildSchedule = () => {
  const days: Record<string, unknown> = {};
  for (let day = 0; day < 7; day += 1) {
    const enabled = day >= 1 && day <= 5;
    days[String(day)] = {
      enabled,
      start: '09:00',
      end: '18:00',
      breakMinutes: 90,
      expectedHours: 7.5
    };
  }
  return { version: 2, timeZone: PAYROLL_TIME_ZONE, days };
};

describe('Attendance tardiness integration', () => {
  it('tracks tardy minutes, excuses them with PTO, and updates dependent systems', async () => {
    vi.useFakeTimers();
    try {
      const clockInLocal = '2025-05-05T09:15:00';
      const clockInUtc = zonedTimeToUtc(clockInLocal, PAYROLL_TIME_ZONE);
      vi.setSystemTime(zonedTimeToUtc('2025-05-05T13:00:00', PAYROLL_TIME_ZONE));

      const manager = await prisma.user.create({
        data: {
          email: 'manager-tardy@example.com',
          name: 'Manager Example',
          role: 'manager',
          passwordHash: 'hash',
          active: true
        }
      });

      const employee = await prisma.user.create({
        data: {
          email: 'tardy-employee@example.com',
          name: 'Tardy Employee',
          role: 'employee',
          passwordHash: 'hash',
          active: true
        }
      });

      await upsertEmployeeConfig(
        {
          userId: employee.id,
          effectiveOn: zonedTimeToUtc('2025-05-01T00:00:00', PAYROLL_TIME_ZONE),
          baseSemiMonthlySalary: 2500,
          monthlyAttendanceBonus: 150,
          quarterlyAttendanceBonus: 300,
          kpiEligible: false,
          defaultKpiBonus: null,
          schedule: buildSchedule(),
          accrualEnabled: false,
          accrualMethod: null,
          ptoBalanceHours: 40,
          utoBalanceHours: 8
        },
        manager.id
      );

      const session = await prisma.session.create({
        data: {
          userId: employee.id,
          deviceId: 'test-device',
          startedAt: clockInUtc,
          endedAt: addMinutes(clockInUtc, 480),
          status: 'ended'
        }
      });

      await prisma.minuteStat.create({
        data: {
          sessionId: session.id,
          minuteStart: clockInUtc,
          active: true,
          idle: false,
          keysCount: 10,
          mouseCount: 5
        }
      });

      const monthKey = getMonthKeyForDate(clockInUtc);
      await recalcMonthlyAttendanceFacts(monthKey, undefined, [employee.id]);

      const initialFact = await prisma.attendanceMonthFact.findUniqueOrThrow({
        where: { userId_monthKey: { userId: employee.id, monthKey } }
      });
      expect(Number(initialFact.tardyMinutes)).toBe(15);
      expect(initialFact.isPerfect).toBe(false);

      await recalcMonthlyBonuses(monthKey);
      const absentBonus = await prisma.bonusCandidate.findUnique({
        where: {
          userId_type_periodKey: {
            userId: employee.id,
            type: BONUS_TYPE_MONTHLY,
            periodKey: monthKey
          }
        }
      });
      expect(absentBonus).toBeNull();

      const dayStart = zonedTimeToUtc('2025-05-05T00:00:00', PAYROLL_TIME_ZONE);
      const dayEnd = zonedTimeToUtc('2025-05-05T23:59:59', PAYROLL_TIME_ZONE);
      const request = await prisma.timeRequest.create({
        data: {
          userId: employee.id,
          type: 'pto',
          status: 'pending',
          startDate: dayStart,
          endDate: dayEnd,
          hours: 8,
          reason: 'Medical appointment'
        }
      });

      await callHandler(approveTimeRequest, {
        params: { id: request.id },
        body: { hours: 8 },
        user: {
          id: manager.id,
          role: 'manager',
          email: manager.email,
          name: manager.name
        },
        method: 'POST'
      });

      const updatedFact = await prisma.attendanceMonthFact.findUniqueOrThrow({
        where: { userId_monthKey: { userId: employee.id, monthKey } }
      });
      expect(Number(updatedFact.tardyMinutes)).toBe(0);
      expect(updatedFact.isPerfect).toBe(true);

      await recalcMonthlyBonuses(monthKey);
      const earnedBonus = await prisma.bonusCandidate.findUnique({
        where: {
          userId_type_periodKey: {
            userId: employee.id,
            type: BONUS_TYPE_MONTHLY,
            periodKey: monthKey
          }
        }
      });
      expect(earnedBonus).toBeTruthy();
      expect(Number(earnedBonus?.amount ?? 0)).toBe(150);

      const overviewResponse = await callHandler(getAppOverview, {
        method: 'GET',
        query: { email: employee.email }
      });

      expect(overviewResponse.status).toBe(200);
      const overview = overviewResponse.data as {
        today: { tardyMinutes: number };
        timesheet: { periods: { weekly: { days: Array<{ date: string; tardyMinutes: number }> } } };
      };
      const weeklyDay = overview.timesheet.periods.weekly.days.find((day) => day.date === '2025-05-05');
      expect(weeklyDay?.tardyMinutes).toBe(0);
      expect(overview.today.tardyMinutes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

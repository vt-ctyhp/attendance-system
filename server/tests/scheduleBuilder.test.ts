import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zonedTimeToUtc } from 'date-fns-tz';
import { prisma } from '../src/prisma';
import { getUserSchedule, type ScheduleSessionStatus } from '../src/services/schedule';
import { TIMESHEET_TIME_ZONE } from '../src/services/timesheets';
import { PAYROLL_TIME_ZONE } from '../src/services/payroll/constants';

const toZonedUtc = (iso: string) => zonedTimeToUtc(iso, TIMESHEET_TIME_ZONE);

const makeStatus = (status: ScheduleSessionStatus['status']): ScheduleSessionStatus => ({ status });

const createUser = async () =>
  prisma.user.create({
    data: {
      email: `user-${randomUUID()}@example.com`,
      name: 'Test User',
      role: 'employee',
      passwordHash: 'hash',
      active: true
    }
  });

describe('schedule builder', () => {
  it('includes upcoming shifts for the user', async () => {
    const user = await createUser();
    const reference = toZonedUtc('2025-05-01T10:00:00');

    await prisma.shiftAssignment.create({
      data: {
        userId: user.id,
        label: 'Opening Shift',
        startsAt: toZonedUtc('2025-05-01T09:00:00'),
        endsAt: toZonedUtc('2025-05-01T17:00:00')
      }
    });

    await prisma.shiftAssignment.create({
      data: {
        userId: user.id,
        label: 'Closing Shift',
        startsAt: toZonedUtc('2025-05-02T11:00:00'),
        endsAt: toZonedUtc('2025-05-02T19:00:00')
      }
    });

    const schedule = await getUserSchedule({
      userId: user.id,
      sessionStatus: makeStatus('working'),
      reference
    });

    expect(schedule.defaults.length).toBeGreaterThan(0);
    expect(schedule.upcoming).toHaveLength(2);
    expect(schedule.upcoming[0].label).toBe('Today');
    expect(schedule.upcoming[0].status).toBe('in_progress');
    expect(schedule.upcoming[0].kind).toBe('shift');
    expect(schedule.upcoming[1].label).toMatch(/Tomorrow|Fri/);
    expect(schedule.upcoming[1].kind).toBe('shift');
  });

  it('generates shift assignments from configured schedule templates', async () => {
    const user = await createUser();

    const scheduleDays: Record<string, { enabled: boolean; start: string; end: string; breakMinutes: number; expectedHours: number }> = {
      '0': { enabled: false, start: '09:00', end: '17:00', breakMinutes: 30, expectedHours: 7.5 },
      '1': { enabled: true, start: '09:00', end: '17:30', breakMinutes: 30, expectedHours: 8 },
      '2': { enabled: true, start: '09:00', end: '17:30', breakMinutes: 30, expectedHours: 8 },
      '3': { enabled: true, start: '09:00', end: '17:30', breakMinutes: 30, expectedHours: 8 },
      '4': { enabled: true, start: '09:00', end: '17:30', breakMinutes: 30, expectedHours: 8 },
      '5': { enabled: false, start: '09:00', end: '17:00', breakMinutes: 30, expectedHours: 7.5 },
      '6': { enabled: false, start: '09:00', end: '17:00', breakMinutes: 30, expectedHours: 7.5 }
    };

    await prisma.employeeCompConfig.create({
      data: {
        userId: user.id,
        effectiveOn: toZonedUtc('2025-04-01T00:00:00'),
        baseSemiMonthlySalary: '3200',
        monthlyAttendanceBonus: '150',
        quarterlyAttendanceBonus: '450',
        kpiEligible: true,
        defaultKpiBonus: '500',
        schedule: { version: 2, timeZone: PAYROLL_TIME_ZONE, days: scheduleDays },
        accrualEnabled: false,
        accrualMethod: null,
        ptoBalanceHours: '40',
        utoBalanceHours: '12'
      }
    });

    const reference = toZonedUtc('2025-04-28T08:00:00');

    const firstSchedule = await getUserSchedule({
      userId: user.id,
      sessionStatus: makeStatus('clocked_out'),
      reference,
      lookaheadDays: 7
    });

    expect(firstSchedule.upcoming.some((entry) => entry.kind === 'shift')).toBe(true);

    const assignments = await prisma.shiftAssignment.findMany({ where: { userId: user.id } });
    expect(assignments.length).toBeGreaterThan(0);

    const firstCount = assignments.length;

    await getUserSchedule({
      userId: user.id,
      sessionStatus: makeStatus('clocked_out'),
      reference,
      lookaheadDays: 7
    });

    const assignmentsAfterSecondRun = await prisma.shiftAssignment.findMany({ where: { userId: user.id } });
    expect(assignmentsAfterSecondRun.length).toBe(firstCount);
  });

  it('includes approved PTO when no shifts exist', async () => {
    const user = await createUser();
    const reference = toZonedUtc('2025-05-01T08:00:00');

    await prisma.timeRequest.create({
      data: {
        userId: user.id,
        type: 'pto',
        status: 'approved',
        startDate: toZonedUtc('2025-05-02T09:00:00'),
        endDate: toZonedUtc('2025-05-02T17:00:00'),
        hours: 8,
        reason: 'Family day',
        approverId: null
      }
    });

    const schedule = await getUserSchedule({
      userId: user.id,
      sessionStatus: makeStatus('clocked_out'),
      reference
    });

    expect(schedule.upcoming).toHaveLength(1);
    expect(schedule.upcoming[0].label).toContain('PTO');
    expect(schedule.upcoming[0].kind).toBe('pto');
    expect(schedule.upcoming[0].status).toBe('upcoming');
  });

  it('mixes shifts with PTO and make-up hours', async () => {
    const user = await createUser();
    const reference = toZonedUtc('2025-05-01T12:00:00');

    await prisma.shiftAssignment.create({
      data: {
        userId: user.id,
        startsAt: toZonedUtc('2025-05-01T09:00:00'),
        endsAt: toZonedUtc('2025-05-01T17:00:00')
      }
    });

    await prisma.timeRequest.create({
      data: {
        userId: user.id,
        type: 'make_up',
        status: 'approved',
        startDate: toZonedUtc('2025-05-01T19:00:00'),
        endDate: toZonedUtc('2025-05-01T21:00:00'),
        hours: 2,
        reason: 'Inventory prep',
        approverId: null
      }
    });

    await prisma.timeRequest.create({
      data: {
        userId: user.id,
        type: 'uto',
        status: 'approved',
        startDate: toZonedUtc('2025-05-02T09:00:00'),
        endDate: toZonedUtc('2025-05-02T13:00:00'),
        hours: 4,
        reason: 'Personal errands',
        approverId: null
      }
    });

    const schedule = await getUserSchedule({
      userId: user.id,
      sessionStatus: makeStatus('working'),
      reference
    });

    expect(schedule.upcoming).toHaveLength(3);
    expect(schedule.upcoming[0].kind).toBe('shift');
    expect(schedule.upcoming[0].status).toBe('in_progress');
    expect(schedule.upcoming[1].kind).toBe('make_up');
    expect(schedule.upcoming[1].label).toContain('Make-up');
    expect(schedule.upcoming[2].kind).toBe('uto');
    expect(schedule.upcoming[2].label).toContain('Unpaid Time Off');
  });

  it('returns an empty upcoming list when no data exists', async () => {
    const user = await createUser();

    const schedule = await getUserSchedule({
      userId: user.id,
      sessionStatus: makeStatus('clocked_out'),
      reference: toZonedUtc('2025-05-01T09:00:00')
    });

    expect(schedule.upcoming).toHaveLength(0);
  });
});

import { addHours, addDays } from 'date-fns';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma';
import { getAppOverview } from '../src/routes/appData';
import { callHandler } from './utils';

const futureDate = (offsetHours: number) => {
  const date = new Date();
  return addHours(date, offsetHours);
};

describe('GET /api/app/overview schedule section', () => {
  it('returns labeled shifts and time-off entries for seeded users', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'schedule-integration@example.com',
        name: 'Schedule Integration',
        role: 'employee',
        passwordHash: 'hash',
        active: true
      }
    });

    const shiftStart = futureDate(4);
    shiftStart.setMinutes(0, 0, 0);
    const shiftEnd = addHours(shiftStart, 8);

    await prisma.shiftAssignment.create({
      data: {
        userId: user.id,
        label: 'Integration Shift',
        startsAt: shiftStart,
        endsAt: shiftEnd
      }
    });

    const makeUpStart = addHours(shiftEnd, 2);
    const makeUpEnd = addHours(makeUpStart, 2);
    const ptoStart = addDays(shiftStart, 1);
    const ptoEnd = addHours(ptoStart, 8);
    const utoStart = addDays(ptoStart, 1);
    const utoEnd = addHours(utoStart, 4);

    await prisma.timeRequest.createMany({
      data: [
        {
          userId: user.id,
          type: 'make_up',
          status: 'approved',
          startDate: makeUpStart,
          endDate: makeUpEnd,
          hours: 2,
          reason: 'Coverage for inventory check'
        },
        {
          userId: user.id,
          type: 'pto',
          status: 'approved',
          startDate: ptoStart,
          endDate: ptoEnd,
          hours: 8,
          reason: 'Vacation day'
        },
        {
          userId: user.id,
          type: 'uto',
          status: 'approved',
          startDate: utoStart,
          endDate: utoEnd,
          hours: 4,
          reason: 'Personal errand'
        }
      ]
    });

    const response = await callHandler(getAppOverview, {
      method: 'GET',
      query: { email: user.email }
    });

    expect(response.status).toBe(200);
    const data = response.data as { schedule: { upcoming: Array<{ kind?: string; label: string; displayLabel?: string }> } };
    const upcoming = data.schedule.upcoming;

    expect(Array.isArray(upcoming)).toBe(true);
    expect(upcoming.length).toBeGreaterThanOrEqual(4);

    const shift = upcoming.find((entry) => entry.kind === 'shift');
    expect(shift).toBeTruthy();
    expect(shift?.displayLabel).toBe('Integration Shift');

    const makeUp = upcoming.find((entry) => entry.kind === 'make_up');
    expect(makeUp).toBeTruthy();
    expect(makeUp?.label.toLowerCase()).toContain('make-up');

    const pto = upcoming.find((entry) => entry.kind === 'pto');
    expect(pto).toBeTruthy();
    expect(pto?.label.toLowerCase()).toContain('pto');

    const uto = upcoming.find((entry) => entry.kind === 'uto');
    expect(uto).toBeTruthy();
    expect(uto?.label.toLowerCase()).toContain('unpaid time off');
  });
});

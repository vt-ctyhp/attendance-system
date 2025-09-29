import { addMinutes, setHours, setMinutes } from 'date-fns';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma';
import { getAppOverview } from '../src/routes/appData';
import { callHandler } from './utils';

const startOfToday = () => {
  const now = new Date();
  const clone = new Date(now.getTime());
  clone.setHours(0, 0, 0, 0);
  return clone;
};

describe('GET /api/app/overview', () => {
  it('returns an overview payload for the requested employee', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'employee@example.com',
        name: 'Employee Example',
        role: 'employee',
        passwordHash: 'hash',
        active: true
      }
    });

    const today = startOfToday();
    const sessionStart = setMinutes(setHours(new Date(today), 9), 0);
    const sessionEnd = addMinutes(sessionStart, 8 * 60);

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: 'integration-device-1',
        startedAt: sessionStart,
        endedAt: sessionEnd,
        status: 'completed'
      }
    });

    await prisma.minuteStat.createMany({
      data: Array.from({ length: 60 }).map((_, index) => ({
        sessionId: session.id,
        minuteStart: addMinutes(sessionStart, index),
        active: true,
        idle: index % 15 === 0,
        keysCount: 40,
        mouseCount: 20
      }))
    });

    await prisma.sessionPause.create({
      data: {
        sessionId: session.id,
        type: 'break',
        sequence: 1,
        startedAt: addMinutes(sessionStart, 120),
        endedAt: addMinutes(sessionStart, 135),
        durationMinutes: 15
      }
    });

    await prisma.event.create({
      data: {
        sessionId: session.id,
        ts: addMinutes(sessionStart, 210),
        type: 'presence_miss',
        payload: '{}'
      }
    });

    await prisma.timeRequest.create({
      data: {
        userId: user.id,
        type: 'make_up',
        status: 'approved',
        startDate: sessionStart,
        endDate: addMinutes(sessionStart, 180),
        hours: 3,
        reason: 'Coverage for shipment arrival'
      }
    });

    const response = await callHandler(getAppOverview, {
      method: 'GET',
      query: { email: user.email }
    });

    expect(response.status).toBe(200);
    expect(response.data).toBeTruthy();

    const overview = response.data as {
      user: { name: string; email: string };
      session: { id: string | null; status: string };
      today: { activeMinutes: number; breaksCount: number };
      requests: Array<{ id: string }>;
      timesheet: { periods: { weekly: { days: Array<{ date: string }> } } };
    };

    expect(overview.user.email).toBe(user.email);
    expect(overview.session.status).toBe('clocked_out');
    expect(overview.session.id).toBeNull();
    expect(overview.today.activeMinutes).toBeGreaterThan(0);
    expect(overview.today.breaksCount).toBeGreaterThan(0);
    expect(overview.requests.length).toBe(1);
    expect(overview.timesheet.periods.weekly.days.length).toBeGreaterThan(0);
  });
});

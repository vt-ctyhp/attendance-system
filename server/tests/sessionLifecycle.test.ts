import { expect, describe, it, vi } from 'vitest';
import { startOfMinute } from 'date-fns';
import { prisma } from '../src/prisma';
import { startSession, endSession } from '../src/routes/sessions';
import { heartbeat, recordSimpleEvent } from '../src/routes/events';
import { callHandler } from './utils';

describe('Session lifecycle', () => {
  it('starts a session, records heartbeat stats, and ends session', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    await prisma.user.create({
      data: {
        email: 'smoke@test.local',
        name: 'Session Lifecycle',
        role: 'employee',
        passwordHash: 'hash',
        active: true
      }
    });

    const sessionStart = await callHandler<{ sessionId: string; userId: number }>(startSession, {
      body: {
        email: 'smoke@test.local',
        deviceId: 'device-123',
        platform: 'test'
      }
    });

    expect(sessionStart.status).toBe(201);
    expect(sessionStart.data).not.toBeNull();
    const sessionId = sessionStart.data!.sessionId;
    const userId = sessionStart.data!.userId;

    const heartbeatTs = new Date(Date.now() + 60_000);
    const heartbeatResponse = await callHandler(heartbeat, {
      body: {
        sessionId,
        timestamp: heartbeatTs.toISOString(),
        activeMinute: true,
        idleFlag: false,
        idleSeconds: null,
        keysCount: 5,
        mouseCount: 1,
        foregroundAppTitle: null,
        foregroundAppOwner: null,
        activityBuckets: [],
        platform: 'cli'
      }
    });

    expect(heartbeatResponse.status).toBe(200);
    expect(heartbeatResponse.data).not.toBeNull();
    expect((heartbeatResponse.data as any).status).toBe('ok');

    const breakStartAt = new Date(Date.now() + 120_000);
    const breakEndAt = new Date(breakStartAt.getTime() + 300_000);
    await recordSimpleEvent({ sessionId, timestamp: breakStartAt.toISOString() }, 'break_start');
    await recordSimpleEvent({ sessionId, timestamp: breakEndAt.toISOString() }, 'break_end');

    const pause = await prisma.sessionPause.findFirst({
      where: { sessionId, type: 'break' },
      orderBy: { sequence: 'desc' }
    });
    expect(pause).not.toBeNull();
    expect(pause!.sequence).toBe(1);
    expect(pause!.durationMinutes).toBe(5);
    expect(pause!.endedAt).not.toBeNull();
    expect(pause!.endedAt?.toISOString()).toBe(breakEndAt.toISOString());

    const simpleEvent = await prisma.event.findFirst({
      where: { sessionId, type: 'break_start' },
      orderBy: { ts: 'desc' }
    });
    expect(simpleEvent).not.toBeNull();
    expect(simpleEvent!.payload).toContain('timestamp');

    const minuteStat = await prisma.minuteStat.findUnique({
      where: {
        sessionId_minuteStart: {
          sessionId,
          minuteStart: startOfMinute(heartbeatTs)
        }
      }
    });

    expect(minuteStat).not.toBeNull();
    expect(minuteStat!.active).toBe(true);
    expect(minuteStat!.idle).toBe(false);
    expect(minuteStat!.keysCount).toBe(5);

    const sessionEnd = await callHandler(endSession, {
      body: { sessionId }
    });
    expect(sessionEnd.status).toBe(200);
    expect(sessionEnd.data).not.toBeNull();
    expect((sessionEnd.data as any).session.status).toBe('ended');

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(session).not.toBeNull();
    expect(session!.status).toBe('ended');
    expect(session!.presencePlanCount).toBe(2);

    const prompts = await prisma.presencePrompt.findMany({ where: { sessionId } });
    expect(prompts.length).toBe(2);

    const events = await prisma.event.findMany({ where: { sessionId }, orderBy: { ts: 'asc' } });
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toEqual(expect.arrayContaining(['login', 'heartbeat', 'break_start', 'break_end', 'logout']));
    const loginEvent = events.find((event) => event.type === 'login');
    expect(loginEvent?.payload).toContain('device-123');
    const heartbeatEvent = events.find((event) => event.type === 'heartbeat');
    expect(heartbeatEvent?.payload).toContain('keysCount');

    const balance = await prisma.ptoBalance.findUnique({ where: { userId } });
    expect(balance).toBeNull();
  });
});

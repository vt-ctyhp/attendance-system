import { describe, expect, it } from 'vitest';
import { callHandler } from './utils';
import { startSession, getSessionPauses } from '../src/routes/sessions';
import { recordSimpleEvent } from '../src/routes/events';
import { prisma } from '../src/prisma';
import { setEmailSessionEnabled } from '../src/services/featureFlags';
import { fetchDailySummaries } from '../src/routes/dashboard';

const iso = (value: string) => new Date(value).toISOString();

describe('Session pauses API', () => {
  it('returns current and historical pauses', async () => {
    await setEmailSessionEnabled(true);
    const user = await prisma.user.create({
      data: {
        email: 'pause-test@example.com',
        name: 'Pause Tester',
        role: 'employee',
        passwordHash: 'placeholder',
        active: true
      }
    });

    const startResponse = await callHandler<{ sessionId: string }>(startSession, {
      body: { email: user.email, deviceId: 'device-pause', platform: 'test' }
    });
    expect(startResponse.status).toBe(201);
    const sessionId = startResponse.data?.sessionId;
    expect(sessionId).toBeTruthy();

    await prisma.session.update({
      where: { id: sessionId },
      data: { startedAt: new Date('2025-01-01T08:00:00Z') }
    });

    await recordSimpleEvent(
      { sessionId, timestamp: iso('2025-01-01T09:00:00Z') },
      'break_start'
    );

    const pauseDuring = await callHandler(getSessionPauses, {
      params: { sessionId }
    });
    expect(pauseDuring.status).toBe(200);
    const currentPayload = pauseDuring.data as { current: { kind: string; sequence: number } | null; history: unknown[] };
    expect(currentPayload.current).not.toBeNull();
    expect(currentPayload?.current?.kind).toBe('break');
    expect(currentPayload?.history).toHaveLength(0);

    await recordSimpleEvent(
      { sessionId, timestamp: iso('2025-01-01T09:05:30Z') },
      'break_end'
    );

    const pauseAfter = await callHandler(getSessionPauses, {
      params: { sessionId }
    });
    expect(pauseAfter.status).toBe(200);
    const afterData = pauseAfter.data as {
      current: { kind: string } | null;
      history: Array<{ kind: string; durationMinutes: number }>;
    };
    expect(afterData.current).toBeNull();
    expect(afterData.history).toHaveLength(1);
    expect(afterData.history[0].kind).toBe('break');
    expect(afterData.history[0].durationMinutes).toBe(6);
  });

  it('aggregates pause durations in daily summaries', async () => {
    await setEmailSessionEnabled(true);
    const user = await prisma.user.create({
      data: {
        email: 'summary-test@example.com',
        name: 'Summary Tester',
        role: 'employee',
        passwordHash: 'placeholder',
        active: true
      }
    });

    const startResponse = await callHandler<{ sessionId: string }>(startSession, {
      body: { email: user.email, deviceId: 'device-summary', platform: 'test' }
    });
    expect(startResponse.status).toBe(201);
    const sessionId = startResponse.data?.sessionId;
    expect(sessionId).toBeTruthy();

    const reference = new Date('2025-02-01T12:00:00Z');
    await prisma.session.update({
      where: { id: sessionId },
      data: { startedAt: reference }
    });

    await recordSimpleEvent(
      { sessionId, timestamp: iso('2025-02-01T14:00:00Z') },
      'break_start'
    );
    await recordSimpleEvent(
      { sessionId, timestamp: iso('2025-02-01T14:12:00Z') },
      'break_end'
    );

    const summary = await fetchDailySummaries(reference);
    expect(summary.summaries).toHaveLength(1);
    expect(summary.totals.breakMinutes).toBe(12);
    expect(summary.totals.breaks).toBe(1);
    expect(summary.pauses).toHaveLength(1);
    expect(summary.pauses[0].durationMinutes).toBe(12);
  });
});

import { addMinutes } from 'date-fns';
import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/prisma';
import {
  ensurePresencePlan,
  getDuePrompt,
  triggerPrompt,
  confirmPrompt
} from '../src/services/presenceScheduler';

describe('Presence scheduler', () => {
  it('creates deterministic prompt schedule and records confirmation', async () => {
    const startedAt = new Date('2024-02-01T08:00:00Z');
    const user = await prisma.user.create({
      data: {
        email: 'presence@test.local',
        name: 'Presence User',
        role: 'employee',
        passwordHash: 'placeholder'
      }
    });

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        deviceId: 'presence-device',
        startedAt,
        status: 'active'
      }
    });

    const randomSpy = vi.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(0);

    const prompts = await ensurePresencePlan(session.id, startedAt);
    expect(prompts.length).toBe(2);

    const [firstPrompt, secondPrompt] = prompts;
    expect(firstPrompt.scheduledAt.getTime()).toBe(addMinutes(startedAt, 30).getTime());
    expect(secondPrompt.scheduledAt.getTime()).toBe(addMinutes(startedAt, 120).getTime());

    const due = await getDuePrompt(session.id, addMinutes(startedAt, 31));
    expect(due).not.toBeNull();

    const triggered = await triggerPrompt(due!.id, due!.scheduledAt!);
    expect(triggered.status).toBe('triggered');
    expect(triggered.expiresAt).not.toBeNull();

    const confirmationTime = addMinutes(startedAt, 31);
    const confirmed = await confirmPrompt(triggered.id, confirmationTime);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.respondedAt?.getTime()).toBe(confirmationTime.getTime());

    const nextDue = await getDuePrompt(session.id, addMinutes(startedAt, 200));
    expect(nextDue?.id).toBe(secondPrompt.id);
  });
});

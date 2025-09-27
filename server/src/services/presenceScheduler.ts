import { addMinutes, differenceInMinutes } from 'date-fns';
import { prisma } from '../prisma';
import { logger } from '../logger';

const MIN_GAP_MINUTES = 90;
const FIRST_WINDOW_MINUTES = { min: 30, max: 240 };
const SECOND_EXTRA_MINUTES = { min: MIN_GAP_MINUTES, max: 240 };
const CHECK_EXPIRATION_SECONDS = 60;
const MONITOR_INTERVAL_MS = 15000;

const randBetween = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

export const ensurePresencePlan = async (sessionId: string, startedAt: Date) => {
  const existing = await prisma.presencePrompt.findMany({ where: { sessionId }, orderBy: { scheduledAt: 'asc' } });
  if (existing.length >= 2) {
    return existing;
  }
  const firstOffset = randBetween(FIRST_WINDOW_MINUTES.min, FIRST_WINDOW_MINUTES.max);
  const firstAt = addMinutes(startedAt, firstOffset);
  const secondOffset = firstOffset + randBetween(SECOND_EXTRA_MINUTES.min, SECOND_EXTRA_MINUTES.max);
  const secondAt = addMinutes(startedAt, secondOffset);

  const data = [firstAt, secondAt]
    .slice(existing.length)
    .map((scheduledAt) => ({ sessionId, scheduledAt }));

  if (data.length) {
    await prisma.presencePrompt.createMany({ data });
  }
  return prisma.presencePrompt.findMany({ where: { sessionId }, orderBy: { scheduledAt: 'asc' } });
};

export const getDuePrompt = async (sessionId: string, now: Date) =>
  prisma.presencePrompt.findFirst({
    where: {
      sessionId,
      status: 'scheduled',
      scheduledAt: { lte: now }
    },
    orderBy: { scheduledAt: 'asc' }
  });

export const triggerPrompt = async (promptId: string, now: Date) => {
  const expiresAt = new Date(now.getTime() + CHECK_EXPIRATION_SECONDS * 1000);
  return prisma.presencePrompt.update({
    where: { id: promptId },
    data: {
      status: 'triggered',
      triggeredAt: now,
      expiresAt
    }
  });
};

export const delayPrompt = async (promptId: string, minutes: number) => {
  const prompt = await prisma.presencePrompt.findUnique({ where: { id: promptId } });
  if (!prompt) return null;
  const next = addMinutes(new Date(), minutes);
  return prisma.presencePrompt.update({
    where: { id: promptId },
    data: {
      scheduledAt: next,
      status: 'scheduled',
      triggeredAt: null,
      expiresAt: null
    }
  });
};

export const confirmPrompt = async (promptId: string, now: Date) =>
  prisma.presencePrompt.update({
    where: { id: promptId },
    data: {
      status: 'confirmed',
      respondedAt: now
    }
  });

export const expirePrompts = async (now: Date) => {
  const expired = await prisma.presencePrompt.findMany({
    where: {
      status: 'triggered',
      expiresAt: { lte: now },
      respondedAt: null
    },
    take: 20
  });
  if (!expired.length) return expired;
  const ids = expired.map((p) => p.id);
  await prisma.presencePrompt.updateMany({
    where: { id: { in: ids } },
    data: {
      status: 'missed',
      respondedAt: now
    }
  });
  for (const prompt of expired) {
    await prisma.event.create({
      data: {
        sessionId: prompt.sessionId,
        type: 'presence_miss',
        payload: JSON.stringify({
          promptId: prompt.id,
          scheduledAt: prompt.scheduledAt,
          triggeredAt: prompt.triggeredAt,
          expiresAt: prompt.expiresAt,
          recordedAt: now
        })
      }
    });
    logger.warn({ promptId: prompt.id, sessionId: prompt.sessionId }, 'Presence check missed');
  }
  return expired;
};

let monitor: NodeJS.Timeout | null = null;

export const startPresenceMonitor = () => {
  if (monitor) return;
  monitor = setInterval(() => {
    expirePrompts(new Date()).catch((err) => logger.error({ err }, 'Failed to expire prompts'));
  }, MONITOR_INTERVAL_MS);
};

export const stopPresenceMonitor = () => {
  if (monitor) {
    clearInterval(monitor);
    monitor = null;
  }
};

export const isEligibleForPrompt = (events: string[]) => {
  const last = [...events].reverse().find((event) => ['break_start', 'break_end', 'lunch_start', 'lunch_end'].includes(event));
  if (!last) return true;
  if (last === 'break_start' || last === 'lunch_start') return false;
  return true;
};

export const minutesBetweenPrompts = (promptA: Date, promptB: Date) => Math.abs(differenceInMinutes(promptA, promptB));

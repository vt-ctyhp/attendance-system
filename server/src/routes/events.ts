import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import {
  confirmPrompt,
  delayPrompt,
  ensurePresencePlan,
  expirePrompts,
  getDuePrompt,
  triggerPrompt
} from '../services/presenceScheduler';
import { getSessionState } from '../services/sessionState';
import { startOfMinute, differenceInMinutes } from 'date-fns';
import type { EventType } from '../types';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { HttpError } from '../errors';
import { createRateLimiter } from '../middleware/rateLimit';
import { logger } from '../logger';

const heartbeatSchema = z.object({
  sessionId: z.string().min(1),
  timestamp: z.string().datetime(),
  activeMinute: z.boolean(),
  idleFlag: z.boolean(),
  idleSeconds: z.number().min(0).nullable().optional(),
  keysCount: z.number().int().min(0).optional().default(0),
  mouseCount: z.number().int().min(0).optional().default(0),
  foregroundAppTitle: z.string().optional().nullable(),
  foregroundAppOwner: z.string().optional().nullable(),
  activityBuckets: z
    .array(
      z.object({
        minute: z.string(),
        keys: z.number().int().min(0),
        mouse: z.number().int().min(0)
      })
    )
    .optional(),
  platform: z.string().optional()
});

type HeartbeatInput = z.infer<typeof heartbeatSchema>;

const simpleEventSchema = z.object({
  sessionId: z.string().min(1),
  timestamp: z.string().datetime().optional()
});

const presenceConfirmSchema = z.object({
  sessionId: z.string().min(1),
  promptId: z.string().min(1),
  timestamp: z.string().datetime()
});

export const eventsRouter = Router();

const heartbeatRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 240,
  message: 'Heartbeat rate exceeded',
  keyResolver: (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body.sessionId === 'string') {
      return `session:${body.sessionId}`;
    }
    return req.ip ?? 'unknown';
  }
});

const requireActiveSession = async (sessionId: string, context?: { reqId?: string; type?: string }) => {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    logger.warn(
      {
        reqId: context?.reqId ?? null,
        sessionId,
        type: context?.type ?? null
      },
      'requireActiveSession:not_found'
    );
    throw HttpError.notFound('Session not found', { field: 'sessionId', hint: 'Start a session before sending activity events' });
  }
  if (session.status !== 'active') {
    logger.warn(
      {
        reqId: context?.reqId ?? null,
        sessionId,
        type: context?.type ?? null,
        status: session.status
      },
      'requireActiveSession:not_active'
    );
    throw HttpError.badRequest('Session not active', {
      field: 'sessionId',
      hint: 'Restart the session before submitting break or lunch events'
    });
  }
  logger.debug(
    {
      reqId: context?.reqId ?? null,
      sessionId,
      type: context?.type ?? null,
      status: session.status
    },
    'requireActiveSession:ok'
  );
  return session;
};

export const heartbeat: RequestHandler = async (req, res) => {
  const {
    sessionId,
    timestamp,
    activeMinute,
    idleFlag,
    idleSeconds,
    keysCount,
    mouseCount,
    foregroundAppTitle,
    foregroundAppOwner,
    activityBuckets,
    platform
  } = parseWithSchema<HeartbeatInput>(heartbeatSchema, req.body);
  const ts = new Date(timestamp);
  const minuteStart = startOfMinute(ts);

  const reqId = (req as { debugReqId?: string }).debugReqId;

  const session = await requireActiveSession(sessionId, { reqId, type: 'heartbeat' });

  logger.debug(
    {
      reqId: reqId ?? null,
      sessionId,
      idleFlag,
      activeMinute,
      timestamp,
      keysCount,
      mouseCount
    },
    'events.heartbeat'
  );

  await ensurePresencePlan(session.id, session.startedAt);
  await expirePrompts(new Date());

  await prisma.minuteStat.upsert({
    where: {
      sessionId_minuteStart: {
        sessionId,
        minuteStart
      }
    },
    update: {
      active: activeMinute,
      idle: idleFlag,
      keysCount,
      mouseCount,
      fgApp: foregroundAppTitle || null
    },
    create: {
      sessionId,
      minuteStart,
      active: activeMinute,
      idle: idleFlag,
      keysCount,
      mouseCount,
      fgApp: foregroundAppTitle || null
    }
  });

  await prisma.event.create({
    data: {
      sessionId,
      type: 'heartbeat',
      ts,
      payload: JSON.stringify({
        activeMinute,
        idleFlag,
        idleSeconds: idleSeconds ?? null,
        keysCount,
        mouseCount,
        foregroundAppTitle,
        foregroundAppOwner,
        activityBuckets,
        platform
      })
    }
  });

  let prompt = await prisma.presencePrompt.findFirst({
    where: {
      sessionId,
      status: 'triggered',
      respondedAt: null
    },
    orderBy: { scheduledAt: 'asc' }
  });

  if (!prompt) {
    const due = await getDuePrompt(sessionId, ts);
    if (due) {
      const { onBreak, onLunch } = await getSessionState(sessionId);
      if (onBreak || onLunch) {
        await delayPrompt(due.id, 5);
      } else {
        prompt = await triggerPrompt(due.id, ts);
        await prisma.event.create({
          data: {
            sessionId,
            type: 'presence_check',
            ts,
            payload: JSON.stringify({
              promptId: prompt.id,
              scheduledAt: prompt.scheduledAt,
              expiresAt: prompt.expiresAt,
              triggeredAt: prompt.triggeredAt,
              reason: 'heartbeat_due'
            })
          }
        });
      }
    }
  }

  return res.json({
    status: 'ok',
    presencePrompt: prompt
      ? {
          id: prompt.id,
          scheduledAt: prompt.scheduledAt,
          expiresAt: prompt.expiresAt,
          status: prompt.status
        }
      : null
  });
};

eventsRouter.post('/heartbeat', heartbeatRateLimiter, asyncHandler(heartbeat));

type PauseKind = 'break' | 'lunch';
type PauseAction = 'start' | 'end';

interface PauseResult {
  kind: PauseKind;
  action: PauseAction;
  sequence: number;
  startedAt: Date;
  endedAt?: Date;
  durationMinutes?: number;
}

const pauseMetaByEvent: Partial<Record<EventType, { kind: PauseKind; action: PauseAction }>> = {
  break_start: { kind: 'break', action: 'start' },
  break_end: { kind: 'break', action: 'end' },
  lunch_start: { kind: 'lunch', action: 'start' },
  lunch_end: { kind: 'lunch', action: 'end' }
};

const createPause = async (sessionId: string, kind: PauseKind, ts: Date): Promise<PauseResult> => {
  const existingOpen = await prisma.sessionPause.findFirst({
    where: { sessionId, type: kind, endedAt: null },
    orderBy: { startedAt: 'desc' }
  });
  if (existingOpen) {
    return {
      kind,
      action: 'start',
      sequence: existingOpen.sequence,
      startedAt: existingOpen.startedAt
    };
  }
  const existingCount = await prisma.sessionPause.count({ where: { sessionId, type: kind } });
  const pause = await prisma.sessionPause.create({
    data: {
      sessionId,
      type: kind,
      sequence: existingCount + 1,
      startedAt: ts
    }
  });
  return { kind, action: 'start', sequence: pause.sequence, startedAt: pause.startedAt };
};

const completePause = async (sessionId: string, kind: PauseKind, ts: Date): Promise<PauseResult | undefined> => {
  const pause = await prisma.sessionPause.findFirst({
    where: { sessionId, type: kind, endedAt: null },
    orderBy: { startedAt: 'desc' }
  });
  if (!pause) {
    logger.warn({ sessionId, kind }, 'pause.complete.missing_open_record');
    return undefined;
  }
  const durationMinutes = Math.max(0, Math.ceil((ts.getTime() - pause.startedAt.getTime()) / 60_000));
  const updated = await prisma.sessionPause.update({
    where: { id: pause.id },
    data: { endedAt: ts, durationMinutes }
  });
  return {
    kind,
    action: 'end',
    sequence: updated.sequence,
    startedAt: updated.startedAt,
    endedAt: updated.endedAt ?? ts,
    durationMinutes: updated.durationMinutes ?? durationMinutes
  };
};

const handlePause = async (sessionId: string, meta: { kind: PauseKind; action: PauseAction }, ts: Date) =>
  (meta.action === 'start' ? createPause(sessionId, meta.kind, ts) : completePause(sessionId, meta.kind, ts));

const serializePause = (pause: PauseResult) => ({
  kind: pause.kind,
  action: pause.action,
  sequence: pause.sequence,
  startedAt: pause.startedAt.toISOString(),
  endedAt: pause.endedAt ? pause.endedAt.toISOString() : null,
  durationMinutes: pause.durationMinutes ?? null
});

export const recordSimpleEvent = async (
  body: unknown,
  type: EventType,
  context?: { reqId?: string }
): Promise<{ pause?: ReturnType<typeof serializePause> }> => {
  const { sessionId, timestamp } = parseWithSchema(simpleEventSchema, body);
  await requireActiveSession(sessionId, { reqId: context?.reqId, type });
  const ts = timestamp ? new Date(timestamp) : new Date();
  const pauseMeta = pauseMetaByEvent[type];
  const pause = pauseMeta ? await handlePause(sessionId, pauseMeta, ts) : undefined;
  await prisma.event.create({
    data: {
      sessionId,
      type,
      ts,
      payload: JSON.stringify({ timestamp: ts })
    }
  });
  logger.debug(
    {
      reqId: context?.reqId ?? null,
      sessionId,
      type,
      timestamp: ts.toISOString(),
      pause: pause ? { kind: pause.kind, sequence: pause.sequence } : null
    },
    'events.simple'
  );
  return pause ? { pause: serializePause(pause) } : {};
};

const simpleRoutes: Array<{ path: string; type: EventType }> = [
  { path: '/break/start', type: 'break_start' },
  { path: '/break/end', type: 'break_end' },
  { path: '/lunch/start', type: 'lunch_start' },
  { path: '/lunch/end', type: 'lunch_end' }
];

for (const { path, type } of simpleRoutes) {
  eventsRouter.post(
    path,
    heartbeatRateLimiter,
    asyncHandler(async (req, res) => {
      const reqId = (req as { debugReqId?: string }).debugReqId;
      logger.debug(
        {
          reqId: reqId ?? null,
          path,
          type,
          body: req.body
        },
        'events.simple.request'
      );
      const result = await recordSimpleEvent(req.body, type, { reqId });
      if (result.pause) {
        return res.status(200).json({ status: 'ok', pause: result.pause });
      }
      return res.status(204).send();
    })
  );
}

eventsRouter.post(
  '/presence/confirm',
  heartbeatRateLimiter,
  asyncHandler(async (req, res) => {
    const { sessionId, promptId, timestamp } = parseWithSchema(presenceConfirmSchema, req.body);
    await requireActiveSession(sessionId);

    const prompt = await prisma.presencePrompt.findUnique({ where: { id: promptId } });
    if (!prompt) {
      throw HttpError.notFound('Prompt not found');
    }
    if (prompt.status === 'missed') {
      throw HttpError.conflict('Prompt already missed');
    }

    await confirmPrompt(promptId, new Date(timestamp));
    await prisma.event.create({
      data: {
        sessionId,
        type: 'presence_check',
        ts: new Date(timestamp),
        payload: JSON.stringify({
          promptId,
          status: 'confirmed'
        })
      }
    });

    return res.status(204).send();
  })
);

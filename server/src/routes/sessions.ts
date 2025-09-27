import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashPassword } from '../auth';
import { prisma } from '../prisma';
import { ensurePresencePlan } from '../services/presenceScheduler';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { HttpError } from '../errors';
import { createRateLimiter } from '../middleware/rateLimit';
import { isEmailSessionEnabled, isIpAllowed, isClientHeaderValid } from '../services/featureFlags';
import { issueEmployeeTokens, rotateEmployeeTokens } from '../services/tokenService';
import { recordAuthEvent } from '../services/audit';
import { incrementMetric } from '../services/metrics';
import { logger } from '../logger';

const startSchema = z.object({
  email: z.string().email(),
  deviceId: z.string().min(3),
  platform: z.string().optional()
});

const endSchema = z.object({
  sessionId: z.string().min(1)
});

const emailStartSchema = z.object({
  flow: z.literal('email_only'),
  email: z.string().email(),
  deviceId: z.string().min(3).optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(32)
});

export const sessionsRouter = Router();

const sessionRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 15,
  message: 'Session endpoint rate limit exceeded'
});

const emailSessionIpLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 6,
  message: 'Too many attempts'
});

const emailSessionAddressLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 4,
  message: 'Too many attempts',
  keyResolver: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'unknown';
    return `email:${email}`;
  }
});

const refreshLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many refresh attempts'
});

const runLimiter = (limiter: RequestHandler, req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
  new Promise<void>((resolve, reject) => {
    limiter(req, res, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

const unauthorizedError = () => HttpError.unauthorized('Unauthorized');

const handleEmailOnlyStart = async (req: Request, res: Response) => {
  const reqId = (req as { debugReqId?: string }).debugReqId;
  await runLimiter(emailSessionIpLimiter, req, res);
  await runLimiter(emailSessionAddressLimiter, req, res);

  const { email, deviceId } = parseWithSchema(emailStartSchema, req.body);
  const normalizedEmail = email.trim().toLowerCase();
  const ipAddress = req.ip;
  const userAgent = req.get('user-agent') ?? undefined;

  const logAttempt = async (success: boolean, reason: string, userId?: number) => {
    await recordAuthEvent({
      event: 'email_session_attempt',
      email: normalizedEmail,
      userId,
      success,
      reason,
      ipAddress,
      userAgent,
      deviceId
    });
  };

  if (!(await isEmailSessionEnabled())) {
    incrementMetric('email_session_flag_disabled');
    await logAttempt(false, 'flag_disabled');
    throw unauthorizedError();
  }

  if (!isIpAllowed(req)) {
    incrementMetric('email_session_ip_blocked');
    await logAttempt(false, 'ip_blocked');
    throw unauthorizedError();
  }

  if (!isClientHeaderValid(req)) {
    incrementMetric('email_session_header_invalid');
    await logAttempt(false, 'client_header_invalid');
    throw unauthorizedError();
  }

  let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    const passwordHash = await hashPassword(randomUUID());
    const defaultName = normalizedEmail.split('@')[0] || normalizedEmail;
    user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: defaultName,
        role: 'employee',
        passwordHash,
        active: true
      }
    });
    await logAttempt(true, 'auto_created', user.id);
  } else {
    if (user.role !== 'employee') {
      await logAttempt(false, 'user_not_found');
      throw unauthorizedError();
    }

    if (!user.active) {
      await logAttempt(false, 'user_inactive', user.id);
      throw unauthorizedError();
    }

    await logAttempt(true, 'ok', user.id);
  }

  const tokens = await issueEmployeeTokens({
    userId: user.id,
    email: user.email,
    deviceId,
    ipAddress,
    userAgent
  });

  incrementMetric('email_session_success');

  logger.debug({ reqId, email: user.email, userId: user.id }, 'session.email_only.issued_tokens');

  return res.json({
    tokenType: 'Bearer',
    scope: tokens.scope,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString()
  });
};

export const startSession: RequestHandler = async (req, res) => {
  const reqId = (req as { debugReqId?: string }).debugReqId;
  if (req.body?.flow === 'email_only') {
    return handleEmailOnlyStart(req, res);
  }
  const { email, deviceId, platform } = parseWithSchema(startSchema, req.body);

  const trimmedEmail = email.trim();
  const normalizedEmail = trimmedEmail.toLowerCase();

  let user = await prisma.user.findUnique({ where: { email: trimmedEmail } });
  if (!user && normalizedEmail !== trimmedEmail) {
    user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  }

  if (!user) {
    const passwordHash = await hashPassword(randomUUID());
    const defaultName = trimmedEmail.split('@')[0] || normalizedEmail;
    user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: defaultName,
        role: 'employee',
        passwordHash,
        active: true
      }
    });
  }

  const active = await prisma.session.findFirst({
    where: { userId: user.id, status: 'active' },
    orderBy: { startedAt: 'desc' }
  });

  if (active) {
    const requiresDeviceUpdate = active.deviceId !== deviceId;
    if (requiresDeviceUpdate) {
      await prisma.session.update({
        where: { id: active.id },
        data: { deviceId }
      });
    }

    logger.debug(
      {
        reqId,
        userId: user.id,
        deviceId,
        sessionId: active.id,
        existing: true,
        deviceUpdated: requiresDeviceUpdate
      },
      'session.start.reused'
    );

    return res.status(200).json({
      sessionId: active.id,
      email: user.email,
      userId: user.id,
      existing: true
    });
  }

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      deviceId,
      status: 'active'
    }
  });

  const prompts = await ensurePresencePlan(session.id, session.startedAt);
  if (session.presencePlanCount !== prompts.length) {
    await prisma.session.update({
      where: { id: session.id },
      data: { presencePlanCount: prompts.length }
    });
  }
  await prisma.event.create({
    data: {
      sessionId: session.id,
      type: 'login',
      payload: JSON.stringify({ platform, deviceId })
    }
  });

  logger.debug({ reqId, userId: user.id, sessionId: session.id, deviceId }, 'session.start.created');

  return res.status(201).json({
    sessionId: session.id,
    email: user.email,
    userId: user.id
  });
};

export const endSession: RequestHandler = async (req, res) => {
  const { sessionId } = parseWithSchema(endSchema, req.body);

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    throw HttpError.notFound('Session not found', { field: 'sessionId', hint: 'Start a session before ending it' });
  }
  if (session.status !== 'active') {
    throw HttpError.badRequest('Session already ended', {
      field: 'sessionId',
      hint: 'Start a new session before attempting further actions'
    });
  }

  const endedAt = new Date();
  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: {
      status: 'ended',
      endedAt
    }
  });

  await prisma.event.create({
    data: {
      sessionId,
      type: 'logout',
      payload: JSON.stringify({ endedAt })
    }
  });

  return res.json({
    session: {
      id: updated.id,
      startedAt: updated.startedAt,
      endedAt: updated.endedAt,
      status: updated.status
    }
  });
};

sessionsRouter.post('/start', sessionRateLimiter, asyncHandler(startSession));
sessionsRouter.post('/end', sessionRateLimiter, asyncHandler(endSession));

const serializeSessionPause = (
  pause: {
    id: string;
    type: string;
    sequence: number;
    startedAt: Date;
    endedAt: Date | null;
    durationMinutes: number | null;
  },
  now: Date
) => {
  const durationMinutes =
    pause.durationMinutes ?? Math.max(0, Math.ceil((now.getTime() - pause.startedAt.getTime()) / 60_000));
  return {
    id: pause.id,
    kind: pause.type,
    sequence: pause.sequence,
    startedAt: pause.startedAt.toISOString(),
    endedAt: pause.endedAt ? pause.endedAt.toISOString() : null,
    durationMinutes
  };
};

export const getSessionPauses: RequestHandler = async (req, res) => {
  const { sessionId } = req.params;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      pauses: {
        orderBy: { startedAt: 'asc' }
      }
    }
  });

  if (!session) {
    throw HttpError.notFound('Session not found');
  }

  const now = new Date();
  const currentPause = session.pauses.find((pause) => pause.endedAt === null);
  const historyPauses = session.pauses.filter((pause) => pause.endedAt !== null);

  return res.json({
    current: currentPause ? serializeSessionPause(currentPause, now) : null,
    history: historyPauses.map((pause) => serializeSessionPause(pause, now))
  });
};

sessionsRouter.get('/:sessionId/pauses', sessionRateLimiter, asyncHandler(getSessionPauses));

const refreshSession: RequestHandler = async (req, res) => {
  const { refreshToken } = parseWithSchema(refreshSchema, req.body);

  if (!(await isEmailSessionEnabled())) {
    incrementMetric('email_session_refresh_flag_disabled');
    throw unauthorizedError();
  }

  try {
    const rotation = await rotateEmployeeTokens({
      refreshToken,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined
    });

    incrementMetric('email_session_refresh_success');
    await recordAuthEvent({
      event: 'email_session_attempt',
      email: rotation.email,
      userId: rotation.userId,
      success: true,
      reason: 'refresh_ok',
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined
    });

    return res.json({
      tokenType: 'Bearer',
      scope: rotation.result.scope,
      accessToken: rotation.result.accessToken,
      accessTokenExpiresAt: rotation.result.accessTokenExpiresAt.toISOString(),
      refreshToken: rotation.result.refreshToken,
      refreshTokenExpiresAt: rotation.result.refreshTokenExpiresAt.toISOString()
    });
  } catch (error) {
    let reason = 'refresh_failed';
    let emailForLog = 'unknown';
    let userId: number | undefined;

    if (error instanceof Error && 'code' in error) {
      reason = String((error as Error & { code?: string }).code ?? error.message ?? 'refresh_failed');
      const meta = (error as Error & { meta?: Record<string, unknown> }).meta;
      if (meta && typeof meta.userId === 'number') {
        userId = meta.userId;
      }
    } else if (error instanceof Error && error.message) {
      reason = error.message;
    }

    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user) {
        emailForLog = user.email;
      }
    }

    incrementMetric(`email_session_refresh_error_${reason}`);
    logger.warn({ reason }, 'Email session refresh denied');
    await recordAuthEvent({
      event: 'email_session_attempt',
      email: emailForLog,
      userId,
      success: false,
      reason,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined
    });
    throw unauthorizedError();
  }
};

sessionsRouter.post('/refresh', refreshLimiter, asyncHandler(refreshSession));

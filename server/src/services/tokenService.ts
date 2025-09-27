import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../env';
import { prisma } from '../prisma';
import { recordAuthEvent } from './audit';
import { incrementMetric } from './metrics';

export const EMPLOYEE_SESSION_SCOPE = 'employee_session';
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60; // 10 minutes
const REFRESH_TOKEN_TTL_MINUTES = 60 * 24; // 24 hours

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const generateTokenString = () => crypto.randomBytes(48).toString('base64url');

const createTokenError = (code: string, meta?: Record<string, unknown>) =>
  Object.assign(new Error(code), { code, meta });

const generateAccessToken = (userId: number, scope: string) =>
  jwt.sign(
    {
      sub: userId,
      role: 'employee',
      scope,
      typ: 'access'
    },
    env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  ) as string;

type IssueOptions = {
  userId: number;
  email: string;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
};

type IssueResult = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  scope: string;
};

const revokeTokenRecord = async (tokenId: string, reason: string) => {
  await prisma.refreshToken.update({
    where: { id: tokenId },
    data: {
      revokedAt: new Date(),
      revokedReason: reason
    }
  });
};

const revokeAllTokensForUser = async (userId: number, reason: string) => {
  await prisma.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null
    },
    data: {
      revokedAt: new Date(),
      revokedReason: reason
    }
  });
};

export const issueEmployeeTokens = async ({
  userId,
  email,
  deviceId,
  ipAddress,
  userAgent
}: IssueOptions): Promise<IssueResult> => {
  const accessToken = generateAccessToken(userId, EMPLOYEE_SESSION_SCOPE);
  const refreshToken = generateTokenString();
  const tokenHash = hashToken(refreshToken);
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MINUTES * 60 * 1000);

  const record = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      scope: EMPLOYEE_SESSION_SCOPE,
      deviceId,
      ipAddress,
      userAgent,
      expiresAt: refreshTokenExpiresAt
    }
  });

  await recordAuthEvent({
    event: 'email_session_token_issued',
    email,
    userId,
    scope: EMPLOYEE_SESSION_SCOPE,
    accessExpiresAt: accessTokenExpiresAt,
    refreshExpiresAt: refreshTokenExpiresAt,
    ipAddress,
    userAgent,
    deviceId
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    scope: record.scope
  };
};

type RotateOptions = {
  refreshToken: string;
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
};

export const rotateEmployeeTokens = async ({
  refreshToken,
  ipAddress,
  userAgent,
  deviceId
}: RotateOptions): Promise<{ result: IssueResult; userId: number; email: string }> => {
  const tokenHash = hashToken(refreshToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    incrementMetric('email_session_refresh_missing');
    throw createTokenError('invalid_refresh_token');
  }

  if (existing.revokedAt) {
    incrementMetric('email_session_refresh_reuse');
    await revokeAllTokensForUser(existing.userId, 'reused_refresh_token');
    throw createTokenError('reused_refresh_token', { userId: existing.userId });
  }

  if (existing.expiresAt <= new Date()) {
    await revokeTokenRecord(existing.id, 'expired');
    incrementMetric('email_session_refresh_expired');
    throw createTokenError('expired_refresh_token', { userId: existing.userId });
  }

  const accessToken = generateAccessToken(existing.userId, existing.scope);
  const nextRefreshToken = generateTokenString();
  const nextTokenHash = hashToken(nextRefreshToken);
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MINUTES * 60 * 1000);

  const nextRecord = await prisma.refreshToken.create({
    data: {
      userId: existing.userId,
      tokenHash: nextTokenHash,
      scope: existing.scope,
      deviceId: deviceId ?? existing.deviceId,
      ipAddress: ipAddress ?? existing.ipAddress,
      userAgent: userAgent ?? existing.userAgent,
      expiresAt: refreshTokenExpiresAt
    }
  });

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: {
      revokedAt: new Date(),
      revokedReason: 'rotated',
      replacedByTokenId: nextRecord.id
    }
  });

  const user = await prisma.user.findUnique({ where: { id: existing.userId } });

  const emailForLog = user?.email ?? 'unknown';

  await recordAuthEvent({
    event: 'email_session_token_issued',
    email: emailForLog,
    userId: existing.userId,
    scope: nextRecord.scope,
    accessExpiresAt: accessTokenExpiresAt,
    refreshExpiresAt: refreshTokenExpiresAt,
    ipAddress: ipAddress ?? existing.ipAddress ?? undefined,
    userAgent: userAgent ?? existing.userAgent ?? undefined,
    deviceId: deviceId ?? existing.deviceId ?? undefined
  });

  return {
    result: {
      accessToken,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      scope: nextRecord.scope
    },
    userId: existing.userId,
    email: emailForLog
  };
};

export const revokeAllEmployeeTokens = async (userId: number, reason: string) => {
  await revokeAllTokensForUser(userId, reason);
};

import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../logger';

export type AuthEvent =
  | {
      event: 'email_session_attempt';
      email: string;
      userId?: number;
      success: boolean;
      reason: string;
      ipAddress?: string;
      userAgent?: string;
      deviceId?: string;
    }
  | {
      event: 'email_session_token_issued';
      email: string;
      userId: number;
      scope: string;
      accessExpiresAt: Date;
      refreshExpiresAt: Date;
      ipAddress?: string;
      userAgent?: string;
      deviceId?: string;
    };

const createAuditLog = async (data: Parameters<typeof prisma.authAuditLog.create>[0]['data']) => {
  try {
    await prisma.authAuditLog.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      await prisma.authAuditLog.create({ data: { ...data, userId: null } });
      return;
    }
    throw error;
  }
};

export const recordAuthEvent = async (input: AuthEvent) => {
  switch (input.event) {
    case 'email_session_attempt':
      await createAuditLog({
        email: input.email,
        userId: input.userId ?? null,
        event: input.event,
        success: input.success,
        reason: input.reason,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        deviceId: input.deviceId
      });
      logger.info(
        {
          event: input.event,
          email: input.email,
          userId: input.userId,
          success: input.success,
          reason: input.reason,
          ip: input.ipAddress,
          userAgent: input.userAgent,
          deviceId: input.deviceId
        },
        'Email session attempt'
      );
      break;
    case 'email_session_token_issued':
      await createAuditLog({
        email: input.email,
        userId: input.userId,
        event: input.event,
        success: true,
        reason: 'issued',
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        deviceId: input.deviceId
      });
      logger.info(
        {
          event: input.event,
          email: input.email,
          userId: input.userId,
          scope: input.scope,
          accessExpiresAt: input.accessExpiresAt.toISOString(),
          refreshExpiresAt: input.refreshExpiresAt.toISOString(),
          ip: input.ipAddress,
          userAgent: input.userAgent,
          deviceId: input.deviceId
        },
        'Issued email-session tokens'
      );
      break;
    default:
      break;
  }
};

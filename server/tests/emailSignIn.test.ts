import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { callHandler } from './utils';
import { startSession } from '../src/routes/sessions';
import { setEmailSessionEnabled } from '../src/services/featureFlags';
import { EMPLOYEE_SESSION_SCOPE, rotateEmployeeTokens } from '../src/services/tokenService';
import { requireRole } from '../src/auth';
import { HttpError } from '../src/errors';

const buildRequestHeaders = (scope: string) => ({
  tokenScope: scope
});

describe('Email-only session start', () => {
  it('rejects when feature flag disabled', async () => {
    await expect(
      callHandler(startSession, {
        body: { flow: 'email_only', email: 'employee@example.com' }
      })
    ).rejects.toHaveProperty('statusCode', 401);
  });

  it('issues short-lived tokens when flag enabled and employee is active', async () => {
    await setEmailSessionEnabled(true);

    const employee = await prisma.user.create({
      data: {
        email: 'worker@example.com',
        name: 'Worker Bee',
        role: 'employee',
        passwordHash: 'placeholder',
        active: true
      }
    });

    const result = await callHandler(startSession, {
      body: { flow: 'email_only', email: employee.email }
    });

    expect(result.status).toBe(200);
    expect(result.data).not.toBeNull();

    const payload = result.data as Record<string, unknown>;
    expect(typeof payload.accessToken).toBe('string');
    expect(typeof payload.refreshToken).toBe('string');
    expect(payload.scope).toBe(EMPLOYEE_SESSION_SCOPE);

    const decoded = jwt.verify(String(payload.accessToken), env.JWT_SECRET) as jwt.JwtPayload;
    expect(decoded.sub).toBe(employee.id);
    expect(decoded.scope).toBe(EMPLOYEE_SESSION_SCOPE);
    expect(decoded.role).toBe('employee');

    const refreshRecords = await prisma.refreshToken.findMany({ where: { userId: employee.id } });
    expect(refreshRecords).toHaveLength(1);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    await setEmailSessionEnabled(true);
    const employee = await prisma.user.create({
      data: {
        email: 'rotate@example.com',
        name: 'Rotate Example',
        role: 'employee',
        passwordHash: 'placeholder',
        active: true
      }
    });

    const start = await callHandler(startSession, {
      body: { flow: 'email_only', email: employee.email }
    });

    const initialPayload = start.data as Record<string, unknown>;
    const initialRefresh = String(initialPayload.refreshToken);

    const rotation = await rotateEmployeeTokens({ refreshToken: initialRefresh, ipAddress: '127.0.0.1' });
    expect(rotation.result.refreshToken).not.toEqual(initialRefresh);

    const records = await prisma.refreshToken.findMany({ where: { userId: employee.id }, orderBy: { createdAt: 'asc' } });
    expect(records[0].revokedAt).not.toBeNull();
    expect(records[0].revokedReason).toBe('rotated');

    await expect(rotateEmployeeTokens({ refreshToken: initialRefresh, ipAddress: '127.0.0.1' })).rejects.toHaveProperty(
      'code',
      'reused_refresh_token'
    );

    const revokedAll = await prisma.refreshToken.findMany({ where: { userId: employee.id } });
    expect(revokedAll.every((token) => token.revokedAt !== null)).toBe(true);
  });

  it('rejects inactive employees', async () => {
    await setEmailSessionEnabled(true);
    const employee = await prisma.user.create({
      data: {
        email: 'inactive@example.com',
        name: 'Inactive Employee',
        role: 'employee',
        passwordHash: 'placeholder',
        active: false
      }
    });

    await expect(
      callHandler(startSession, {
        body: { flow: 'email_only', email: employee.email }
      })
    ).rejects.toHaveProperty('statusCode', 401);
  });

  it('scoped tokens do not satisfy admin role requirements', async () => {
    await setEmailSessionEnabled(true);
    const employee = await prisma.user.create({
      data: {
        email: 'limited@example.com',
        name: 'Limited Scope',
        role: 'employee',
        passwordHash: 'placeholder',
        active: true
      }
    });

    const start = await callHandler(startSession, {
      body: { flow: 'email_only', email: employee.email }
    });

    const adminGuard = requireRole(['admin']);

    await new Promise<void>((resolve) => {
      adminGuard(
        {
          user: employee,
          tokenScope: EMPLOYEE_SESSION_SCOPE
        } as unknown as Parameters<typeof adminGuard>[0],
        {} as Parameters<typeof adminGuard>[1],
        (err?: unknown) => {
          expect(err).toBeInstanceOf(HttpError);
          expect((err as HttpError).statusCode).toBe(403);
          resolve();
        }
      );
    });
  });
});

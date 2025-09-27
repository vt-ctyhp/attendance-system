import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/prisma';
import { hashPassword } from '../src/auth';
import {
  createTimeRequest,
  approveTimeRequest,
  denyTimeRequest
} from '../src/routes/timeRequests';
import { getUserBalance } from '../src/routes/balances';
import { adjustPtoBalance } from '../src/services/balances';
import { callHandler } from './utils';

describe('Time requests', () => {
  it('creates, approves, and denies requests across PTO types', async () => {
    const admin = await prisma.user.create({
      data: {
        email: 'admin@test.local',
        name: 'Admin',
        role: 'admin',
        passwordHash: await hashPassword('SuperSecret123!')
      }
    });

    const employee = await prisma.user.create({
      data: {
        email: 'employee@test.local',
        name: 'Employee',
        role: 'employee',
        passwordHash: await hashPassword('EmployeePass123!')
      }
    });

    await prisma.ptoBalance.create({
      data: {
        userId: employee.id,
        basePtoHours: 40,
        baseNonPtoHours: 20,
        baseMakeUpHours: 0,
        ptoHours: 40,
        nonPtoHours: 20,
        makeUpHours: 0
      }
    });

    const ptoCreate = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'pto',
        startDate: '2024-06-01T09:00:00.000Z',
        endDate: '2024-06-01T17:00:00.000Z',
        hours: 8,
        reason: 'Vacation'
      },
      user: employee
    });
    expect(ptoCreate.status).toBe(201);
    const ptoRequestId = ptoCreate.data!.request.id;

    const ptoApprove = await callHandler<{
      updatedRequest: { status: string };
      updatedBalance: { ptoHours: number };
    }>(approveTimeRequest, {
      params: { id: ptoRequestId },
      user: admin
    });
    expect(ptoApprove.status).toBe(200);
    expect(ptoApprove.data!.updatedRequest.status).toBe('approved');
    expect(ptoApprove.data!.updatedBalance.ptoHours).toBe(32);

    const ledgerAfterPto = await prisma.balanceLedger.findMany({ where: { userId: employee.id } });
    expect(ledgerAfterPto).toHaveLength(1);
    expect(ledgerAfterPto[0].deltaHours).toBe(-8);
    expect(ledgerAfterPto[0].createdById).toBe(admin.id);
    expect(ledgerAfterPto[0].reason).toContain('approved');

    const nonPtoCreate = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'non_pto',
        startDate: '2024-06-02T09:00:00.000Z',
        hours: 2,
        reason: 'Errand'
      },
      user: employee
    });
    expect(nonPtoCreate.status).toBe(201);
    const nonPtoId = nonPtoCreate.data!.request.id;
    const nonPtoEndDate = (nonPtoCreate.data!.request as { endDate: string | Date }).endDate;
    expect(new Date(nonPtoEndDate).toISOString()).toBe('2024-06-02T09:00:00.000Z');

    const storedNonPto = await prisma.timeRequest.findUniqueOrThrow({ where: { id: nonPtoId } });
    expect(storedNonPto.endDate.toISOString()).toBe('2024-06-02T09:00:00.000Z');

    const nonPtoApprove = await callHandler<{
      updatedBalance: { nonPtoHours: number };
    }>(approveTimeRequest, {
      params: { id: nonPtoId },
      user: admin
    });
    expect(nonPtoApprove.status).toBe(200);
    expect(nonPtoApprove.data!.updatedBalance.nonPtoHours).toBe(18);

    const makeUpCreate = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'make_up',
        startDate: '2024-06-03T09:00:00.000Z',
        endDate: '2024-06-03T12:00:00.000Z',
        hours: 3,
        reason: 'Extra coverage'
      },
      user: employee
    });
    expect(makeUpCreate.status).toBe(201);
    const makeUpId = makeUpCreate.data!.request.id;

    const makeUpApprove = await callHandler<{
      updatedBalance: { makeUpHours: number };
    }>(approveTimeRequest, {
      params: { id: makeUpId },
      user: admin
    });
    expect(makeUpApprove.status).toBe(200);
    expect(makeUpApprove.data!.updatedBalance.makeUpHours).toBe(3);

    const ledgerAfterOtherApprovals = await prisma.balanceLedger.findMany({ where: { userId: employee.id } });
    expect(ledgerAfterOtherApprovals).toHaveLength(1);

    await adjustPtoBalance({
      userId: employee.id,
      deltaHours: 8,
      reason: 'Manual grant',
      createdById: admin.id
    });

    const denyCreate = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'pto',
        startDate: '2024-06-04T09:00:00.000Z',
        endDate: '2024-06-04T13:00:00.000Z',
        hours: 4,
        reason: 'Second trip'
      },
      user: employee
    });
    expect(denyCreate.status).toBe(201);

    const denyResponse = await callHandler<{ request: { status: string } }>(denyTimeRequest, {
      params: { id: denyCreate.data!.request.id },
      user: admin
    });
    expect(denyResponse.status).toBe(200);
    expect(denyResponse.data!.request.status).toBe('denied');

    await expect(
      callHandler(createTimeRequest, {
        body: {
          type: 'pto',
          startDate: '2024-06-05T09:00:00.000Z',
          reason: 'Missing fields'
        },
        user: employee
      })
    ).rejects.toHaveProperty('statusCode', 400);

    const balanceResponse = await callHandler<{
      balance: { ptoHours: number; nonPtoHours: number; makeUpHours: number };
      ledger: Array<{ deltaHours: number; reason: string }>;
    }>(getUserBalance, {
      params: { userId: String(employee.id) },
      user: employee,
      method: 'GET'
    });
    expect(balanceResponse.status).toBe(200);
    expect(balanceResponse.data!.balance.ptoHours).toBe(40);
    expect(balanceResponse.data!.balance.nonPtoHours).toBe(18);
    expect(balanceResponse.data!.balance.makeUpHours).toBe(3);
    expect(balanceResponse.data!.ledger).toHaveLength(2);
    expect(balanceResponse.data!.ledger[0].deltaHours).toBe(8);
    expect(balanceResponse.data!.ledger[1].deltaHours).toBe(-8);
  });
});

it('enforces make-up monthly cap', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-06-15T10:00:00.000Z'));

  try {
    const admin = await prisma.user.create({
      data: {
        email: 'admin@test.local',
        name: 'Admin',
        role: 'admin',
        passwordHash: await hashPassword('SuperSecret123!')
      }
    });

    const employee = await prisma.user.create({
      data: {
        email: 'employee@test.local',
        name: 'Employee',
        role: 'employee',
        passwordHash: await hashPassword('EmployeePass123!')
      }
    });

    await prisma.ptoBalance.create({
      data: {
        userId: employee.id,
        basePtoHours: 40,
        baseNonPtoHours: 20,
        baseMakeUpHours: 0,
        ptoHours: 40,
        nonPtoHours: 20,
        makeUpHours: 0
      }
    });

    const pendingRequest = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'make_up',
        startDate: '2024-06-01T09:00:00.000Z',
        hours: 3,
        reason: 'Hold for approval'
      },
      user: employee
    });
    const pendingId = pendingRequest.data!.request.id;

    const firstApproved = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'make_up',
        startDate: '2024-06-02T09:00:00.000Z',
        hours: 4,
        reason: 'First block'
      },
      user: employee
    });
    await callHandler(approveTimeRequest, {
      params: { id: firstApproved.data!.request.id },
      user: admin
    });

    const secondApproved = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'make_up',
        startDate: '2024-06-03T09:00:00.000Z',
        hours: 2,
        reason: 'Second block'
      },
      user: employee
    });
    await callHandler(approveTimeRequest, {
      params: { id: secondApproved.data!.request.id },
      user: admin
    });

    const withinCap = await callHandler<{ request: { id: string } }>(createTimeRequest, {
      body: {
        type: 'make_up',
        startDate: '2024-06-04T09:00:00.000Z',
        hours: 2,
        reason: 'Within cap'
      },
      user: employee
    });
    expect(withinCap.status).toBe(201);

    await expect(
      callHandler(approveTimeRequest, {
        params: { id: pendingId },
        user: admin
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Request exceeds monthly cap (8h). Approved this month: 6h. Remaining: 2h.')
    });

    await callHandler(approveTimeRequest, {
      params: { id: withinCap.data!.request.id },
      user: admin
    });

    const balance = await prisma.ptoBalance.findUniqueOrThrow({ where: { userId: employee.id } });
    expect(balance.makeUpHours).toBe(8);

    await expect(
      callHandler(createTimeRequest, {
        body: {
          type: 'make_up',
          startDate: '2024-06-05T09:00:00.000Z',
          hours: 1,
          reason: 'Over cap'
        },
        user: employee
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Request exceeds monthly cap (8h). Approved this month: 8h. Remaining: 0h.')
    });
  } finally {
    vi.useRealTimers();
  }
});

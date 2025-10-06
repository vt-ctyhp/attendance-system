import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma';
import { getAppOverview } from '../src/routes/appData';
import { callHandler } from './utils';

describe('PTO/UTO integration', () => {
  it('surfaces UTO balances across overview and dashboard endpoints', async () => {
    process.env.DASHBOARD_ALLOW_ANON = 'true';
    const { buildApp } = await import('../src/app');
    const app = buildApp();

    const employee = await prisma.user.create({
      data: {
        email: 'uto.employee@example.com',
        name: 'UTO Employee',
        role: 'employee',
        passwordHash: 'hash'
      }
    });

    await prisma.ptoBalance.create({
      data: {
        userId: employee.id,
        basePtoHours: 40,
        baseUtoHours: 16,
        baseMakeUpHours: 0,
        ptoHours: 28,
        utoHours: 12,
        makeUpHours: 3
      }
    });

    await prisma.timeRequest.createMany({
      data: [
        {
          userId: employee.id,
          type: 'pto',
          status: 'approved',
          startDate: new Date('2024-06-01T09:00:00.000Z'),
          endDate: new Date('2024-06-01T17:00:00.000Z'),
          hours: 8,
          reason: 'Summer break'
        },
        {
          userId: employee.id,
          type: 'uto',
          status: 'approved',
          startDate: new Date('2024-06-03T12:00:00.000Z'),
          endDate: new Date('2024-06-03T14:00:00.000Z'),
          hours: 2,
          reason: 'Midday appointment'
        }
      ]
    });

    const storedBalance = await prisma.ptoBalance.findUnique({ where: { userId: employee.id } });
    console.log('storedBalance', storedBalance?.utoHours);
    const overview = await callHandler(getAppOverview, {
      method: 'GET',
      query: { email: employee.email }
    });

    expect(overview.status).toBe(200);
    const overviewPayload = overview.data as {
      balances: { pto: number; uto: number };
      requests: Array<{ type: string }>;
    };
    expect(overviewPayload.balances.uto).toBe(12);
    expect(overviewPayload.requests.some((item) => item.type === 'uto')).toBe(true);

    const csvResponse = await request(app).get('/dashboard/balances?download=csv').expect(200);
    expect(csvResponse.text).toContain('UTO Hours');
    expect(csvResponse.text).toContain('Base UTO');

    const htmlResponse = await request(app).get('/dashboard/balances').expect(200);
    expect(htmlResponse.text).toContain('UTO Remaining');
  });
});

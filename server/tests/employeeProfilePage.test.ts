import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/prisma';
import { upsertEmployeeConfig, ensureSchedule } from '../src/services/payroll/config';

describe('Employee profile dashboard page', () => {
  it('renders editing forms and history for an employee', async () => {
    process.env.DASHBOARD_ALLOW_ANON = 'true';
    const { buildApp } = await import('../src/app');
    const app = buildApp();

    const admin = await prisma.user.create({
      data: {
        email: 'profile-admin@example.com',
        name: 'Profile Admin',
        role: 'admin',
        passwordHash: 'hash'
      }
    });

    const employee = await prisma.user.create({
      data: {
        email: 'employee.profile@example.com',
        name: 'Employee Profile',
        role: 'employee',
        passwordHash: 'hash',
        active: true
      }
    });

    const schedule = ensureSchedule({
      timeZone: 'America/Los_Angeles',
      days: {
        '0': { enabled: false, start: '09:00', end: '17:00', expectedHours: 8 },
        '1': { enabled: true, start: '09:00', end: '17:30', expectedHours: 8.5, breakMinutes: 30 },
        '2': { enabled: true, start: '09:00', end: '17:30', expectedHours: 8.5, breakMinutes: 30 },
        '3': { enabled: true, start: '09:00', end: '17:30', expectedHours: 8.5, breakMinutes: 30 },
        '4': { enabled: true, start: '09:00', end: '17:30', expectedHours: 8.5, breakMinutes: 30 },
        '5': { enabled: true, start: '09:00', end: '14:00', expectedHours: 4.5, breakMinutes: 15 },
        '6': { enabled: false, start: '09:00', end: '17:00', expectedHours: 8 }
      }
    });

    await upsertEmployeeConfig(
      {
        userId: employee.id,
        effectiveOn: new Date('2024-01-01T00:00:00.000Z'),
        baseSemiMonthlySalary: 3200,
        monthlyAttendanceBonus: 150,
        quarterlyAttendanceBonus: 450,
        kpiEligible: true,
        defaultKpiBonus: 500,
        schedule,
        accrualEnabled: false,
        accrualMethod: null,
        ptoBalanceHours: 32,
        utoBalanceHours: 12
      },
      admin.id
    );

    const response = await request(app).get(`/dashboard/employees/${employee.id}`).expect(200);

    expect(response.text).toContain('New Compensation Version');
    expect(response.text).toContain('New Schedule Version');
    expect(response.text).toContain('Compensation History');
    expect(response.text).toContain('Schedule History');
    expect(response.text).toContain('employee-profile-data');
    expect(response.text).toContain('value="America/Los_Angeles"');
    expect(response.text).toContain('Unpaid Break (min)');
  });
});

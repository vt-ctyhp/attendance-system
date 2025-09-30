import { prisma } from '../src/prisma';
import { hashPassword } from '../src/auth';
import { ensureSchedule } from '../src/services/payroll/config';
import { PAYROLL_TIME_ZONE } from '../src/services/payroll/constants';
import { recalcMonthlyBonuses } from '../src/services/payroll/bonuses';
import { recalcPayrollForPayDate } from '../src/services/payroll/payroll';
import { zonedTimeToUtc } from 'date-fns-tz';

const DEMO_PASSWORD = process.env.PAYROLL_DEMO_PASSWORD ?? 'PayrollDemo123!';
const MONTH_KEY = process.env.PAYROLL_DEMO_MONTH ?? new Date().toISOString().slice(0, 7);
const PAY_DATE_INPUT = process.env.PAYROLL_DEMO_PAYDATE ?? `${MONTH_KEY}-30`;

const EMPLOYEES = [
  {
    email: 'alex.morgan@example.com',
    name: 'Alex Morgan',
    role: 'employee' as const,
    baseSemiMonthlySalary: 3100,
    monthlyAttendanceBonus: 180,
    quarterlyAttendanceBonus: 550,
    defaultKpiBonus: 600,
    kpiEligible: true,
    assignedHours: 168,
    workedHours: 168,
    ptoHours: 0,
    nonPtoAbsenceHours: 0,
    matchedMakeUpHours: 0,
    tardyMinutes: 0,
    reasons: [] as string[],
    isPerfect: true
  },
  {
    email: 'jamie.chen@example.com',
    name: 'Jamie Chen',
    role: 'employee' as const,
    baseSemiMonthlySalary: 2725,
    monthlyAttendanceBonus: 120,
    quarterlyAttendanceBonus: 420,
    defaultKpiBonus: null,
    kpiEligible: false,
    assignedHours: 168,
    workedHours: 158.5,
    ptoHours: 4,
    nonPtoAbsenceHours: 0,
    matchedMakeUpHours: 1.5,
    tardyMinutes: 48,
    reasons: ['Late arrivals on 3 days'],
    isPerfect: false
  },
  {
    email: 'riley.davis@example.com',
    name: 'Riley Davis',
    role: 'employee' as const,
    baseSemiMonthlySalary: 3350,
    monthlyAttendanceBonus: 210,
    quarterlyAttendanceBonus: 650,
    defaultKpiBonus: 800,
    kpiEligible: true,
    assignedHours: 168,
    workedHours: 164,
    ptoHours: 8,
    nonPtoAbsenceHours: 0,
    matchedMakeUpHours: 0,
    tardyMinutes: 10,
    reasons: ['PTO day approved'],
    isPerfect: false
  }
];

const buildSchedule = () =>
  ensureSchedule({
    '0': { enabled: false, start: '09:00', end: '17:00', expectedHours: 8 },
    '1': { enabled: true, start: '09:00', end: '17:00', expectedHours: 8 },
    '2': { enabled: true, start: '09:00', end: '17:00', expectedHours: 8 },
    '3': { enabled: true, start: '09:00', end: '17:00', expectedHours: 8 },
    '4': { enabled: true, start: '09:00', end: '17:00', expectedHours: 8 },
    '5': { enabled: true, start: '09:00', end: '16:00', expectedHours: 7 },
    '6': { enabled: false, start: '09:00', end: '12:00', expectedHours: 3 }
  });

const parseMonthKey = (value: string) => {
  const [yearStr, monthStr] = value.split('-');
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`Invalid month key: ${value}`);
  }
  return { year, month };
};

const formatIso = (year: number, month: number, day: number, suffix = 'T00:00:00') => {
  const monthPart = String(month).padStart(2, '0');
  const dayPart = String(day).padStart(2, '0');
  return `${year}-${monthPart}-${dayPart}${suffix}`;
};

const resolveMonthRange = (monthKey: string) => {
  const { year, month } = parseMonthKey(monthKey);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rangeStart = zonedTimeToUtc(`${monthKey}-01T00:00:00`, PAYROLL_TIME_ZONE);
  const rangeEnd = zonedTimeToUtc(formatIso(year, month, lastDay, 'T23:59:59'), PAYROLL_TIME_ZONE);
  return { rangeStart, rangeEnd };
};

const resolvePayDate = (input: string, monthKey: string) => {
  const { year, month } = parseMonthKey(monthKey);
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return zonedTimeToUtc(`${trimmed}T00:00:00`, PAYROLL_TIME_ZONE);
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return zonedTimeToUtc(parsed, PAYROLL_TIME_ZONE);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return zonedTimeToUtc(formatIso(year, month, lastDay), PAYROLL_TIME_ZONE);
};

const resolveQuarterKey = (monthKey: string) => {
  const { year, month } = parseMonthKey(monthKey);
  const quarterIndex = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${quarterIndex}`;
};

async function ensureAdminActor() {
  const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
  if (admin) return admin.id;
  const passwordHash = await hashPassword(process.env.ADMIN_PASSWORD ?? 'AdminPass123!');
  const created = await prisma.user.create({
    data: {
      email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
      name: 'Payroll Admin',
      role: 'admin',
      active: true,
      passwordHash
    }
  });
  return created.id;
}

async function upsertEmployee(email: string, name: string, role: 'employee' | 'manager' | 'admin') {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  return prisma.user.upsert({
    where: { email },
    update: { name, role, active: true, passwordHash },
    create: { email, name, role, active: true, passwordHash }
  });
}

async function seed() {
  console.log(`Seeding payroll demo data for ${MONTH_KEY}...`);
  const actorId = await ensureAdminActor();
  const { rangeStart, rangeEnd } = resolveMonthRange(MONTH_KEY);
  const payDateUtc = resolvePayDate(PAY_DATE_INPUT, MONTH_KEY);
  const quarterKey = resolveQuarterKey(MONTH_KEY);

  await prisma.attendanceMonthFact.deleteMany({ where: { monthKey: MONTH_KEY } });
  await prisma.bonusCandidate.deleteMany({ where: { OR: [{ periodKey: MONTH_KEY }, { periodKey: quarterKey }] } });
  await prisma.payrollLine.deleteMany({ where: { payrollPeriod: { payDate: payDateUtc } } });
  await prisma.payrollPeriod.deleteMany({ where: { payDate: payDateUtc } });

  for (const employee of EMPLOYEES) {
    const user = await upsertEmployee(employee.email, employee.name, employee.role);

    await prisma.employeeCompConfig.upsert({
      where: { userId_effectiveOn: { userId: user.id, effectiveOn: rangeStart } },
      create: {
        userId: user.id,
        effectiveOn: rangeStart,
        baseSemiMonthlySalary: employee.baseSemiMonthlySalary,
        monthlyAttendanceBonus: employee.monthlyAttendanceBonus,
        quarterlyAttendanceBonus: employee.quarterlyAttendanceBonus,
        kpiEligible: employee.kpiEligible,
        defaultKpiBonus: employee.defaultKpiBonus,
        schedule: buildSchedule(),
        accrualEnabled: true,
        accrualMethod: 'standard',
        ptoBalanceHours: 40,
        nonPtoBalanceHours: 12
      },
      update: {
        baseSemiMonthlySalary: employee.baseSemiMonthlySalary,
        monthlyAttendanceBonus: employee.monthlyAttendanceBonus,
        quarterlyAttendanceBonus: employee.quarterlyAttendanceBonus,
        kpiEligible: employee.kpiEligible,
        defaultKpiBonus: employee.defaultKpiBonus,
        schedule: buildSchedule(),
        accrualEnabled: true,
        accrualMethod: 'standard',
        ptoBalanceHours: 40,
        nonPtoBalanceHours: 12
      }
    });

    await prisma.attendanceMonthFact.upsert({
      where: { userId_monthKey: { userId: user.id, monthKey: MONTH_KEY } },
      create: {
        userId: user.id,
        monthKey: MONTH_KEY,
        rangeStart,
        rangeEnd,
        assignedHours: employee.assignedHours,
        workedHours: employee.workedHours,
        ptoHours: employee.ptoHours,
        nonPtoAbsenceHours: employee.nonPtoAbsenceHours,
        tardyMinutes: employee.tardyMinutes,
        matchedMakeUpHours: employee.matchedMakeUpHours,
        isPerfect: employee.isPerfect,
        reasons: employee.reasons,
        snapshot: { seeded: true, monthKey: MONTH_KEY }
      },
      update: {
        rangeStart,
        rangeEnd,
        assignedHours: employee.assignedHours,
        workedHours: employee.workedHours,
        ptoHours: employee.ptoHours,
        nonPtoAbsenceHours: employee.nonPtoAbsenceHours,
        tardyMinutes: employee.tardyMinutes,
        matchedMakeUpHours: employee.matchedMakeUpHours,
        isPerfect: employee.isPerfect,
        reasons: employee.reasons,
        snapshot: { seeded: true, monthKey: MONTH_KEY }
      }
    });
  }

  await recalcMonthlyBonuses(MONTH_KEY, actorId);
  await recalcPayrollForPayDate(payDateUtc, actorId);

  console.log('Payroll demo data seeded.');
  console.log(`Employees can log in with password: ${DEMO_PASSWORD}`);
  console.log(`Month key: ${MONTH_KEY}, Pay date (UTC): ${payDateUtc.toISOString().slice(0, 10)}`);
}

seed()
  .catch((error) => {
    console.error('Failed to seed payroll demo data', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

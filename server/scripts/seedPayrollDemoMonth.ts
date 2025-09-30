import { prisma } from '../src/prisma';
import { hashPassword } from '../src/auth';
import { addMinutes, eachDayOfInterval } from 'date-fns';
import { ensureSchedule } from '../src/services/payroll/config';
import { PAYROLL_TIME_ZONE } from '../src/services/payroll/constants';
import { recalcMonthlyBonuses } from '../src/services/payroll/bonuses';
import { recalcPayrollForPayDate } from '../src/services/payroll/payroll';
import { recalcMonthlyAttendanceFacts } from '../src/services/payroll/attendance';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';

const DEMO_PASSWORD = process.env.PAYROLL_DEMO_PASSWORD ?? 'PayrollDemo123!';

const resolveDefaultMonthKey = () => {
  if (process.env.PAYROLL_DEMO_MONTH) {
    return process.env.PAYROLL_DEMO_MONTH;
  }
  const now = utcToZonedTime(new Date(), PAYROLL_TIME_ZONE);
  const targetYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${targetYear}-09`;
};

const MONTH_KEY = resolveDefaultMonthKey();
const PAY_DATE_INPUT = process.env.PAYROLL_DEMO_PAYDATE ?? `${MONTH_KEY}-30`;

type ScheduleKey = 'weekday' | 'split';

type BreakPlan = {
  type: 'break' | 'lunch';
  offset: number;
  duration: number;
};

type LateStartPlan = {
  day: number;
  minutesLate: number;
};

type RequestPlan = {
  day: number;
  hours?: number;
  startHour?: number;
  startMinute?: number;
  reason?: string;
};

type NonPtoPlan = RequestPlan & {
  hours: number;
};

type MakeUpPlan = RequestPlan & {
  hours: number;
  breakPlan?: BreakPlan[];
};

type EmployeeSeedPlan = {
  email: string;
  name: string;
  role: 'employee';
  baseSemiMonthlySalary: number;
  monthlyAttendanceBonus: number;
  quarterlyAttendanceBonus: number;
  defaultKpiBonus: number | null;
  kpiEligible: boolean;
  scheduleType: ScheduleKey;
  deviceId: string;
  lateStarts: LateStartPlan[];
  ptoDays: RequestPlan[];
  nonPtoRequests: NonPtoPlan[];
  makeUpSessions: MakeUpPlan[];
};

const DEFAULT_SHIFT_TOTAL_MINUTES = 10 * 60;
const DEFAULT_BREAK_PLAN: BreakPlan[] = [
  { type: 'break', offset: 120, duration: 15 },
  { type: 'lunch', offset: 240, duration: 60 },
  { type: 'break', offset: 420, duration: 15 }
];
const DEFAULT_BREAK_MINUTES = DEFAULT_BREAK_PLAN.reduce((sum, item) => sum + item.duration, 0);
const DEFAULT_SHIFT_WORK_MINUTES = DEFAULT_SHIFT_TOTAL_MINUTES - DEFAULT_BREAK_MINUTES;
const DEFAULT_SHIFT_WORK_HOURS = Math.round((DEFAULT_SHIFT_WORK_MINUTES / 60) * 100) / 100;

const makeSchedule = (key: ScheduleKey) => {
  if (key === 'weekday') {
    return ensureSchedule({
      '0': { enabled: false, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
      '1': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
      '2': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
      '3': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
      '4': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
      '5': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
      '6': { enabled: false, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS }
    });
  }

  return ensureSchedule({
    '0': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
    '1': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
    '2': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
    '3': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
    '4': { enabled: false, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
    '5': { enabled: false, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS },
    '6': { enabled: true, start: '10:00', end: '20:00', expectedHours: DEFAULT_SHIFT_WORK_HOURS }
  });
};

const EMPLOYEES: EmployeeSeedPlan[] = [
  {
    email: 'alex.morgan@example.com',
    name: 'Alex Morgan',
    role: 'employee',
    baseSemiMonthlySalary: 3100,
    monthlyAttendanceBonus: 180,
    quarterlyAttendanceBonus: 550,
    defaultKpiBonus: 600,
    kpiEligible: true,
    scheduleType: 'weekday',
    deviceId: 'payroll-demo-device-1',
    lateStarts: [
      { day: 3, minutesLate: 12 },
      { day: 17, minutesLate: 8 },
      { day: 24, minutesLate: 18 }
    ],
    ptoDays: [{ day: 12, hours: DEFAULT_SHIFT_WORK_HOURS, reason: 'PTO - long weekend getaway' }],
    nonPtoRequests: [],
    makeUpSessions: []
  },
  {
    email: 'jamie.chen@example.com',
    name: 'Jamie Chen',
    role: 'employee',
    baseSemiMonthlySalary: 2725,
    monthlyAttendanceBonus: 120,
    quarterlyAttendanceBonus: 420,
    defaultKpiBonus: null,
    kpiEligible: false,
    scheduleType: 'split',
    deviceId: 'payroll-demo-device-2',
    lateStarts: [
      { day: 7, minutesLate: 9 },
      { day: 21, minutesLate: 6 }
    ],
    ptoDays: [{ day: 3, hours: DEFAULT_SHIFT_WORK_HOURS, reason: 'PTO - family travel' }],
    nonPtoRequests: [
      { day: 18, hours: 4, reason: 'Non-PTO block for appointments' }
    ],
    makeUpSessions: [
      { day: 20, hours: 4.5, startHour: 11, reason: 'Make-up shift for appointments' }
    ]
  },
  {
    email: 'riley.davis@example.com',
    name: 'Riley Davis',
    role: 'employee',
    baseSemiMonthlySalary: 3350,
    monthlyAttendanceBonus: 210,
    quarterlyAttendanceBonus: 650,
    defaultKpiBonus: 800,
    kpiEligible: true,
    scheduleType: 'weekday',
    deviceId: 'payroll-demo-device-3',
    lateStarts: [
      { day: 2, minutesLate: 5 },
      { day: 15, minutesLate: 9 }
    ],
    ptoDays: [{ day: 26, hours: DEFAULT_SHIFT_WORK_HOURS, reason: 'PTO - travel day' }],
    nonPtoRequests: [
      { day: 9, hours: 3.5, reason: 'Non-PTO afternoon outage' }
    ],
    makeUpSessions: [
      { day: 27, hours: 3.5, startHour: 14, reason: 'Make-up evening block' }
    ]
  }
];

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

const buildDateTime = (monthKey: string, day: number, hour: number, minute = 0) => {
  const dayPart = String(day).padStart(2, '0');
  const hourPart = String(hour).padStart(2, '0');
  const minutePart = String(minute).padStart(2, '0');
  const iso = `${monthKey}-${dayPart}T${hourPart}:${minutePart}:00`;
  return zonedTimeToUtc(iso, PAYROLL_TIME_ZONE);
};

const normalizedHours = (hours: number) => Math.round(hours * 100) / 100;

const createTimeRequest = async (
  userId: number,
  type: 'pto' | 'non_pto' | 'make_up',
  startDate: Date,
  hours: number,
  reason: string,
  actorId: number
) => {
  const minutes = Math.round(hours * 60);
  const endDate = addMinutes(startDate, minutes);
  await prisma.timeRequest.create({
    data: {
      userId,
      type,
      status: 'approved',
      startDate,
      endDate,
      hours: normalizedHours(hours),
      reason,
      approverId: actorId,
      approvedAt: new Date()
    }
  });
};

const createSessionWithBreaks = async (
  userId: number,
  deviceId: string,
  start: Date,
  durationMinutes: number,
  breakPlan: BreakPlan[]
) => {
  const end = addMinutes(start, durationMinutes);
  const session = await prisma.session.create({
    data: {
      userId,
      deviceId,
      startedAt: start,
      endedAt: end,
      status: 'completed'
    }
  });

  if (breakPlan.length) {
    const pauses = breakPlan.map((plan, index) => {
      const pauseStart = addMinutes(start, plan.offset);
      const pauseEnd = addMinutes(pauseStart, plan.duration);
      return {
        sessionId: session.id,
        type: plan.type,
        sequence: index + 1,
        startedAt: pauseStart,
        endedAt: pauseEnd,
        durationMinutes: plan.duration
      };
    });
    await prisma.sessionPause.createMany({ data: pauses });
  }

  const breakWindows = breakPlan.map((plan) => {
    const windowStart = addMinutes(start, plan.offset);
    const windowEnd = addMinutes(windowStart, plan.duration);
    return { start: windowStart.getTime(), end: windowEnd.getTime() };
  });

  const stats: Array<{
    sessionId: string;
    minuteStart: Date;
    active: boolean;
    idle: boolean;
    keysCount: number;
    mouseCount: number;
    fgApp: string;
  }> = [];

  for (let minute = 0; minute < durationMinutes; minute += 1) {
    const minuteStart = addMinutes(start, minute);
    const inBreak = breakWindows.some(
      (window) => minuteStart.getTime() >= window.start && minuteStart.getTime() < window.end
    );
    if (inBreak) continue;
    stats.push({
      sessionId: session.id,
      minuteStart,
      active: minute % 45 !== 0,
      idle: minute % 45 === 0,
      keysCount: 40 + (minute % 6) * 3,
      mouseCount: 24 + (minute % 5) * 2,
      fgApp: minute % 30 < 15 ? 'Spreadsheet' : 'Inbox'
    });
  }

  if (stats.length) {
    await prisma.minuteStat.createMany({ data: stats });
  }

  return session;
};

const clearExistingPayrollMonthData = async (
  userId: number,
  rangeStart: Date,
  rangeEnd: Date
) => {
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      startedAt: { gte: rangeStart, lte: rangeEnd }
    },
    select: { id: true }
  });

  const sessionIds = sessions.map((session) => session.id);
  if (sessionIds.length) {
    await prisma.sessionPause.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.minuteStat.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.event.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  }

  await prisma.timeRequest.deleteMany({
    where: {
      userId,
      startDate: { lte: rangeEnd },
      endDate: { gte: rangeStart }
    }
  });
};

const seedEmployeeTimesheets = async (
  userId: number,
  plan: EmployeeSeedPlan,
  schedule: Record<string, ReturnType<typeof ensureSchedule>[string]>,
  monthKey: string,
  rangeStart: Date,
  rangeEnd: Date,
  actorId: number
) => {
  const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });

  const lateMap = new Map<number, number>(plan.lateStarts.map((item) => [item.day, item.minutesLate]));
  const ptoMap = new Map<number, RequestPlan>(plan.ptoDays.map((item) => [item.day, item]));
  const nonPtoMap = new Map<number, NonPtoPlan>(plan.nonPtoRequests.map((item) => [item.day, item]));

  for (const day of days) {
    const zoned = utcToZonedTime(day, PAYROLL_TIME_ZONE);
    const dayOfMonth = zoned.getDate();
    if (formatInTimeZone(day, PAYROLL_TIME_ZONE, 'yyyy-MM') !== monthKey) {
      continue;
    }
    const weekdayKey = String(zoned.getDay());
    const scheduleEntry = schedule[weekdayKey];

    const pto = ptoMap.get(dayOfMonth);
    if (pto && scheduleEntry?.enabled) {
      const start = buildDateTime(monthKey, dayOfMonth, pto.startHour ?? 10, pto.startMinute ?? 0);
      await createTimeRequest(
        userId,
        'pto',
        start,
        pto.hours ?? DEFAULT_SHIFT_WORK_HOURS,
        pto.reason ?? 'Sample PTO day',
        actorId
      );
      continue;
    }

    if (!scheduleEntry?.enabled) {
      continue;
    }

    const nonPto = nonPtoMap.get(dayOfMonth);
    if (nonPto) {
      const start = buildDateTime(
        monthKey,
        dayOfMonth,
        nonPto.startHour ?? 10,
        nonPto.startMinute ?? 0
      );
      await createTimeRequest(
        userId,
        'non_pto',
        start,
        nonPto.hours,
        nonPto.reason ?? 'Non-PTO absence',
        actorId
      );
      continue;
    }

    const baseStart = buildDateTime(monthKey, dayOfMonth, 10, 0);
    const lateMinutes = lateMap.get(dayOfMonth) ?? 0;
    const sessionStart = addMinutes(baseStart, lateMinutes);

    await createSessionWithBreaks(
      userId,
      plan.deviceId,
      sessionStart,
      DEFAULT_SHIFT_TOTAL_MINUTES,
      DEFAULT_BREAK_PLAN
    );
  }

  for (const makeUp of plan.makeUpSessions) {
    const start = buildDateTime(
      monthKey,
      makeUp.day,
      makeUp.startHour ?? 10,
      makeUp.startMinute ?? 0
    );
    await createTimeRequest(
      userId,
      'make_up',
      start,
      makeUp.hours,
      makeUp.reason ?? 'Make-up shift',
      actorId
    );
    const durationMinutes = Math.round(makeUp.hours * 60) +
      (makeUp.breakPlan?.reduce((sum, pause) => sum + pause.duration, 0) ?? 0);
    await createSessionWithBreaks(
      userId,
      plan.deviceId,
      start,
      durationMinutes,
      makeUp.breakPlan ?? []
    );
  }
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

    await clearExistingPayrollMonthData(user.id, rangeStart, rangeEnd);

    const schedule = makeSchedule(employee.scheduleType);
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
        schedule,
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
        schedule,
        accrualEnabled: true,
        accrualMethod: 'standard',
        ptoBalanceHours: 40,
        nonPtoBalanceHours: 12
      }
    });

    await seedEmployeeTimesheets(
      user.id,
      employee,
      schedule,
      MONTH_KEY,
      rangeStart,
      rangeEnd,
      actorId
    );
  }

  await recalcMonthlyAttendanceFacts(MONTH_KEY, actorId);
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

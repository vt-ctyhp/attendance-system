import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { zonedTimeToUtc } from 'date-fns-tz';
import { Prisma } from '@prisma/client';
import { authenticate, requireRole, type AuthenticatedRequest } from '../auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import {
  listEmployeeConfigs,
  upsertEmployeeConfig,
  deleteEmployeeConfig,
  createHoliday,
  listHolidays,
  deleteHoliday,
  ensureSchedule
} from '../services/payroll/config';
import {
  getAttendanceFactForUser,
  listAttendanceFactsForMonth,
  recalcMonthlyAttendanceFacts,
  updateAttendanceReviewStatus
} from '../services/payroll/attendance';
import { recalcMonthlyBonuses, listBonusesForPayDate, updateKpiBonusStatus } from '../services/payroll/bonuses';
import {
  approvePayrollPeriod,
  exportPayrollCsv,
  getPayrollPeriod,
  markPayrollPaid,
  recalcPayrollForPayDate
} from '../services/payroll/payroll';
import { PAYROLL_TIME_ZONE } from '../services/payroll/constants';
import { ensureUpcomingShiftsForAllUsers } from '../services/shiftPlanner';
import { ensureBalance } from '../services/balances';

const payrollRouter = Router();

const allowAnonDashboard = process.env.DASHBOARD_ALLOW_ANON === 'true';

if (!allowAnonDashboard) {
  payrollRouter.use(authenticate);
}

const allowRoles = (roles: Array<'admin' | 'manager'>) => {
  if (allowAnonDashboard) {
    return (_req: AuthenticatedRequest, _res: Response, next: NextFunction) => next();
  }
  return requireRole(roles);
};

const requireAdmin = allowRoles(['admin']);
const requireAdminOrManager = allowRoles(['admin', 'manager']);

const scheduleDaySchema = z.object({
  enabled: z.boolean().optional().default(false),
  start: z.string().optional().default('09:00'),
  end: z.string().optional().default('17:00'),
  expectedHours: z.number().finite().nonnegative().optional(),
  breakMinutes: z.number().finite().nonnegative().optional(),
  unpaidBreakMinutes: z.number().finite().nonnegative().optional()
});

const scheduleSchema = z
  .object({
    timeZone: z.string().min(1),
    days: z.record(scheduleDaySchema)
  })
  .or(z.record(scheduleDaySchema))
  .default({});

const toNumber = (value: unknown, fallback = 0) => {
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    const parsed = (value as { toNumber: () => number }).toNumber();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const serializeAttendanceFact = (
  fact: NonNullable<Awaited<ReturnType<typeof getAttendanceFactForUser>>>
) => ({
  userId: fact.userId,
  monthKey: fact.monthKey,
  rangeStart: fact.rangeStart,
  rangeEnd: fact.rangeEnd,
  assignedHours: toNumber(fact.assignedHours),
  workedHours: toNumber(fact.workedHours),
  ptoHours: toNumber(fact.ptoHours),
  utoAbsenceHours: toNumber(fact.utoAbsenceHours),
  matchedMakeUpHours: toNumber(fact.matchedMakeUpHours),
  tardyMinutes: fact.tardyMinutes,
  isPerfect: fact.isPerfect,
  reviewStatus: fact.reviewStatus,
  reviewNotes: fact.reviewNotes,
  reviewedAt: fact.reviewedAt,
  reviewedBy: fact.reviewedBy,
  reasons: fact.reasons,
  snapshot: fact.snapshot,
  user: fact.user
});

const datePreprocess = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const parsedInZone = zonedTimeToUtc(`${trimmed}T00:00:00`, PAYROLL_TIME_ZONE);
        if (!Number.isNaN(parsedInZone.getTime())) {
          return parsedInZone;
        }
      }
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return value;
}, z.date());

const employeeConfigSchema = z.object({
  userId: z.number().int().positive(),
  effectiveOn: datePreprocess,
  baseSemiMonthlySalary: z.number().finite(),
  monthlyAttendanceBonus: z.number().finite(),
  quarterlyAttendanceBonus: z.number().finite(),
  kpiEligible: z.boolean(),
  defaultKpiBonus: z.number().finite().nullable().optional(),
  schedule: scheduleSchema,
  accrualEnabled: z.boolean(),
  accrualMethod: z.string().max(100).optional().nullable()
});

payrollRouter.get(
  '/config',
  requireAdminOrManager,
  asyncHandler(async (req, res) => {
    const querySchema = z.object({ userId: z.coerce.number().int().positive().optional() });
    const { userId } = parseWithSchema(querySchema, req.query, 'Invalid query');
    const configs = await listEmployeeConfigs(userId);
    res.json({ configs });
  })
);

payrollRouter.post(
  '/config',
  requireAdminOrManager,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const input = parseWithSchema(employeeConfigSchema, req.body, 'Invalid configuration payload');
    const { schedule, accrualEnabled: _ignoredAccrualEnabled, accrualMethod, ...comp } = input;
    const accrualEnabled = true;

    const balance = await ensureBalance(comp.userId);
    const resolvedPtoBase = Number(balance.basePtoHours ?? balance.ptoHours ?? 0);
    const resolvedUtoBase = Number(balance.baseUtoHours ?? balance.utoHours ?? 0);

    await upsertEmployeeConfig(
      {
        ...comp,
        accrualEnabled,
        accrualMethod,
        schedule: ensureSchedule(schedule),
        ptoBalanceHours: resolvedPtoBase,
        utoBalanceHours: resolvedUtoBase
      },
      req.user?.id
    );
    res.status(201).json({ success: true });
  })
);

payrollRouter.delete(
  '/config/:id',
  requireAdminOrManager,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
    const { id } = parseWithSchema(paramsSchema, req.params, 'Invalid configuration id');
    await deleteEmployeeConfig(id, req.user?.id);
    res.status(200).json({ success: true });
  })
);

const holidayQuerySchema = z.object({
  from: datePreprocess.optional(),
  to: datePreprocess.optional()
});

payrollRouter.get(
  '/holidays',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { from, to } = parseWithSchema(holidayQuerySchema, req.query, 'Invalid query');
    const now = new Date();
    const start = from ?? now;
    const end = to ?? new Date(now.getFullYear(), now.getMonth() + 6, now.getDate());
    const holidays = await listHolidays(start, end);
    res.json({ holidays });
  })
);

const holidayBodySchema = z.object({
  name: z.string().min(1).max(200),
  observedOn: datePreprocess
});

payrollRouter.post(
  '/holidays',
  requireAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { name, observedOn } = parseWithSchema(holidayBodySchema, req.body, 'Invalid holiday payload');
    const holiday = await createHoliday(name, observedOn, req.user?.id);
    res.status(201).json({ holiday });
  })
);

payrollRouter.delete(
  '/holidays/:date',
  requireAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const paramsSchema = z.object({ date: z.string().min(1) });
    const { date } = parseWithSchema(paramsSchema, req.params, 'Invalid holiday identifier');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    const parsed = zonedTimeToUtc(`${date}T00:00:00`, PAYROLL_TIME_ZONE);
    const removed = await deleteHoliday(parsed, req.user?.id);
    res.json({ removed });
  })
);

const monthParamSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) });
const factUserParamSchema = z.object({ userId: z.coerce.number().int().positive() });
const attendanceReviewUpdateSchema = z.object({
  reviewStatus: z.enum(['pending', 'resolved']),
  reviewNotes: z
    .string()
    .trim()
    .min(1, { message: 'Review notes must not be empty.' })
    .max(500)
    .optional()
    .nullable()
});

payrollRouter.post(
  '/attendance/:month/recalc',
  requireAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { month } = parseWithSchema(monthParamSchema, req.params, 'Invalid month');
    const facts = await recalcMonthlyAttendanceFacts(month, req.user?.id);
    await recalcMonthlyBonuses(month, req.user?.id ?? undefined);
    res.status(202).json({ month, count: facts.length });
  })
);

payrollRouter.get(
  '/attendance/:month',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { month } = parseWithSchema(monthParamSchema, req.params, 'Invalid month');
    const data = await listAttendanceFactsForMonth(month);
    res.json(data);
  })
);

payrollRouter.get(
  '/attendance/:month/users/:userId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { month } = parseWithSchema(monthParamSchema, req.params, 'Invalid month');
    const { userId } = parseWithSchema(factUserParamSchema, req.params, 'Invalid user');
    const fact = await getAttendanceFactForUser(month, userId);
    if (!fact) {
      return res.status(404).json({ error: 'Attendance fact not found.' });
    }
    res.json({ fact: serializeAttendanceFact(fact) });
  })
);

payrollRouter.patch(
  '/attendance/:month/users/:userId/review',
  requireAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { month } = parseWithSchema(monthParamSchema, req.params, 'Invalid month');
    const { userId } = parseWithSchema(factUserParamSchema, req.params, 'Invalid user');
    const { reviewStatus, reviewNotes } = parseWithSchema(
      attendanceReviewUpdateSchema,
      req.body ?? {},
      'Invalid review update'
    );
    const normalizedNotes =
      reviewNotes === null || reviewNotes === undefined ? null : reviewNotes.trim();
    const fact = await updateAttendanceReviewStatus(
      month,
      userId,
      reviewStatus,
      normalizedNotes,
      req.user!.id
    );
    res.json({ fact: serializeAttendanceFact(fact) });
  })
);

const dateParamSchema = z.object({ payDate: z.string().min(1) });

const parsePayDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Invalid pay date');
  }
  const parsed = zonedTimeToUtc(`${value}T00:00:00`, PAYROLL_TIME_ZONE);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid pay date');
  }
  return parsed;
};

payrollRouter.post(
  '/payruns/:payDate/recalc',
  requireAdmin,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { payDate: payDateRaw } = parseWithSchema(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await recalcPayrollForPayDate(payDate, req.user?.id);
    res.status(202).json({ period });
  })
);

payrollRouter.get(
  '/payruns/:payDate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { payDate: payDateRaw } = parseWithSchema(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await getPayrollPeriod(payDate);
    res.json({ period });
  })
);

payrollRouter.post(
  '/shifts/rebuild',
  requireAdminOrManager,
  asyncHandler(async (_req: AuthenticatedRequest, res) => {
    const summary = await ensureUpcomingShiftsForAllUsers();
    res.status(202).json({ success: true, summary });
  })
);

payrollRouter.post(
  '/payruns/:payDate/approve',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { payDate: payDateRaw } = parseWithSchema(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await approvePayrollPeriod(payDate, req.user!.id);
    res.json({ period });
  })
);

payrollRouter.post(
  '/payruns/:payDate/pay',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { payDate: payDateRaw } = parseWithSchema(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await markPayrollPaid(payDate, req.user!.id);
    res.json({ period });
  })
);

payrollRouter.get(
  '/payruns/:payDate/export',
  asyncHandler(async (req, res) => {
    const { payDate: payDateRaw } = parseWithSchema(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const csv = await exportPayrollCsv(payDate);
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  })
);

const bonusQuerySchema = z.object({ payDate: datePreprocess });

payrollRouter.get(
  '/bonuses',
  asyncHandler(async (req, res) => {
    const { payDate } = parseWithSchema(bonusQuerySchema, req.query, 'Invalid query');
    const bonuses = await listBonusesForPayDate(payDate);
    res.json({ bonuses });
  })
);

const kpiDecisionSchema = z.object({
  status: z.enum(['approved', 'denied']),
  finalAmount: z.number().finite().optional(),
  notes: z.string().max(500).optional()
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

payrollRouter.post(
  '/kpi/:id/decision',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { id } = parseWithSchema(idParamSchema, req.params, 'Invalid KPI identifier');
    const { status, finalAmount, notes } = parseWithSchema(
      kpiDecisionSchema,
      req.body,
      'Invalid decision payload'
    );
    const candidate = await updateKpiBonusStatus(id, status, req.user!.id, finalAmount, notes);
    res.json({ candidate });
  })
);

export { payrollRouter };

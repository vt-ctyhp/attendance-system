import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, type AuthenticatedRequest } from '../auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { prisma } from '../prisma';
import { listEmployeeConfigs, upsertEmployeeConfig, type PayrollConfigInput } from '../payroll/config';
import { listHolidays, upsertHoliday, deleteHoliday } from '../payroll/holidays';
import { recalcMonthlyAttendanceFact } from '../payroll/attendance';
import {
  ensureKpiBonusCandidate,
  getBonusesPayableOn,
  listBonuses,
  decideBonus,
  syncMonthlyAttendanceBonus,
  syncQuarterlyAttendanceBonus
} from '../payroll/bonus';
import { ensurePayrollPeriod, recalcPayrollPeriod, markPayrollPeriodStatus } from '../payroll/payrollPeriods';
import type { PayrollScheduleEntry, Weekday } from '../payroll/types';

const router = Router();

router.use(authenticate, requireRole(['admin']));

const scheduleEntrySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  isEnabled: z.boolean(),
  startMinutes: z.number().int().nullable().optional(),
  endMinutes: z.number().int().nullable().optional(),
  expectedHours: z.number().nullable().optional()
});

const configInputSchema = z.object({
  effectiveOn: z.coerce.date(),
  baseSemiMonthlySalary: z.number().min(0),
  monthlyAttendanceBonus: z.number().min(0),
  quarterlyAttendanceBonus: z.number().min(0),
  kpiBonusDefaultAmount: z.number().min(0),
  kpiBonusEnabled: z.boolean(),
  ptoBalanceHours: z.number().min(0),
  nonPtoBalanceHours: z.number().min(0),
  accrualEnabled: z.boolean(),
  accrualMethod: z.enum(['NONE', 'MANUAL', 'MONTHLY_HOURS']),
  accrualHoursPerMonth: z.number().nullable().optional(),
  notes: z.string().optional(),
  schedule: z.array(scheduleEntrySchema).length(7)
});

router.get(
  '/configs/:userId',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const configs = await listEmployeeConfigs(userId);
    return res.json({ configs });
  })
);

router.post(
  '/configs/:userId',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const input = parseWithSchema(configInputSchema, req.body, 'Invalid config payload');
    const normalizedSchedule: PayrollScheduleEntry[] = input.schedule.map((entry) => ({
      weekday: entry.weekday as Weekday,
      isEnabled: entry.isEnabled,
      startMinutes: entry.startMinutes ?? null,
      endMinutes: entry.endMinutes ?? null,
      expectedHours: entry.expectedHours ?? null
    }));
    const configPayload: PayrollConfigInput = {
      ...input,
      schedule: normalizedSchedule
    };
    const config = await upsertEmployeeConfig(userId, configPayload, req.user?.id);
    return res.status(201).json({ config });
  })
);

const holidayQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});

router.get(
  '/holidays',
  asyncHandler(async (req, res) => {
    const { from, to } = parseWithSchema(holidayQuerySchema, req.query, 'Invalid range');
    const now = new Date();
    const rangeStart = from ?? now;
    const rangeEnd = to ?? new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const holidays = await listHolidays(rangeStart, rangeEnd);
    res.json({ holidays });
  })
);

const holidayUpsertSchema = z.object({
  date: z.coerce.date(),
  name: z.string().min(1),
  isPaid: z.boolean().default(true)
});

router.post(
  '/holidays',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { date, name, isPaid } = parseWithSchema(holidayUpsertSchema, req.body, 'Invalid holiday payload');
    const holiday = await upsertHoliday(date, name, isPaid, req.user?.id);
    res.status(201).json({ holiday });
  })
);

router.delete(
  '/holidays',
  asyncHandler(async (req, res) => {
    const { date } = parseWithSchema(z.object({ date: z.coerce.date() }), req.body, 'Invalid request');
    await deleteHoliday(date);
    res.status(204).send();
  })
);

const attendanceRecalcSchema = z.object({
  userId: z.number().int().positive(),
  month: z.coerce.date(),
  finalize: z.boolean().optional()
});

router.post(
  '/attendance/recalc',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { userId, month, finalize } = parseWithSchema(attendanceRecalcSchema, req.body, 'Invalid payload');
    const fact = await recalcMonthlyAttendanceFact(userId, month, { finalize, actorId: req.user?.id });
    if (finalize && fact.status === 'FINALIZED') {
      await syncMonthlyAttendanceBonus(fact.id, fact.finalizedAt ?? new Date());
      await syncQuarterlyAttendanceBonus(fact.id, fact.finalizedAt ?? new Date());
      await ensureKpiBonusCandidate(userId, month);
    }
    res.json({ fact });
  })
);

router.get(
  '/attendance/:userId',
  asyncHandler(async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const facts = await prisma.payrollAttendanceFact.findMany({
      where: { userId },
      orderBy: { month: 'desc' }
    });
    res.json({ facts });
  })
);

const ensurePeriodSchema = z.object({
  reference: z.coerce.date()
});

router.post(
  '/periods/ensure',
  asyncHandler(async (req, res) => {
    const { reference } = parseWithSchema(ensurePeriodSchema, req.body, 'Invalid reference');
    const period = await ensurePayrollPeriod(reference);
    res.status(201).json({ period });
  })
);

router.get(
  '/periods',
  asyncHandler(async (_req, res) => {
    const periods = await prisma.payrollPeriod.findMany({
      orderBy: { periodStart: 'desc' },
      include: {
        checks: true
      },
      take: 24
    });
    res.json({ periods });
  })
);

router.post(
  '/periods/:id/recalc',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const periodId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(periodId)) {
      return res.status(400).json({ error: 'Invalid period id' });
    }
    await recalcPayrollPeriod(periodId, { actorId: req.user?.id });
    res.status(202).json({ periodId });
  })
);

const statusSchema = z.object({
  status: z.enum(['DRAFT', 'APPROVED', 'PAID'])
});

router.post(
  '/periods/:id/status',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const periodId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(periodId)) {
      return res.status(400).json({ error: 'Invalid period id' });
    }
    const { status } = parseWithSchema(statusSchema, req.body, 'Invalid status');
    const period = await markPayrollPeriodStatus(periodId, status, req.user?.id);
    res.json({ period });
  })
);

router.get(
  '/paydates/:date/bonuses',
  asyncHandler(async (req, res) => {
    const dateParam = req.params.date;
    const payDate = new Date(dateParam);
    if (Number.isNaN(payDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    const bonuses = await getBonusesPayableOn(payDate);
    res.json({ bonuses });
  })
);

router.get(
  '/paydates/:date/export',
  asyncHandler(async (req, res) => {
    const dateParam = req.params.date;
    const payDate = new Date(dateParam);
    if (Number.isNaN(payDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    const period = await prisma.payrollPeriod.findFirst({
      where: { payDate },
      include: {
        checks: {
          include: {
            user: { select: { id: true, name: true, email: true } }
          }
        }
      }
    });

    if (!period) {
      return res.status(404).json({ error: 'Payroll period not found for pay date' });
    }

    const header = [
      'employee_id',
      'employee_name',
      'employee_email',
      'period_start',
      'period_end',
      'pay_date',
      'base_amount',
      'monthly_bonus',
      'deferred_monthly_bonus',
      'quarterly_bonus',
      'kpi_bonus',
      'total_amount',
      'status'
    ];

    const rows = period.checks.map((check) => [
      check.userId,
      check.user?.name ?? '',
      check.user?.email ?? '',
      period.periodStart.toISOString(),
      period.periodEnd.toISOString(),
      period.payDate.toISOString(),
      Number(check.baseAmount).toFixed(2),
      Number(check.monthlyAttendanceBonus).toFixed(2),
      Number(check.deferredMonthlyBonus).toFixed(2),
      Number(check.quarterlyAttendanceBonus).toFixed(2),
      Number(check.kpiBonus).toFixed(2),
      Number(check.totalAmount).toFixed(2),
      check.status
    ]);

    const csv = [header, ...rows]
      .map((cols) =>
        cols
          .map((value) => {
            const str = String(value ?? '');
            return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
          })
          .join(',')
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${dateParam}.csv"`);
    res.send(csv);
  })
);

const bonusQuerySchema = z.object({
  type: z.enum(['MONTHLY_ATTENDANCE', 'QUARTERLY_ATTENDANCE', 'KPI']).optional(),
  status: z.enum(['PENDING', 'ELIGIBLE', 'APPROVED', 'DENIED', 'PAID']).optional()
});

router.get(
  '/bonuses',
  asyncHandler(async (req, res) => {
    const filters = parseWithSchema(bonusQuerySchema, req.query, 'Invalid query');
    const bonuses = await listBonuses(filters);
    res.json({ bonuses });
  })
);

const bonusDecisionSchema = z.object({
  status: z.enum(['APPROVED', 'DENIED']),
  amount: z.number().min(0).optional(),
  reason: z.string().optional()
});

router.post(
  '/bonuses/:id/decision',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const bonusId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(bonusId)) {
      return res.status(400).json({ error: 'Invalid bonus id' });
    }
    const { status, amount, reason } = parseWithSchema(bonusDecisionSchema, req.body, 'Invalid payload');
    const bonus = await decideBonus({
      bonusId,
      status,
      amount,
      reason: reason ?? null,
      actorId: req.user?.id
    });
    res.json({ bonus });
  })
);

const ensureKpiSchema = z.object({
  userId: z.number().int().positive(),
  month: z.coerce.date()
});

router.post(
  '/kpi/candidate',
  asyncHandler(async (req, res) => {
    const { userId, month } = parseWithSchema(ensureKpiSchema, req.body, 'Invalid payload');
    const bonus = await ensureKpiBonusCandidate(userId, month);
    res.status(201).json({ bonus });
  })
);

export { router as payrollRouter };

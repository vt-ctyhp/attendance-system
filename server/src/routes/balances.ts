import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, type AuthenticatedRequest } from '../auth';
import { recalcBalance, getBalanceOverview, adjustPtoBalance, syncTimeOffBalances } from '../services/balances';
import { applyMonthlyAccrual, setUserAccrualRule } from '../services/accruals';
import { format } from 'date-fns';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { HttpError } from '../errors';
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
import { MAKEUP_CAP_CONFIG_KEY, getMakeupCapHoursPerMonth } from '../services/timeRequestPolicy';
import { setConfigValue } from '../services/config';

const balancesRouter = Router();

const userIdParamSchema = z.object({ userId: z.coerce.number().int().positive() });

export const getUserBalance = async (req: AuthenticatedRequest, res: Response) => {
  const { userId } = parseWithSchema(userIdParamSchema, req.params, 'Invalid user id');

  const requester = req.user!;
  if (requester.role === 'employee' && requester.id !== userId) {
    throw HttpError.forbidden();
  }

  const overview = await getBalanceOverview(userId, { limit: 200 });
  return res.json(overview);
};

balancesRouter.get('/:userId', authenticate, asyncHandler(getUserBalance));

const adjustmentSchema = z.object({
  deltaHours: z
    .number()
    .finite()
    .refine((value) => value !== 0 && Math.abs(value) <= 1000, 'Delta hours must be between -1000 and 1000 and non-zero')
    .transform((value) => Math.round(value * 100) / 100),
  reason: z
    .string()
    .trim()
    .min(1, 'Reason is required')
    .max(500, 'Reason must be 500 characters or fewer')
});

const setBalancesSchema = z
  .object({
    ptoHours: z.number().finite().optional(),
    ptoBaseHours: z.number().finite().optional(),
    utoHours: z.number().finite().optional(),
    utoBaseHours: z.number().finite().optional(),
    makeUpHours: z.number().finite().optional(),
    ptoAccrualHours: z.number().finite().min(0).max(1000).optional(),
    utoAccrualHours: z.number().finite().min(0).max(1000).optional(),
    makeUpCapHours: z.number().finite().min(0).max(1000).optional(),
    reason: z.string().trim().max(500).optional()
  })
  .refine(
    (data) =>
      [
        data.ptoHours,
        data.utoHours,
        data.makeUpHours,
        data.ptoAccrualHours,
        data.utoAccrualHours,
        data.ptoBaseHours,
        data.utoBaseHours,
        data.makeUpCapHours
      ].some(
        (value) => value !== undefined
      ),
    {
      message: 'Provide at least one balance or accrual value to update.'
    }
  );

balancesRouter.post(
  '/:userId/adjust',
  authenticate,
  requireRole(['admin', 'manager']),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { userId } = parseWithSchema(userIdParamSchema, req.params, 'Invalid user id');
    const { deltaHours, reason } = parseWithSchema(adjustmentSchema, req.body, 'Invalid adjustment payload');

    const actorId = req.user!.id;
    const result = await adjustPtoBalance({
      userId,
      deltaHours,
      reason,
      createdById: actorId
    });

    const overview = await getBalanceOverview(userId, { limit: 200 });

    return res.status(201).json({ ...overview, entry: result.entry });
  })
);

balancesRouter.post(
  '/:userId/set',
  authenticate,
  requireRole(['admin', 'manager']),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { userId } = parseWithSchema(userIdParamSchema, req.params, 'Invalid user id');
    const payload = parseWithSchema(setBalancesSchema, req.body, 'Invalid balance payload');

    const actorId = req.user!.id;
    const now = new Date();
    const latestConfig = await prisma.employeeCompConfig.findFirst({
      where: { userId, effectiveOn: { lte: now } },
      orderBy: { effectiveOn: 'desc' }
    });

    const reasonText = payload.reason && payload.reason.trim().length
      ? payload.reason.trim()
      : 'Balances tab update';

    await syncTimeOffBalances({
      userId,
      actorId,
      ptoHours: payload.ptoHours,
      ptoBaseHours: payload.ptoBaseHours,
      utoHours: payload.utoHours,
      utoBaseHours: payload.utoBaseHours,
      makeUpHours: payload.makeUpHours,
      accrualEnabled: latestConfig?.accrualEnabled ?? true,
      reason: reasonText
    });

    if (latestConfig) {
      const updateData: Prisma.EmployeeCompConfigUpdateInput = {};
      if (payload.ptoHours !== undefined) {
        updateData.ptoBalanceHours = new Prisma.Decimal(payload.ptoHours);
      }
      if (payload.utoHours !== undefined) {
        updateData.utoBalanceHours = new Prisma.Decimal(payload.utoHours);
      }
      if (Object.keys(updateData).length > 0) {
        await prisma.employeeCompConfig.update({ where: { id: latestConfig.id }, data: updateData });
      }
    }

    await setUserAccrualRule({
      userId,
      ptoHoursPerMonth: payload.ptoAccrualHours,
      utoHoursPerMonth: payload.utoAccrualHours,
      actorId
    });

    if (payload.makeUpCapHours !== undefined) {
      await setConfigValue(MAKEUP_CAP_CONFIG_KEY, payload.makeUpCapHours.toString());
    }

    const overview = await getBalanceOverview(userId, { limit: 200 });
    const userRule = await prisma.accrualRule.findUnique({ where: { userId } });
    const defaultRule = await prisma.accrualRule.findFirst({ where: { isDefault: true } });
    const makeupCap = await getMakeupCapHoursPerMonth();

    const resolveAccrual = (extract: (rule: typeof userRule) => number | null) => {
      if (userRule) {
        return extract(userRule);
      }
      if (defaultRule) {
        return extract(defaultRule);
      }
      return null;
    };

    return res.status(200).json({
      ...overview,
      accrualDetails: {
        ptoHoursPerMonth: resolveAccrual((rule) => Number(rule?.ptoHoursPerMonth ?? rule?.hoursPerMonth ?? 0)),
        utoHoursPerMonth: resolveAccrual((rule) => Number(rule?.utoHoursPerMonth ?? 0)),
        makeUpCapHours: makeupCap,
        source: userRule ? 'user' : defaultRule ? 'default' : 'none'
      },
      makeUpCapHours: makeupCap
    });
  })
);

balancesRouter.post(
  '/recalc',
  authenticate,
  requireRole(['admin', 'manager']),
  asyncHandler(async (req, res) => {
    const querySchema = z.object({ userId: z.coerce.number().int().positive() });
    const { userId } = parseWithSchema(querySchema, req.query, 'Invalid query');

    const balance = await recalcBalance(userId);
    return res.json({ balance });
  })
);

balancesRouter.post(
  '/accrue',
  authenticate,
  requireRole(['admin', 'manager']),
  asyncHandler(async (req, res) => {
    const querySchema = z.object({ userId: z.coerce.number().int().positive().optional() });
    const { userId } = parseWithSchema(querySchema, req.query, 'Invalid query');

    const now = new Date();
    const results = await applyMonthlyAccrual(now, userId);
    const applied = results.filter((r) => r.applied).length;
    return res.json({ month: format(now, 'yyyy-MM'), applied, results });
  })
);

export { balancesRouter };

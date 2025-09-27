import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, type AuthenticatedRequest } from '../auth';
import { recalcBalance, getBalanceOverview, adjustPtoBalance } from '../services/balances';
import { applyMonthlyAccrual } from '../services/accruals';
import { format } from 'date-fns';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { HttpError } from '../errors';

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

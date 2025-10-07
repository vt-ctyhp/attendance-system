import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { differenceInMinutes } from 'date-fns';
import { authenticate, requireRole, type AuthenticatedRequest } from '../auth';
import { prisma } from '../prisma';
import { TIME_REQUEST_TYPES, TIME_REQUEST_STATUSES } from '../types';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { HttpError } from '../errors';
import {
  getMakeupCapHoursPerMonth,
  getApprovedMakeupHoursThisMonth,
  exceedsMonthlyCap,
  remainingHoursWithinCap
} from '../services/timeRequestPolicy';
import { recordLedgerEntry } from '../services/balances';

const timeRequestTypeEnum = z.enum(TIME_REQUEST_TYPES);
const timeRequestStatusEnum = z.enum(TIME_REQUEST_STATUSES);

const dateValue = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return value;
}, z.date());

const createSchema = z
  .object({
    userId: z.number().int().positive().optional(),
    type: timeRequestTypeEnum,
    startDate: dateValue,
    endDate: dateValue.optional(),
    hours: z.number().positive().max(1000).optional(),
    reason: z.string().max(500).optional()
  })
  .superRefine((data, ctx) => {
    if (data.endDate && data.endDate < data.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must be on or after startDate'
      });
    }

    if (!data.hours && !data.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hours'],
        message: 'Provide hours or endDate'
      });
    }
  });

const listQuerySchema = z.object({
  status: timeRequestStatusEnum.optional(),
  type: timeRequestTypeEnum.optional(),
  userId: z.coerce.number().int().positive().optional(),
  from: dateValue.optional(),
  to: dateValue.optional()
});

const approveSchema = z.object({
  hours: z.number().positive().max(1000).optional()
});

const paramsSchema = z.object({ id: z.string().min(1) });

type CreateRequestInput = z.infer<typeof createSchema>;
type ListQueryInput = z.infer<typeof listQuerySchema>;
type ApproveInput = z.infer<typeof approveSchema>;

const timeRequestsRouter = Router();

const formatHourValue = (value: number) =>
  Number.isFinite(value) ? (Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)) : '0';

const buildCapExceededMessage = (cap: number, approved: number, remaining: number) =>
  `Request exceeds monthly cap (${formatHourValue(cap)}h). Approved this month: ${formatHourValue(approved)}h. Remaining: ${formatHourValue(remaining)}h.`;

export const createTimeRequest: (req: AuthenticatedRequest, res: Response) => Promise<Response> = async (
  req,
  res
) => {
  const {
    userId: requestedUserId,
    type,
    startDate,
    endDate: rawEndDate,
    hours,
    reason
  } = parseWithSchema<CreateRequestInput>(createSchema, req.body);
  const requester = req.user!;
  const targetUserId = requestedUserId ?? requester.id;

  const endDate = rawEndDate ?? startDate;

  const canManageOthers = requester.role === 'admin' || requester.role === 'manager';
  if (requestedUserId && !canManageOthers) {
    throw HttpError.forbidden();
  }
  if (targetUserId !== requester.id && !canManageOthers) {
    throw HttpError.forbidden();
  }

  let effectiveHours = hours;
  if (effectiveHours === undefined) {
    const minutes = differenceInMinutes(endDate, startDate);
    if (minutes <= 0) {
      throw HttpError.badRequest('Unable to infer hours from provided dates');
    }
    effectiveHours = Math.round((minutes / 60) * 100) / 100;
  }

  if (effectiveHours <= 0) {
    throw HttpError.badRequest('Hours must be greater than zero');
  }

  if (type === 'make_up') {
    const makeupCap = await getMakeupCapHoursPerMonth();
    const approvedThisMonth = await getApprovedMakeupHoursThisMonth(prisma, targetUserId);
    if (exceedsMonthlyCap(approvedThisMonth, effectiveHours, makeupCap)) {
      const remaining = remainingHoursWithinCap(approvedThisMonth, makeupCap);
      throw HttpError.badRequest(buildCapExceededMessage(makeupCap, approvedThisMonth, remaining));
    }
  }

  const request = await prisma.timeRequest.create({
    data: {
      userId: targetUserId,
      type,
      startDate,
      endDate,
      hours: effectiveHours,
      reason,
      status: 'pending'
    }
  });

  return res.status(201).json({ request });
};

timeRequestsRouter.post('/', authenticate, asyncHandler(createTimeRequest));

timeRequestsRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const filters = parseWithSchema<ListQueryInput>(listQuerySchema, req.query, 'Invalid query');
    const where: Prisma.TimeRequestWhereInput = {};

    if (filters.status) where.status = filters.status;
    if (filters.type) where.type = filters.type;
    if (filters.userId) where.userId = filters.userId;
    if (filters.from || filters.to) {
      const dateFilter: Prisma.DateTimeFilter = {};
      if (filters.from) {
        dateFilter.gte = filters.from;
      }
      if (filters.to) {
        dateFilter.lte = filters.to;
      }
      where.startDate = dateFilter;
    }

    const requester = req.user!;
    if (!filters.userId && requester.role === 'employee') {
      where.userId = requester.id;
    } else if (filters.userId && requester.role === 'employee' && filters.userId !== requester.id) {
      throw HttpError.forbidden();
    }

    const requests = await prisma.timeRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        approver: { select: { id: true, name: true, email: true } }
      }
    });

    return res.json({ requests });
  })
);

timeRequestsRouter.get(
  '/my',
  authenticate,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const requester = req.user!;
    const requests = await prisma.timeRequest.findMany({
      where: { userId: requester.id },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ requests });
  })
);

export const approveTimeRequest: (req: AuthenticatedRequest, res: Response) => Promise<Response> = async (
  req,
  res
) => {
  const { id } = parseWithSchema(paramsSchema, req.params, 'Invalid request id');
  const data = parseWithSchema<ApproveInput>(approveSchema, req.body ?? {});
  const makeupCap = await getMakeupCapHoursPerMonth();

  const result = await prisma.$transaction(async (tx) => {
    const request = await tx.timeRequest.findUnique({
      where: { id },
      include: { user: true }
    });
    if (!request) {
      throw HttpError.notFound('Time request not found');
    }
    if (request.status !== 'pending') {
      throw HttpError.conflict('Time request already processed');
    }

    const effectiveHours = data.hours ?? request.hours;
    if (effectiveHours <= 0) {
      throw HttpError.badRequest('Invalid hours value');
    }

    const balance = await tx.ptoBalance.upsert({
      where: { userId: request.userId },
      update: {},
      create: { userId: request.userId }
    });

    let updatedBalance = balance;
    switch (request.type) {
      case 'pto': {
        if (balance.ptoHours < effectiveHours) {
          throw HttpError.badRequest('Insufficient PTO balance');
        }
        updatedBalance = await tx.ptoBalance.update({
          where: { id: balance.id },
          data: {
            ptoHours: balance.ptoHours - effectiveHours
          }
        });
        await recordLedgerEntry(
          {
            userId: request.userId,
            deltaHours: -effectiveHours,
            reason: `PTO request ${request.id} approved`,
            createdById: req.user!.id
          },
          tx
        );
        break;
      }
      case 'uto':
      case 'non_pto': {
        const shouldDecrement = balance.baseUtoHours > 0;
        updatedBalance = shouldDecrement
          ? await tx.ptoBalance.update({
              where: { id: balance.id },
              data: {
                utoHours: Math.max(balance.utoHours - effectiveHours, 0)
              }
            })
          : balance;
        break;
      }
      case 'make_up': {
        const approvedThisMonth = await getApprovedMakeupHoursThisMonth(tx, request.userId);
        if (exceedsMonthlyCap(approvedThisMonth, effectiveHours, makeupCap)) {
          const remaining = remainingHoursWithinCap(approvedThisMonth, makeupCap);
          throw HttpError.badRequest(buildCapExceededMessage(makeupCap, approvedThisMonth, remaining));
        }
        updatedBalance = await tx.ptoBalance.update({
          where: { id: balance.id },
          data: {
            makeUpHours: balance.makeUpHours + effectiveHours
          }
        });
        break;
      }
      default:
        throw HttpError.badRequest('Unsupported request type');
    }

    const updatedRequest = await tx.timeRequest.update({
      where: { id },
      data: {
        status: 'approved',
        hours: effectiveHours,
        approverId: req.user!.id,
        approvedAt: new Date()
      }
    });

    return { updatedRequest, updatedBalance };
  });

  return res.json(result);
};

timeRequestsRouter.post(
  '/:id/approve',
  authenticate,
  requireRole(['admin', 'manager']),
  asyncHandler(approveTimeRequest)
);

export const denyTimeRequest: (req: AuthenticatedRequest, res: Response) => Promise<Response> = async (
  req,
  res
) => {
  const { id } = parseWithSchema(paramsSchema, req.params, 'Invalid request id');

  const request = await prisma.timeRequest.findUnique({ where: { id } });
  if (!request) {
    throw HttpError.notFound('Time request not found');
  }
  if (request.status !== 'pending') {
    throw HttpError.conflict('Time request already processed');
  }

  const updated = await prisma.timeRequest.update({
    where: { id },
    data: {
      status: 'denied',
      approverId: req.user!.id,
      approvedAt: new Date()
    }
  });

  return res.json({ request: updated });
};

timeRequestsRouter.post(
  '/:id/deny',
  authenticate,
  requireRole(['admin', 'manager']),
  asyncHandler(denyTimeRequest)
);

export { timeRequestsRouter };

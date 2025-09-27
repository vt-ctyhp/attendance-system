import { Router } from 'express';
import { z } from 'zod';
import { parseISO } from 'date-fns';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedRequest } from '../auth';
import { authenticate, requireRole } from '../auth';
import { prisma } from '../prisma';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import {
  getUserTimesheet,
  computeTimesheetRange,
  timesheetDayStart,
  TIMESHEET_TIME_ZONE
} from '../services/timesheets';
import {
  TIMESHEET_VIEWS,
  TIMESHEET_EDIT_STATUSES,
  type TimesheetView,
  type TimesheetEditStatus
} from '../types';
import { HttpError } from '../errors';

const viewEnum = z.enum(TIMESHEET_VIEWS);
const statusEnum = z.enum(TIMESHEET_EDIT_STATUSES);

const toValidDate = (value: string, field: string): Date => {
  const parsed = parseISO(value);
  if (Number.isNaN(parsed.getTime())) {
    throw HttpError.badRequest(`Invalid ${field}`);
  }
  return parsed;
};

const normalizeReferenceDate = (view: TimesheetView, input?: string, month?: string) => {
  if (view === 'monthly') {
    const source = month ?? input;
    if (!source) {
      return new Date();
    }
    const formatted = source.length === 7 ? `${source}-01` : source;
    return toValidDate(`${formatted}T00:00:00`, 'month');
  }

  const source = input ?? month;
  if (!source) {
    return new Date();
  }
  return toValidDate(source, 'date');
};

const requestSummary = (request: {
  id: string;
  userId: number;
  view: string;
  periodStart: Date;
  periodEnd: Date;
  targetDate: Date;
  reason: string;
  status: string;
  requestedMinutes: number | null;
  adminNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user?: { id: number; name: string | null; email: string } | null;
  reviewer?: { id: number; name: string | null; email: string } | null;
}) => ({
  id: request.id,
  userId: request.userId,
  view: request.view,
  periodStart: request.periodStart.toISOString(),
  periodEnd: request.periodEnd.toISOString(),
  targetDate: request.targetDate.toISOString(),
  reason: request.reason,
  status: request.status,
  requestedMinutes: request.requestedMinutes,
  adminNote: request.adminNote,
  reviewedAt: request.reviewedAt ? request.reviewedAt.toISOString() : null,
  createdAt: request.createdAt.toISOString(),
  updatedAt: request.updatedAt.toISOString(),
  user: request.user
    ? { id: request.user.id, name: request.user.name, email: request.user.email }
    : undefined,
  reviewer: request.reviewer
    ? { id: request.reviewer.id, name: request.reviewer.name, email: request.reviewer.email }
    : undefined
});

export const timesheetsRouter = Router();

timesheetsRouter.use(authenticate);

timesheetsRouter.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const querySchema = z.object({
      view: viewEnum.default('pay_period'),
      date: z.string().optional(),
      month: z.string().optional(),
      userId: z.coerce.number().int().positive().optional()
    });

    const { view, date, month, userId } = parseWithSchema(querySchema, req.query, 'Invalid query');
    const requester = req.user!;

    let targetUserId = requester.id;
    if (userId && userId !== requester.id) {
      if (requester.role !== 'admin' && requester.role !== 'manager') {
        throw HttpError.forbidden();
      }
      targetUserId = userId;
    }

    const reference = normalizeReferenceDate(view, date, month);
    const timesheet = await getUserTimesheet(targetUserId, view, reference);

    res.json({
      userId: targetUserId,
      view,
      timezone: TIMESHEET_TIME_ZONE,
      timesheet
    });
  })
);

timesheetsRouter.get(
  '/edit-requests',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const querySchema = z.object({
      status: statusEnum.optional(),
      view: viewEnum.optional(),
      userId: z.coerce.number().int().positive().optional()
    });

    const { status, view, userId } = parseWithSchema(querySchema, req.query, 'Invalid query');
    const requester = req.user!;

    const where: Prisma.TimesheetEditRequestWhereInput = {};
    if (status) where.status = status;
    if (view) where.view = view;

    if (requester.role === 'employee') {
      where.userId = requester.id;
    } else if (userId) {
      where.userId = userId;
    }

    const requests = await prisma.timesheetEditRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        reviewer: { select: { id: true, name: true, email: true } }
      }
    });

    res.json({ requests: requests.map(requestSummary) });
  })
);

timesheetsRouter.post(
  '/edit-requests',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const bodySchema = z.object({
      view: viewEnum,
      rangeStart: z.string().nonempty(),
      targetDate: z.string().nonempty(),
      reason: z.string().min(5).max(1000),
      requestedMinutes: z.number().int().min(0).max(24 * 60).optional()
    });

    const { view, rangeStart, targetDate, reason, requestedMinutes } = parseWithSchema(
      bodySchema,
      req.body ?? {},
      'Invalid payload'
    );

    const requester = req.user!;
    const referenceDate = toValidDate(rangeStart, 'rangeStart');
    const range = computeTimesheetRange(view, referenceDate);
    const target = toValidDate(targetDate, 'targetDate');
    const normalizedTarget = timesheetDayStart(target);

    if (normalizedTarget < range.start || normalizedTarget > range.end) {
      throw HttpError.badRequest('Target date is outside the selected timesheet range');
    }

    const existing = await prisma.timesheetEditRequest.findFirst({
      where: {
        userId: requester.id,
        view,
        periodStart: range.start,
        periodEnd: range.end,
        targetDate: normalizedTarget,
        status: 'pending'
      }
    });

    if (existing) {
      throw HttpError.conflict('An edit request for this day is already pending');
    }

    const created = await prisma.timesheetEditRequest.create({
      data: {
        userId: requester.id,
        view,
        periodStart: range.start,
        periodEnd: range.end,
        targetDate: normalizedTarget,
        reason,
        status: 'pending',
        requestedMinutes: requestedMinutes ?? null
      }
    });

    res.status(201).json({ request: requestSummary(created) });
  })
);

timesheetsRouter.patch(
  '/edit-requests/:id',
  requireRole(['admin', 'manager']),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const paramsSchema = z.object({ id: z.string().min(1) });
    const { id } = parseWithSchema(paramsSchema, req.params, 'Invalid request id');

    const bodySchema = z
      .object({
        status: statusEnum.optional(),
        adminNote: z.string().max(1000).optional(),
        requestedMinutes: z.number().int().min(0).max(24 * 60).optional()
      })
      .refine((data) => data.status || data.adminNote !== undefined || data.requestedMinutes !== undefined, {
        message: 'Provide at least one field to update'
      });

    const { status, adminNote, requestedMinutes } = parseWithSchema(bodySchema, req.body ?? {}, 'Invalid payload');

    const existing = await prisma.timesheetEditRequest.findUnique({ where: { id } });
    if (!existing) {
      throw HttpError.notFound('Edit request not found');
    }

    const updates: Parameters<typeof prisma.timesheetEditRequest.update>[0]['data'] = {};

    if (status) {
      updates.status = status;
      if (status === 'pending') {
        updates.reviewedAt = null;
        updates.reviewerId = null;
      } else {
        updates.reviewedAt = new Date();
        updates.reviewerId = req.user!.id;
      }
    }

    if (adminNote !== undefined) {
      updates.adminNote = adminNote;
    }

    if (requestedMinutes !== undefined) {
      updates.requestedMinutes = requestedMinutes;
    }

    const updated = await prisma.timesheetEditRequest.update({ where: { id }, data: updates });

    res.json({ request: requestSummary(updated) });
  })
);

export default timesheetsRouter;

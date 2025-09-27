"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timesheetsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const date_fns_1 = require("date-fns");
const auth_1 = require("../auth");
const prisma_1 = require("../prisma");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const timesheets_1 = require("../services/timesheets");
const types_1 = require("../types");
const errors_1 = require("../errors");
const viewEnum = zod_1.z.enum(types_1.TIMESHEET_VIEWS);
const statusEnum = zod_1.z.enum(types_1.TIMESHEET_EDIT_STATUSES);
const toValidDate = (value, field) => {
    const parsed = (0, date_fns_1.parseISO)(value);
    if (Number.isNaN(parsed.getTime())) {
        throw errors_1.HttpError.badRequest(`Invalid ${field}`);
    }
    return parsed;
};
const normalizeReferenceDate = (view, input, month) => {
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
const requestSummary = (request) => ({
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
exports.timesheetsRouter = (0, express_1.Router)();
exports.timesheetsRouter.use(auth_1.authenticate);
exports.timesheetsRouter.get('/', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const querySchema = zod_1.z.object({
        view: viewEnum.default('pay_period'),
        date: zod_1.z.string().optional(),
        month: zod_1.z.string().optional(),
        userId: zod_1.z.coerce.number().int().positive().optional()
    });
    const { view, date, month, userId } = (0, validation_1.parseWithSchema)(querySchema, req.query, 'Invalid query');
    const requester = req.user;
    let targetUserId = requester.id;
    if (userId && userId !== requester.id) {
        if (requester.role !== 'admin' && requester.role !== 'manager') {
            throw errors_1.HttpError.forbidden();
        }
        targetUserId = userId;
    }
    const reference = normalizeReferenceDate(view, date, month);
    const timesheet = await (0, timesheets_1.getUserTimesheet)(targetUserId, view, reference);
    res.json({
        userId: targetUserId,
        view,
        timezone: timesheets_1.TIMESHEET_TIME_ZONE,
        timesheet
    });
}));
exports.timesheetsRouter.get('/edit-requests', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const querySchema = zod_1.z.object({
        status: statusEnum.optional(),
        view: viewEnum.optional(),
        userId: zod_1.z.coerce.number().int().positive().optional()
    });
    const { status, view, userId } = (0, validation_1.parseWithSchema)(querySchema, req.query, 'Invalid query');
    const requester = req.user;
    const where = {};
    if (status)
        where.status = status;
    if (view)
        where.view = view;
    if (requester.role === 'employee') {
        where.userId = requester.id;
    }
    else if (userId) {
        where.userId = userId;
    }
    const requests = await prisma_1.prisma.timesheetEditRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            user: { select: { id: true, name: true, email: true } },
            reviewer: { select: { id: true, name: true, email: true } }
        }
    });
    res.json({ requests: requests.map(requestSummary) });
}));
exports.timesheetsRouter.post('/edit-requests', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const bodySchema = zod_1.z.object({
        view: viewEnum,
        rangeStart: zod_1.z.string().nonempty(),
        targetDate: zod_1.z.string().nonempty(),
        reason: zod_1.z.string().min(5).max(1000),
        requestedMinutes: zod_1.z.number().int().min(0).max(24 * 60).optional()
    });
    const { view, rangeStart, targetDate, reason, requestedMinutes } = (0, validation_1.parseWithSchema)(bodySchema, req.body ?? {}, 'Invalid payload');
    const requester = req.user;
    const referenceDate = toValidDate(rangeStart, 'rangeStart');
    const range = (0, timesheets_1.computeTimesheetRange)(view, referenceDate);
    const target = toValidDate(targetDate, 'targetDate');
    const normalizedTarget = (0, timesheets_1.timesheetDayStart)(target);
    if (normalizedTarget < range.start || normalizedTarget > range.end) {
        throw errors_1.HttpError.badRequest('Target date is outside the selected timesheet range');
    }
    const existing = await prisma_1.prisma.timesheetEditRequest.findFirst({
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
        throw errors_1.HttpError.conflict('An edit request for this day is already pending');
    }
    const created = await prisma_1.prisma.timesheetEditRequest.create({
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
}));
exports.timesheetsRouter.patch('/edit-requests/:id', (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const paramsSchema = zod_1.z.object({ id: zod_1.z.string().min(1) });
    const { id } = (0, validation_1.parseWithSchema)(paramsSchema, req.params, 'Invalid request id');
    const bodySchema = zod_1.z
        .object({
        status: statusEnum.optional(),
        adminNote: zod_1.z.string().max(1000).optional(),
        requestedMinutes: zod_1.z.number().int().min(0).max(24 * 60).optional()
    })
        .refine((data) => data.status || data.adminNote !== undefined || data.requestedMinutes !== undefined, {
        message: 'Provide at least one field to update'
    });
    const { status, adminNote, requestedMinutes } = (0, validation_1.parseWithSchema)(bodySchema, req.body ?? {}, 'Invalid payload');
    const existing = await prisma_1.prisma.timesheetEditRequest.findUnique({ where: { id } });
    if (!existing) {
        throw errors_1.HttpError.notFound('Edit request not found');
    }
    const updates = {};
    if (status) {
        updates.status = status;
        if (status === 'pending') {
            updates.reviewedAt = null;
            updates.reviewerId = null;
        }
        else {
            updates.reviewedAt = new Date();
            updates.reviewerId = req.user.id;
        }
    }
    if (adminNote !== undefined) {
        updates.adminNote = adminNote;
    }
    if (requestedMinutes !== undefined) {
        updates.requestedMinutes = requestedMinutes;
    }
    const updated = await prisma_1.prisma.timesheetEditRequest.update({ where: { id }, data: updates });
    res.json({ request: requestSummary(updated) });
}));
exports.default = exports.timesheetsRouter;

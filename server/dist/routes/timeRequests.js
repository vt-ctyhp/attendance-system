"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeRequestsRouter = exports.denyTimeRequest = exports.approveTimeRequest = exports.createTimeRequest = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const date_fns_1 = require("date-fns");
const auth_1 = require("../auth");
const prisma_1 = require("../prisma");
const types_1 = require("../types");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const errors_1 = require("../errors");
const timeRequestPolicy_1 = require("../services/timeRequestPolicy");
const balances_1 = require("../services/balances");
const timeRequestTypeEnum = zod_1.z.enum(types_1.TIME_REQUEST_TYPES);
const timeRequestStatusEnum = zod_1.z.enum(types_1.TIME_REQUEST_STATUSES);
const dateValue = zod_1.z.preprocess((value) => {
    if (value instanceof Date)
        return value;
    if (typeof value === 'string') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }
    return value;
}, zod_1.z.date());
const createSchema = zod_1.z
    .object({
    userId: zod_1.z.number().int().positive().optional(),
    type: timeRequestTypeEnum,
    startDate: dateValue,
    endDate: dateValue.optional(),
    hours: zod_1.z.number().positive().max(1000).optional(),
    reason: zod_1.z.string().max(500).optional()
})
    .superRefine((data, ctx) => {
    if (data.endDate && data.endDate < data.startDate) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ['endDate'],
            message: 'endDate must be on or after startDate'
        });
    }
    if (!data.hours && !data.endDate) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ['hours'],
            message: 'Provide hours or endDate'
        });
    }
});
const listQuerySchema = zod_1.z.object({
    status: timeRequestStatusEnum.optional(),
    type: timeRequestTypeEnum.optional(),
    userId: zod_1.z.coerce.number().int().positive().optional(),
    from: dateValue.optional(),
    to: dateValue.optional()
});
const approveSchema = zod_1.z.object({
    hours: zod_1.z.number().positive().max(1000).optional()
});
const paramsSchema = zod_1.z.object({ id: zod_1.z.string().min(1) });
const timeRequestsRouter = (0, express_1.Router)();
exports.timeRequestsRouter = timeRequestsRouter;
const formatHourValue = (value) => Number.isFinite(value) ? (Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)) : '0';
const buildCapExceededMessage = (cap, approved, remaining) => `Request exceeds monthly cap (${formatHourValue(cap)}h). Approved this month: ${formatHourValue(approved)}h. Remaining: ${formatHourValue(remaining)}h.`;
const createTimeRequest = async (req, res) => {
    const { userId: requestedUserId, type, startDate, endDate: rawEndDate, hours, reason } = (0, validation_1.parseWithSchema)(createSchema, req.body);
    const requester = req.user;
    const targetUserId = requestedUserId ?? requester.id;
    const endDate = rawEndDate ?? startDate;
    const canManageOthers = requester.role === 'admin' || requester.role === 'manager';
    if (requestedUserId && !canManageOthers) {
        throw errors_1.HttpError.forbidden();
    }
    if (targetUserId !== requester.id && !canManageOthers) {
        throw errors_1.HttpError.forbidden();
    }
    let effectiveHours = hours;
    if (effectiveHours === undefined) {
        const minutes = (0, date_fns_1.differenceInMinutes)(endDate, startDate);
        if (minutes <= 0) {
            throw errors_1.HttpError.badRequest('Unable to infer hours from provided dates');
        }
        effectiveHours = Math.round((minutes / 60) * 100) / 100;
    }
    if (effectiveHours <= 0) {
        throw errors_1.HttpError.badRequest('Hours must be greater than zero');
    }
    if (type === 'make_up') {
        const makeupCap = await (0, timeRequestPolicy_1.getMakeupCapHoursPerMonth)();
        const approvedThisMonth = await (0, timeRequestPolicy_1.getApprovedMakeupHoursThisMonth)(prisma_1.prisma, targetUserId);
        if ((0, timeRequestPolicy_1.exceedsMonthlyCap)(approvedThisMonth, effectiveHours, makeupCap)) {
            const remaining = (0, timeRequestPolicy_1.remainingHoursWithinCap)(approvedThisMonth, makeupCap);
            throw errors_1.HttpError.badRequest(buildCapExceededMessage(makeupCap, approvedThisMonth, remaining));
        }
    }
    const request = await prisma_1.prisma.timeRequest.create({
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
exports.createTimeRequest = createTimeRequest;
timeRequestsRouter.post('/', auth_1.authenticate, (0, asyncHandler_1.asyncHandler)(exports.createTimeRequest));
timeRequestsRouter.get('/', auth_1.authenticate, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const filters = (0, validation_1.parseWithSchema)(listQuerySchema, req.query, 'Invalid query');
    const where = {};
    if (filters.status)
        where.status = filters.status;
    if (filters.type)
        where.type = filters.type;
    if (filters.userId)
        where.userId = filters.userId;
    if (filters.from || filters.to) {
        const dateFilter = {};
        if (filters.from) {
            dateFilter.gte = filters.from;
        }
        if (filters.to) {
            dateFilter.lte = filters.to;
        }
        where.startDate = dateFilter;
    }
    const requester = req.user;
    if (!filters.userId && requester.role === 'employee') {
        where.userId = requester.id;
    }
    else if (filters.userId && requester.role === 'employee' && filters.userId !== requester.id) {
        throw errors_1.HttpError.forbidden();
    }
    const requests = await prisma_1.prisma.timeRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
            user: { select: { id: true, name: true, email: true } },
            approver: { select: { id: true, name: true, email: true } }
        }
    });
    return res.json({ requests });
}));
timeRequestsRouter.get('/my', auth_1.authenticate, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const requester = req.user;
    const requests = await prisma_1.prisma.timeRequest.findMany({
        where: { userId: requester.id },
        orderBy: { createdAt: 'desc' }
    });
    return res.json({ requests });
}));
const approveTimeRequest = async (req, res) => {
    const { id } = (0, validation_1.parseWithSchema)(paramsSchema, req.params, 'Invalid request id');
    const data = (0, validation_1.parseWithSchema)(approveSchema, req.body ?? {});
    const makeupCap = await (0, timeRequestPolicy_1.getMakeupCapHoursPerMonth)();
    const result = await prisma_1.prisma.$transaction(async (tx) => {
        const request = await tx.timeRequest.findUnique({
            where: { id },
            include: { user: true }
        });
        if (!request) {
            throw errors_1.HttpError.notFound('Time request not found');
        }
        if (request.status !== 'pending') {
            throw errors_1.HttpError.conflict('Time request already processed');
        }
        const effectiveHours = data.hours ?? request.hours;
        if (effectiveHours <= 0) {
            throw errors_1.HttpError.badRequest('Invalid hours value');
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
                    throw errors_1.HttpError.badRequest('Insufficient PTO balance');
                }
                updatedBalance = await tx.ptoBalance.update({
                    where: { id: balance.id },
                    data: {
                        ptoHours: balance.ptoHours - effectiveHours
                    }
                });
                await (0, balances_1.recordLedgerEntry)({
                    userId: request.userId,
                    deltaHours: -effectiveHours,
                    reason: `PTO request ${request.id} approved`,
                    createdById: req.user.id
                }, tx);
                break;
            }
            case 'non_pto': {
                const shouldDecrement = balance.baseNonPtoHours > 0;
                updatedBalance = shouldDecrement
                    ? await tx.ptoBalance.update({
                        where: { id: balance.id },
                        data: {
                            nonPtoHours: Math.max(balance.nonPtoHours - effectiveHours, 0)
                        }
                    })
                    : balance;
                break;
            }
            case 'make_up': {
                const approvedThisMonth = await (0, timeRequestPolicy_1.getApprovedMakeupHoursThisMonth)(tx, request.userId);
                if ((0, timeRequestPolicy_1.exceedsMonthlyCap)(approvedThisMonth, effectiveHours, makeupCap)) {
                    const remaining = (0, timeRequestPolicy_1.remainingHoursWithinCap)(approvedThisMonth, makeupCap);
                    throw errors_1.HttpError.badRequest(buildCapExceededMessage(makeupCap, approvedThisMonth, remaining));
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
                throw errors_1.HttpError.badRequest('Unsupported request type');
        }
        const updatedRequest = await tx.timeRequest.update({
            where: { id },
            data: {
                status: 'approved',
                hours: effectiveHours,
                approverId: req.user.id,
                approvedAt: new Date()
            }
        });
        return { updatedRequest, updatedBalance };
    });
    return res.json(result);
};
exports.approveTimeRequest = approveTimeRequest;
timeRequestsRouter.post('/:id/approve', auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(exports.approveTimeRequest));
const denyTimeRequest = async (req, res) => {
    const { id } = (0, validation_1.parseWithSchema)(paramsSchema, req.params, 'Invalid request id');
    const request = await prisma_1.prisma.timeRequest.findUnique({ where: { id } });
    if (!request) {
        throw errors_1.HttpError.notFound('Time request not found');
    }
    if (request.status !== 'pending') {
        throw errors_1.HttpError.conflict('Time request already processed');
    }
    const updated = await prisma_1.prisma.timeRequest.update({
        where: { id },
        data: {
            status: 'denied',
            approverId: req.user.id,
            approvedAt: new Date()
        }
    });
    return res.json({ request: updated });
};
exports.denyTimeRequest = denyTimeRequest;
timeRequestsRouter.post('/:id/deny', auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(exports.denyTimeRequest));

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.balancesRouter = exports.getUserBalance = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const balances_1 = require("../services/balances");
const accruals_1 = require("../services/accruals");
const date_fns_1 = require("date-fns");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const errors_1 = require("../errors");
const balancesRouter = (0, express_1.Router)();
exports.balancesRouter = balancesRouter;
const userIdParamSchema = zod_1.z.object({ userId: zod_1.z.coerce.number().int().positive() });
const getUserBalance = async (req, res) => {
    const { userId } = (0, validation_1.parseWithSchema)(userIdParamSchema, req.params, 'Invalid user id');
    const requester = req.user;
    if (requester.role === 'employee' && requester.id !== userId) {
        throw errors_1.HttpError.forbidden();
    }
    const overview = await (0, balances_1.getBalanceOverview)(userId, { limit: 200 });
    return res.json(overview);
};
exports.getUserBalance = getUserBalance;
balancesRouter.get('/:userId', auth_1.authenticate, (0, asyncHandler_1.asyncHandler)(exports.getUserBalance));
const adjustmentSchema = zod_1.z.object({
    deltaHours: zod_1.z
        .number()
        .finite()
        .refine((value) => value !== 0 && Math.abs(value) <= 1000, 'Delta hours must be between -1000 and 1000 and non-zero')
        .transform((value) => Math.round(value * 100) / 100),
    reason: zod_1.z
        .string()
        .trim()
        .min(1, 'Reason is required')
        .max(500, 'Reason must be 500 characters or fewer')
});
balancesRouter.post('/:userId/adjust', auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { userId } = (0, validation_1.parseWithSchema)(userIdParamSchema, req.params, 'Invalid user id');
    const { deltaHours, reason } = (0, validation_1.parseWithSchema)(adjustmentSchema, req.body, 'Invalid adjustment payload');
    const actorId = req.user.id;
    const result = await (0, balances_1.adjustPtoBalance)({
        userId,
        deltaHours,
        reason,
        createdById: actorId
    });
    const overview = await (0, balances_1.getBalanceOverview)(userId, { limit: 200 });
    return res.status(201).json({ ...overview, entry: result.entry });
}));
balancesRouter.post('/recalc', auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const querySchema = zod_1.z.object({ userId: zod_1.z.coerce.number().int().positive() });
    const { userId } = (0, validation_1.parseWithSchema)(querySchema, req.query, 'Invalid query');
    const balance = await (0, balances_1.recalcBalance)(userId);
    return res.json({ balance });
}));
balancesRouter.post('/accrue', auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const querySchema = zod_1.z.object({ userId: zod_1.z.coerce.number().int().positive().optional() });
    const { userId } = (0, validation_1.parseWithSchema)(querySchema, req.query, 'Invalid query');
    const now = new Date();
    const results = await (0, accruals_1.applyMonthlyAccrual)(now, userId);
    const applied = results.filter((r) => r.applied).length;
    return res.json({ month: (0, date_fns_1.format)(now, 'yyyy-MM'), applied, results });
}));

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
const prisma_1 = require("../prisma");
const client_1 = require("@prisma/client");
const timeRequestPolicy_1 = require("../services/timeRequestPolicy");
const config_1 = require("../services/config");
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
const setBalancesSchema = zod_1.z
    .object({
    ptoHours: zod_1.z.number().finite().optional(),
    ptoBaseHours: zod_1.z.number().finite().optional(),
    utoHours: zod_1.z.number().finite().optional(),
    utoBaseHours: zod_1.z.number().finite().optional(),
    makeUpHours: zod_1.z.number().finite().optional(),
    ptoAccrualHours: zod_1.z.number().finite().min(0).max(1000).optional(),
    utoAccrualHours: zod_1.z.number().finite().min(0).max(1000).optional(),
    makeUpCapHours: zod_1.z.number().finite().min(0).max(1000).optional(),
    reason: zod_1.z.string().trim().max(500).optional()
})
    .refine((data) => [
    data.ptoHours,
    data.utoHours,
    data.makeUpHours,
    data.ptoAccrualHours,
    data.utoAccrualHours,
    data.ptoBaseHours,
    data.utoBaseHours,
    data.makeUpCapHours
].some((value) => value !== undefined), {
    message: 'Provide at least one balance or accrual value to update.'
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
balancesRouter.post('/:userId/set', auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']), (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { userId } = (0, validation_1.parseWithSchema)(userIdParamSchema, req.params, 'Invalid user id');
    const payload = (0, validation_1.parseWithSchema)(setBalancesSchema, req.body, 'Invalid balance payload');
    const actorId = req.user.id;
    const now = new Date();
    const latestConfig = await prisma_1.prisma.employeeCompConfig.findFirst({
        where: { userId, effectiveOn: { lte: now } },
        orderBy: { effectiveOn: 'desc' }
    });
    const reasonText = payload.reason && payload.reason.trim().length
        ? payload.reason.trim()
        : 'Balances tab update';
    await (0, balances_1.syncTimeOffBalances)({
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
        const updateData = {};
        if (payload.ptoHours !== undefined) {
            updateData.ptoBalanceHours = new client_1.Prisma.Decimal(payload.ptoHours);
        }
        if (payload.utoHours !== undefined) {
            updateData.utoBalanceHours = new client_1.Prisma.Decimal(payload.utoHours);
        }
        if (Object.keys(updateData).length > 0) {
            await prisma_1.prisma.employeeCompConfig.update({ where: { id: latestConfig.id }, data: updateData });
        }
    }
    await (0, accruals_1.setUserAccrualRule)({
        userId,
        ptoHoursPerMonth: payload.ptoAccrualHours,
        utoHoursPerMonth: payload.utoAccrualHours,
        actorId
    });
    if (payload.makeUpCapHours !== undefined) {
        await (0, config_1.setConfigValue)(timeRequestPolicy_1.MAKEUP_CAP_CONFIG_KEY, payload.makeUpCapHours.toString());
    }
    const overview = await (0, balances_1.getBalanceOverview)(userId, { limit: 200 });
    const userRule = await prisma_1.prisma.accrualRule.findUnique({ where: { userId } });
    const defaultRule = await prisma_1.prisma.accrualRule.findFirst({ where: { isDefault: true } });
    const makeupCap = await (0, timeRequestPolicy_1.getMakeupCapHoursPerMonth)();
    const resolveAccrual = (extract) => {
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

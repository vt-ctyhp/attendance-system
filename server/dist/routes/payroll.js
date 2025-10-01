"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.payrollRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const date_fns_tz_1 = require("date-fns-tz");
const auth_1 = require("../auth");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const config_1 = require("../services/payroll/config");
const attendance_1 = require("../services/payroll/attendance");
const bonuses_1 = require("../services/payroll/bonuses");
const payroll_1 = require("../services/payroll/payroll");
const constants_1 = require("../services/payroll/constants");
const payrollRouter = (0, express_1.Router)();
exports.payrollRouter = payrollRouter;
payrollRouter.use(auth_1.authenticate, (0, auth_1.requireRole)(['admin']));
const scheduleDaySchema = zod_1.z.object({
    enabled: zod_1.z.boolean().optional().default(false),
    start: zod_1.z.string().default('09:00'),
    end: zod_1.z.string().default('17:00'),
    expectedHours: zod_1.z.number().finite().nonnegative().default(8)
});
const scheduleSchema = zod_1.z.record(scheduleDaySchema).default({});
const datePreprocess = zod_1.z.preprocess((value) => {
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
const employeeConfigSchema = zod_1.z.object({
    userId: zod_1.z.number().int().positive(),
    effectiveOn: datePreprocess,
    baseSemiMonthlySalary: zod_1.z.number().finite(),
    monthlyAttendanceBonus: zod_1.z.number().finite(),
    quarterlyAttendanceBonus: zod_1.z.number().finite(),
    kpiEligible: zod_1.z.boolean(),
    defaultKpiBonus: zod_1.z.number().finite().nullable().optional(),
    schedule: scheduleSchema,
    accrualEnabled: zod_1.z.boolean(),
    accrualMethod: zod_1.z.string().max(100).optional().nullable(),
    ptoBalanceHours: zod_1.z.number().finite(),
    nonPtoBalanceHours: zod_1.z.number().finite()
});
payrollRouter.get('/config', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const querySchema = zod_1.z.object({ userId: zod_1.z.coerce.number().int().positive().optional() });
    const { userId } = (0, validation_1.parseWithSchema)(querySchema, req.query, 'Invalid query');
    const configs = await (0, config_1.listEmployeeConfigs)(userId);
    res.json({ configs });
}));
payrollRouter.post('/config', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const input = (0, validation_1.parseWithSchema)(employeeConfigSchema, req.body, 'Invalid configuration payload');
    await (0, config_1.upsertEmployeeConfig)({
        userId: input.userId,
        effectiveOn: input.effectiveOn,
        baseSemiMonthlySalary: input.baseSemiMonthlySalary,
        monthlyAttendanceBonus: input.monthlyAttendanceBonus,
        quarterlyAttendanceBonus: input.quarterlyAttendanceBonus,
        kpiEligible: input.kpiEligible,
        defaultKpiBonus: input.defaultKpiBonus,
        schedule: input.schedule,
        accrualEnabled: input.accrualEnabled,
        accrualMethod: input.accrualMethod,
        ptoBalanceHours: input.ptoBalanceHours,
        nonPtoBalanceHours: input.nonPtoBalanceHours
    }, req.user?.id);
    res.status(201).json({ success: true });
}));
const holidayQuerySchema = zod_1.z.object({
    from: datePreprocess.optional(),
    to: datePreprocess.optional()
});
payrollRouter.get('/holidays', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { from, to } = (0, validation_1.parseWithSchema)(holidayQuerySchema, req.query, 'Invalid query');
    const now = new Date();
    const start = from ?? now;
    const end = to ?? new Date(now.getFullYear(), now.getMonth() + 6, now.getDate());
    const holidays = await (0, config_1.listHolidays)(start, end);
    res.json({ holidays });
}));
const holidayBodySchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    observedOn: datePreprocess
});
payrollRouter.post('/holidays', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { name, observedOn } = (0, validation_1.parseWithSchema)(holidayBodySchema, req.body, 'Invalid holiday payload');
    const holiday = await (0, config_1.createHoliday)(name, observedOn, req.user?.id);
    res.status(201).json({ holiday });
}));
payrollRouter.delete('/holidays/:date', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const paramsSchema = zod_1.z.object({ date: zod_1.z.string().min(1) });
    const { date } = (0, validation_1.parseWithSchema)(paramsSchema, req.params, 'Invalid holiday identifier');
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
    }
    const removed = await (0, config_1.deleteHoliday)(parsed, req.user?.id);
    res.json({ removed });
}));
const monthParamSchema = zod_1.z.object({ month: zod_1.z.string().regex(/^\d{4}-\d{2}$/) });
payrollRouter.post('/attendance/:month/recalc', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { month } = (0, validation_1.parseWithSchema)(monthParamSchema, req.params, 'Invalid month');
    const facts = await (0, attendance_1.recalcMonthlyAttendanceFacts)(month, req.user?.id);
    await (0, bonuses_1.recalcMonthlyBonuses)(month, req.user?.id ?? undefined);
    res.status(202).json({ month, count: facts.length });
}));
payrollRouter.get('/attendance/:month', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { month } = (0, validation_1.parseWithSchema)(monthParamSchema, req.params, 'Invalid month');
    const data = await (0, attendance_1.listAttendanceFactsForMonth)(month);
    res.json(data);
}));
const dateParamSchema = zod_1.z.object({ payDate: zod_1.z.string().min(1) });
const parsePayDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('Invalid pay date');
    }
    const parsed = (0, date_fns_tz_1.zonedTimeToUtc)(`${value}T00:00:00`, constants_1.PAYROLL_TIME_ZONE);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error('Invalid pay date');
    }
    return parsed;
};
payrollRouter.post('/payruns/:payDate/recalc', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate: payDateRaw } = (0, validation_1.parseWithSchema)(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await (0, payroll_1.recalcPayrollForPayDate)(payDate, req.user?.id);
    res.status(202).json({ period });
}));
payrollRouter.get('/payruns/:payDate', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate: payDateRaw } = (0, validation_1.parseWithSchema)(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await (0, payroll_1.getPayrollPeriod)(payDate);
    res.json({ period });
}));
payrollRouter.post('/payruns/:payDate/approve', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate: payDateRaw } = (0, validation_1.parseWithSchema)(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await (0, payroll_1.approvePayrollPeriod)(payDate, req.user.id);
    res.json({ period });
}));
payrollRouter.post('/payruns/:payDate/pay', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate: payDateRaw } = (0, validation_1.parseWithSchema)(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await (0, payroll_1.markPayrollPaid)(payDate, req.user.id);
    res.json({ period });
}));
payrollRouter.get('/payruns/:payDate/export', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate: payDateRaw } = (0, validation_1.parseWithSchema)(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const csv = await (0, payroll_1.exportPayrollCsv)(payDate);
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
}));
const bonusQuerySchema = zod_1.z.object({ payDate: datePreprocess });
payrollRouter.get('/bonuses', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate } = (0, validation_1.parseWithSchema)(bonusQuerySchema, req.query, 'Invalid query');
    const bonuses = await (0, bonuses_1.listBonusesForPayDate)(payDate);
    res.json({ bonuses });
}));
const kpiDecisionSchema = zod_1.z.object({
    status: zod_1.z.enum(['approved', 'denied']),
    finalAmount: zod_1.z.number().finite().optional(),
    notes: zod_1.z.string().max(500).optional()
});
const idParamSchema = zod_1.z.object({ id: zod_1.z.coerce.number().int().positive() });
payrollRouter.post('/kpi/:id/decision', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = (0, validation_1.parseWithSchema)(idParamSchema, req.params, 'Invalid KPI identifier');
    const { status, finalAmount, notes } = (0, validation_1.parseWithSchema)(kpiDecisionSchema, req.body, 'Invalid decision payload');
    const candidate = await (0, bonuses_1.updateKpiBonusStatus)(id, status, req.user.id, finalAmount, notes);
    res.json({ candidate });
}));

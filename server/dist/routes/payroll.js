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
const shiftPlanner_1 = require("../services/shiftPlanner");
const balances_1 = require("../services/balances");
const payrollRouter = (0, express_1.Router)();
exports.payrollRouter = payrollRouter;
const allowAnonDashboard = process.env.DASHBOARD_ALLOW_ANON === 'true';
if (!allowAnonDashboard) {
    payrollRouter.use(auth_1.authenticate);
}
const allowRoles = (roles) => {
    if (allowAnonDashboard) {
        return (_req, _res, next) => next();
    }
    return (0, auth_1.requireRole)(roles);
};
const requireAdmin = allowRoles(['admin']);
const requireAdminOrManager = allowRoles(['admin', 'manager']);
const scheduleDaySchema = zod_1.z.object({
    enabled: zod_1.z.boolean().optional().default(false),
    start: zod_1.z.string().optional().default('09:00'),
    end: zod_1.z.string().optional().default('17:00'),
    expectedHours: zod_1.z.number().finite().nonnegative().optional(),
    breakMinutes: zod_1.z.number().finite().nonnegative().optional(),
    unpaidBreakMinutes: zod_1.z.number().finite().nonnegative().optional()
});
const scheduleSchema = zod_1.z
    .object({
    timeZone: zod_1.z.string().min(1),
    days: zod_1.z.record(scheduleDaySchema)
})
    .or(zod_1.z.record(scheduleDaySchema))
    .default({});
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
    utoBalanceHours: zod_1.z.number().finite(),
    makeupBalanceHours: zod_1.z.number().finite().optional()
});
payrollRouter.get('/config', requireAdminOrManager, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const querySchema = zod_1.z.object({ userId: zod_1.z.coerce.number().int().positive().optional() });
    const { userId } = (0, validation_1.parseWithSchema)(querySchema, req.query, 'Invalid query');
    const configs = await (0, config_1.listEmployeeConfigs)(userId);
    res.json({ configs });
}));
payrollRouter.post('/config', requireAdminOrManager, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const input = (0, validation_1.parseWithSchema)(employeeConfigSchema, req.body, 'Invalid configuration payload');
    const { makeupBalanceHours, schedule, ...rest } = input;
    await (0, config_1.upsertEmployeeConfig)({
        ...rest,
        schedule: (0, config_1.ensureSchedule)(schedule)
    }, req.user?.id);
    await (0, balances_1.syncTimeOffBalances)({
        userId: rest.userId,
        actorId: req.user?.id,
        ptoHours: rest.ptoBalanceHours,
        utoHours: rest.utoBalanceHours,
        makeUpHours: makeupBalanceHours,
        accrualEnabled: rest.accrualEnabled
    });
    res.status(201).json({ success: true });
}));
const holidayQuerySchema = zod_1.z.object({
    from: datePreprocess.optional(),
    to: datePreprocess.optional()
});
payrollRouter.get('/holidays', requireAdmin, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
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
payrollRouter.post('/holidays', requireAdmin, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { name, observedOn } = (0, validation_1.parseWithSchema)(holidayBodySchema, req.body, 'Invalid holiday payload');
    const holiday = await (0, config_1.createHoliday)(name, observedOn, req.user?.id);
    res.status(201).json({ holiday });
}));
payrollRouter.delete('/holidays/:date', requireAdmin, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
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
payrollRouter.post('/attendance/:month/recalc', requireAdmin, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { month } = (0, validation_1.parseWithSchema)(monthParamSchema, req.params, 'Invalid month');
    const facts = await (0, attendance_1.recalcMonthlyAttendanceFacts)(month, req.user?.id);
    await (0, bonuses_1.recalcMonthlyBonuses)(month, req.user?.id ?? undefined);
    res.status(202).json({ month, count: facts.length });
}));
payrollRouter.get('/attendance/:month', requireAdmin, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
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
payrollRouter.post('/payruns/:payDate/recalc', requireAdmin, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate: payDateRaw } = (0, validation_1.parseWithSchema)(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await (0, payroll_1.recalcPayrollForPayDate)(payDate, req.user?.id);
    res.status(202).json({ period });
}));
payrollRouter.get('/payruns/:payDate', requireAdmin, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { payDate: payDateRaw } = (0, validation_1.parseWithSchema)(dateParamSchema, req.params, 'Invalid pay date');
    const payDate = parsePayDate(payDateRaw);
    const period = await (0, payroll_1.getPayrollPeriod)(payDate);
    res.json({ period });
}));
payrollRouter.post('/shifts/rebuild', requireAdminOrManager, (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const summary = await (0, shiftPlanner_1.ensureUpcomingShiftsForAllUsers)();
    res.status(202).json({ success: true, summary });
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

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminSettingsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const prisma_1 = require("../prisma");
const featureFlags_1 = require("../services/featureFlags");
const errors_1 = require("../errors");
const router = (0, express_1.Router)();
exports.adminSettingsRouter = router;
router.use(auth_1.authenticate, (0, auth_1.requireRole)(['admin', 'manager']));
router.get('/feature-flags/start-session-email', (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const enabled = await (0, featureFlags_1.isEmailSessionEnabled)();
    res.json({ enabled });
}));
const flagSchema = zod_1.z.object({
    enabled: zod_1.z
        .union([zod_1.z.boolean(), zod_1.z.string()])
        .transform((value) => {
        if (typeof value === 'boolean')
            return value;
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'on', 'yes'].includes(normalized))
            return true;
        if (['0', 'false', 'off', 'no'].includes(normalized))
            return false;
        return false;
    })
});
router.post('/feature-flags/start-session-email', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { enabled } = (0, validation_1.parseWithSchema)(flagSchema, req.body, 'Invalid flag payload');
    await (0, featureFlags_1.setEmailSessionEnabled)(Boolean(enabled));
    res.json({ enabled: Boolean(enabled) });
}));
router.get('/employees', (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const employees = await prisma_1.prisma.user.findMany({
        where: { role: 'employee' },
        select: { id: true, email: true, name: true, active: true, createdAt: true }
    });
    res.json({ employees });
}));
const updateEmployeeSchema = zod_1.z.object({
    active: zod_1.z
        .union([zod_1.z.boolean(), zod_1.z.string()])
        .transform((value) => {
        if (typeof value === 'boolean')
            return value;
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'on', 'yes'].includes(normalized))
            return true;
        if (['0', 'false', 'off', 'no'].includes(normalized))
            return false;
        return false;
    })
});
router.post('/employees/:id/active', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const employeeId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(employeeId) || employeeId <= 0) {
        throw errors_1.HttpError.badRequest('Invalid employee id');
    }
    const { active } = (0, validation_1.parseWithSchema)(updateEmployeeSchema, req.body, 'Invalid update payload');
    const employee = await prisma_1.prisma.user.findUnique({ where: { id: employeeId } });
    if (!employee || employee.role !== 'employee') {
        throw errors_1.HttpError.notFound('Employee not found');
    }
    await prisma_1.prisma.user.update({ where: { id: employeeId }, data: { active: Boolean(active) } });
    res.json({ id: employeeId, active: Boolean(active) });
}));
router.get('/audit/email-sessions', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const limitValue = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const take = Number.isFinite(limitValue) && limitValue > 0 && limitValue <= 500 ? limitValue : 100;
    const logs = await prisma_1.prisma.authAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: {
            id: true,
            email: true,
            userId: true,
            event: true,
            success: true,
            reason: true,
            ipAddress: true,
            userAgent: true,
            deviceId: true,
            createdAt: true
        }
    });
    res.json({ logs });
}));

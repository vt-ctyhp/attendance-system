import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, type AuthenticatedRequest } from '../auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { prisma } from '../prisma';
import { isEmailSessionEnabled, setEmailSessionEnabled } from '../services/featureFlags';
import { HttpError } from '../errors';

const router = Router();

router.use(authenticate, requireRole(['admin', 'manager']));

router.get(
  '/feature-flags/start-session-email',
  asyncHandler(async (_req, res) => {
    const enabled = await isEmailSessionEnabled();
    res.json({ enabled });
  })
);

const flagSchema = z.object({
  enabled: z
    .union([z.boolean(), z.string()])
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
      if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
      return false;
    })
});

router.post(
  '/feature-flags/start-session-email',
  asyncHandler(async (req, res) => {
    const { enabled } = parseWithSchema(flagSchema, req.body, 'Invalid flag payload');
    await setEmailSessionEnabled(Boolean(enabled));
    res.json({ enabled: Boolean(enabled) });
  })
);

router.get(
  '/employees',
  asyncHandler(async (_req, res) => {
    const employees = await prisma.user.findMany({
      where: { role: 'employee' },
      select: { id: true, email: true, name: true, active: true, createdAt: true }
    });
    res.json({ employees });
  })
);

const updateEmployeeSchema = z.object({
  active: z
    .union([z.boolean(), z.string()])
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
      if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
      return false;
    })
});

router.post(
  '/employees/:id/active',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const employeeId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      throw HttpError.badRequest('Invalid employee id');
    }

    const { active } = parseWithSchema(updateEmployeeSchema, req.body, 'Invalid update payload');

    const employee = await prisma.user.findUnique({ where: { id: employeeId } });
    if (!employee || employee.role !== 'employee') {
      throw HttpError.notFound('Employee not found');
    }

    await prisma.user.update({ where: { id: employeeId }, data: { active: Boolean(active) } });
    res.json({ id: employeeId, active: Boolean(active) });
  })
);

router.get(
  '/audit/email-sessions',
  asyncHandler(async (req, res) => {
    const limitValue = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const take = Number.isFinite(limitValue) && limitValue > 0 && limitValue <= 500 ? limitValue : 100;
    const logs = await prisma.authAuditLog.findMany({
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
  })
);

export { router as adminSettingsRouter };

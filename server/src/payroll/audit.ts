import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import type { PayrollAuditEvent } from './types';

export interface PayrollAuditOptions {
  actorId?: number | null;
  entityType: string;
  entityId: string;
  event: PayrollAuditEvent;
  payload?: Prisma.JsonValue;
}

export const recordPayrollAudit = async ({
  actorId,
  entityType,
  entityId,
  event,
  payload
}: PayrollAuditOptions): Promise<void> => {
  await prisma.payrollAuditLog.create({
    data: {
      actorId: actorId ?? null,
      entityType,
      entityId,
      event,
      payload: payload ?? Prisma.JsonNull
    }
  });
};

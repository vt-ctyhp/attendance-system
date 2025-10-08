import type { BalanceLedger, Prisma, PrismaClient, PtoBalance } from '@prisma/client';
import { prisma } from '../prisma';

type BalanceClient = Prisma.TransactionClient | PrismaClient;

const resolveClient = (client?: BalanceClient): BalanceClient => client ?? prisma;

export const ensureBalance = async (userId: number, client?: BalanceClient) =>
  resolveClient(client).ptoBalance.upsert({
    where: { userId },
    update: {},
    create: { userId }
  });

export const recalcBalance = async (userId: number, client?: BalanceClient) => {
  const db = resolveClient(client);
  const balance = await ensureBalance(userId, db);

  const approved = await db.timeRequest.findMany({
    where: {
      userId,
      status: 'approved'
    },
    select: {
      type: true,
      hours: true
    }
  });

  const totals = approved.reduce(
    (acc, { type, hours }) => {
      switch (type) {
        case 'pto':
          acc.pto += hours;
          break;
        case 'uto':
          acc.uto += hours;
          break;
        case 'make_up':
          acc.makeUp += hours;
          break;
        default:
          break;
      }
      return acc;
    },
    { pto: 0, uto: 0, makeUp: 0 }
  );

  return db.ptoBalance.update({
    where: { id: balance.id },
    data: {
      ptoHours: balance.basePtoHours - totals.pto,
      utoHours: Math.max(balance.baseUtoHours - totals.uto, 0),
      makeUpHours: balance.baseMakeUpHours + totals.makeUp
    }
  });
};

export interface LedgerEntryWithActor extends BalanceLedger {
  createdBy?: {
    id: number;
    name: string;
    email: string;
  } | null;
}

export const getBalanceOverview = async (
  userId: number,
  options?: { limit?: number },
  client?: BalanceClient
): Promise<{ balance: PtoBalance; ledger: LedgerEntryWithActor[] }> => {
  const db = resolveClient(client);
  const balance = await ensureBalance(userId, db);
  const ledger = await db.balanceLedger.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: options?.limit,
    include: {
      createdBy: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });

  return { balance, ledger };
};

interface LedgerEntryInput {
  userId: number;
  deltaHours: number;
  reason: string;
  createdById: number;
  type?: string;
}

export const adjustPtoBalance = async ({
  userId,
  deltaHours,
  reason,
  createdById,
  type
}: LedgerEntryInput): Promise<{ balance: PtoBalance; entry: LedgerEntryWithActor }> => {
  return prisma.$transaction(async (tx) => {
    const balance = await ensureBalance(userId, tx);
    const updated = await tx.ptoBalance.update({
      where: { id: balance.id },
      data: {
        basePtoHours: balance.basePtoHours + deltaHours,
        ptoHours: balance.ptoHours + deltaHours
      }
    });

    const entry = await tx.balanceLedger.create({
      data: {
        userId,
        deltaHours,
        reason,
        createdById,
        type: type ?? 'pto'
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    return { balance: updated, entry };
  });
};

export const recordLedgerEntry = async (
  {
    userId,
    deltaHours,
    reason,
    createdById,
    type
  }: Partial<LedgerEntryInput> & { userId: number; deltaHours: number },
  client?: BalanceClient
): Promise<LedgerEntryWithActor> => {
  const db = resolveClient(client);
  return db.balanceLedger.create({
    data: {
      userId,
      deltaHours,
      reason,
      createdById,
      type: type ?? 'pto'
    },
    include: {
      createdBy: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });
};

export const syncTimeOffBalances = async (
  {
    userId,
    actorId,
    ptoHours,
    ptoBaseHours,
    utoHours,
    utoBaseHours,
    makeUpHours,
    accrualEnabled,
    reason
  }: {
    userId: number;
    actorId?: number | null;
    ptoHours?: number;
    ptoBaseHours?: number;
    utoHours?: number;
    utoBaseHours?: number;
    makeUpHours?: number | null;
    accrualEnabled: boolean;
    reason?: string;
  }
) => {
  const roundup = (value: number) => Math.round(value * 100) / 100;
  const entryReason = reason ?? 'Compensation baseline sync';

  await prisma.$transaction(async (tx) => {
    const balance = await ensureBalance(userId, tx);
    const state = {
      ptoHours: Number(balance.ptoHours),
      basePtoHours: Number(balance.basePtoHours),
      utoHours: Number(balance.utoHours),
      baseUtoHours: Number(balance.baseUtoHours),
      makeUpHours: Number(balance.makeUpHours),
      baseMakeUpHours: Number(balance.baseMakeUpHours ?? 0)
    };

    const updates: Prisma.PtoBalanceUpdateInput = {};

    const syncBucket = async (
      target: number | undefined | null,
      currentKey: keyof typeof state,
      baseKey: keyof typeof state,
      updateCurrent: keyof Prisma.PtoBalanceUpdateInput,
      updateBase: keyof Prisma.PtoBalanceUpdateInput,
      type: string,
      options?: { updateBase?: boolean }
    ) => {
      if (target === undefined || target === null) {
        return;
      }
      const roundedTarget = roundup(target);
      const currentValue = state[currentKey];
      const diff = roundup(roundedTarget - currentValue);
      if (Math.abs(diff) >= 0.001) {
        updates[updateCurrent] = roundedTarget;
        state[currentKey] = roundedTarget;
        if (options?.updateBase ?? true) {
          updates[updateBase] = roundedTarget;
          state[baseKey] = roundedTarget;
        }
        await recordLedgerEntry(
          {
            userId,
            deltaHours: diff,
            reason: entryReason,
            createdById: actorId ?? undefined,
            type
          },
          tx
        );
      } else if (state[baseKey] !== roundedTarget) {
        if (options?.updateBase ?? true) {
          updates[updateBase] = roundedTarget;
          state[baseKey] = roundedTarget;
        }
      }
    };

    const adjustBucket = async (
      options: {
        targetRemaining?: number | null;
        targetBase?: number | null;
        currentKey: keyof typeof state;
        baseKey: keyof typeof state;
        updateCurrent: keyof Prisma.PtoBalanceUpdateInput;
        updateBase: keyof Prisma.PtoBalanceUpdateInput;
        ledgerType: string;
      }
    ) => {
      const { targetRemaining, targetBase, currentKey, baseKey, updateCurrent, updateBase, ledgerType } = options;
      let remainingTarget = targetRemaining ?? undefined;
      const baseTarget = targetBase ?? undefined;

      if (baseTarget !== undefined) {
        const roundedBase = roundup(baseTarget);
        const currentBase = state[baseKey];
        if (Math.abs(roundedBase - currentBase) >= 0.001) {
          updates[updateBase] = roundedBase;
          state[baseKey] = roundedBase;
          if (remainingTarget === undefined) {
            const used = currentBase - state[currentKey];
            remainingTarget = Math.max(0, roundedBase - used);
          }
        }
      }

      await syncBucket(remainingTarget, currentKey, baseKey, updateCurrent, updateBase, ledgerType, {
        updateBase: false
      });
    };

    await adjustBucket({
      targetRemaining: ptoHours,
      targetBase: ptoBaseHours,
      currentKey: 'ptoHours',
      baseKey: 'basePtoHours',
      updateCurrent: 'ptoHours',
      updateBase: 'basePtoHours',
      ledgerType: accrualEnabled ? 'pto_balance_sync' : 'pto_balance_sync'
    });

    await adjustBucket({
      targetRemaining: utoHours,
      targetBase: utoBaseHours,
      currentKey: 'utoHours',
      baseKey: 'baseUtoHours',
      updateCurrent: 'utoHours',
      updateBase: 'baseUtoHours',
      ledgerType: accrualEnabled ? 'uto_balance_sync' : 'uto_balance_sync'
    });

    await syncBucket(
      makeUpHours,
      'makeUpHours',
      'baseMakeUpHours',
      'makeUpHours',
      'baseMakeUpHours',
      accrualEnabled ? 'make_up_balance_sync' : 'make_up_balance_sync',
      { updateBase: true }
    );

    if (Object.keys(updates).length > 0) {
      await tx.ptoBalance.update({
        where: { id: balance.id },
        data: updates
      });
    }
  });
};

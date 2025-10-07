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

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordLedgerEntry = exports.adjustPtoBalance = exports.getBalanceOverview = exports.recalcBalance = exports.ensureBalance = void 0;
const prisma_1 = require("../prisma");
const resolveClient = (client) => client ?? prisma_1.prisma;
const ensureBalance = async (userId, client) => resolveClient(client).ptoBalance.upsert({
    where: { userId },
    update: {},
    create: { userId }
});
exports.ensureBalance = ensureBalance;
const recalcBalance = async (userId, client) => {
    const db = resolveClient(client);
    const balance = await (0, exports.ensureBalance)(userId, db);
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
    const totals = approved.reduce((acc, { type, hours }) => {
        switch (type) {
            case 'pto':
                acc.pto += hours;
                break;
            case 'non_pto':
                acc.nonPto += hours;
                break;
            case 'make_up':
                acc.makeUp += hours;
                break;
            default:
                break;
        }
        return acc;
    }, { pto: 0, nonPto: 0, makeUp: 0 });
    return db.ptoBalance.update({
        where: { id: balance.id },
        data: {
            ptoHours: balance.basePtoHours - totals.pto,
            nonPtoHours: Math.max(balance.baseNonPtoHours - totals.nonPto, 0),
            makeUpHours: balance.baseMakeUpHours + totals.makeUp
        }
    });
};
exports.recalcBalance = recalcBalance;
const getBalanceOverview = async (userId, options, client) => {
    const db = resolveClient(client);
    const balance = await (0, exports.ensureBalance)(userId, db);
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
exports.getBalanceOverview = getBalanceOverview;
const adjustPtoBalance = async ({ userId, deltaHours, reason, createdById, type }) => {
    return prisma_1.prisma.$transaction(async (tx) => {
        const balance = await (0, exports.ensureBalance)(userId, tx);
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
exports.adjustPtoBalance = adjustPtoBalance;
const recordLedgerEntry = async ({ userId, deltaHours, reason, createdById, type }, client) => {
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
exports.recordLedgerEntry = recordLedgerEntry;

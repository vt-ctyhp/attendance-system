"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncTimeOffBalances = exports.recordLedgerEntry = exports.adjustPtoBalance = exports.getBalanceOverview = exports.recalcBalance = exports.ensureBalance = void 0;
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
    }, { pto: 0, uto: 0, makeUp: 0 });
    return db.ptoBalance.update({
        where: { id: balance.id },
        data: {
            ptoHours: balance.basePtoHours - totals.pto,
            utoHours: Math.max(balance.baseUtoHours - totals.uto, 0),
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
const syncTimeOffBalances = async ({ userId, actorId, ptoHours, utoHours, makeUpHours, accrualEnabled }) => {
    const roundup = (value) => Math.round(value * 100) / 100;
    const reason = 'Compensation baseline sync';
    await prisma_1.prisma.$transaction(async (tx) => {
        const balance = await (0, exports.ensureBalance)(userId, tx);
        const state = {
            ptoHours: Number(balance.ptoHours),
            basePtoHours: Number(balance.basePtoHours),
            utoHours: Number(balance.utoHours),
            baseUtoHours: Number(balance.baseUtoHours),
            makeUpHours: Number(balance.makeUpHours),
            baseMakeUpHours: Number(balance.baseMakeUpHours ?? 0)
        };
        const updates = {};
        const syncBucket = async (target, currentKey, baseKey, updateCurrent, updateBase, type) => {
            if (target === undefined || target === null) {
                return;
            }
            const roundedTarget = roundup(target);
            const currentValue = state[currentKey];
            const diff = roundup(roundedTarget - currentValue);
            if (Math.abs(diff) >= 0.001) {
                updates[updateCurrent] = roundedTarget;
                updates[updateBase] = roundedTarget;
                state[currentKey] = roundedTarget;
                state[baseKey] = roundedTarget;
                await (0, exports.recordLedgerEntry)({
                    userId,
                    deltaHours: diff,
                    reason,
                    createdById: actorId ?? undefined,
                    type
                }, tx);
            }
            else if (state[baseKey] !== roundedTarget) {
                updates[updateBase] = roundedTarget;
                state[baseKey] = roundedTarget;
            }
        };
        await syncBucket(ptoHours, 'ptoHours', 'basePtoHours', 'ptoHours', 'basePtoHours', accrualEnabled ? 'pto_compensation' : 'pto_compensation');
        await syncBucket(utoHours, 'utoHours', 'baseUtoHours', 'utoHours', 'baseUtoHours', accrualEnabled ? 'uto_compensation' : 'uto_compensation');
        await syncBucket(makeUpHours, 'makeUpHours', 'baseMakeUpHours', 'makeUpHours', 'baseMakeUpHours', accrualEnabled ? 'make_up_compensation' : 'make_up_compensation');
        if (Object.keys(updates).length > 0) {
            await tx.ptoBalance.update({
                where: { id: balance.id },
                data: updates
            });
        }
    });
};
exports.syncTimeOffBalances = syncTimeOffBalances;

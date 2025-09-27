"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = void 0;
const env_1 = require("./env");
const auth_1 = require("./auth");
const prisma_1 = require("./prisma");
const logger_1 = require("./logger");
const balances_1 = require("./services/balances");
const bootstrap = async () => {
    const existing = await prisma_1.prisma.user.findUnique({ where: { email: env_1.env.ADMIN_EMAIL } });
    if (!existing) {
        const passwordHash = await (0, auth_1.hashPassword)(env_1.env.ADMIN_PASSWORD);
        await prisma_1.prisma.user.create({
            data: {
                email: env_1.env.ADMIN_EMAIL,
                name: 'Administrator',
                role: 'admin',
                passwordHash,
                active: true
            }
        });
        logger_1.logger.info({ email: env_1.env.ADMIN_EMAIL }, 'Seeded admin user');
    }
    const usersWithoutBalance = await prisma_1.prisma.user.findMany({
        where: { balance: null },
        select: { id: true }
    });
    if (usersWithoutBalance.length) {
        for (const user of usersWithoutBalance) {
            await (0, balances_1.ensureBalance)(user.id);
        }
        logger_1.logger.info({ count: usersWithoutBalance.length }, 'Ensured PTO balances');
    }
    const defaultAccrual = await prisma_1.prisma.accrualRule.findFirst({ where: { isDefault: true } });
    if (!defaultAccrual) {
        await prisma_1.prisma.accrualRule.create({
            data: {
                isDefault: true,
                hoursPerMonth: 8
            }
        });
        logger_1.logger.info('Created default accrual rule (8 hours/month)');
    }
};
exports.bootstrap = bootstrap;

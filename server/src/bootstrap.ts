import { env } from './env';
import { hashPassword } from './auth';
import { prisma } from './prisma';
import { logger } from './logger';
import { ensureBalance } from './services/balances';

export const bootstrap = async () => {
  const existing = await prisma.user.findUnique({ where: { email: env.ADMIN_EMAIL } });
  if (!existing) {
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
    await prisma.user.create({
      data: {
        email: env.ADMIN_EMAIL,
        name: 'Administrator',
        role: 'admin',
        passwordHash,
        active: true
      }
    });
    logger.info({ email: env.ADMIN_EMAIL }, 'Seeded admin user');
  }

  const usersWithoutBalance = await prisma.user.findMany({
    where: { balance: null },
    select: { id: true }
  });

  if (usersWithoutBalance.length) {
    for (const user of usersWithoutBalance) {
      await ensureBalance(user.id);
    }
    logger.info({ count: usersWithoutBalance.length }, 'Ensured PTO balances');
  }

  const defaultAccrual = await prisma.accrualRule.findFirst({ where: { isDefault: true } });
  if (!defaultAccrual) {
    await prisma.accrualRule.create({
      data: {
        isDefault: true,
        hoursPerMonth: 8
      }
    });
    logger.info('Created default accrual rule (8 hours/month)');
  }
};

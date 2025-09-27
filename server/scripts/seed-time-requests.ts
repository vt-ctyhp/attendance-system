import { prisma } from '../src/prisma';
import { bootstrap } from '../src/bootstrap';
import { ensureBalance, recalcBalance } from '../src/services/balances';

const seed = async () => {
  await bootstrap();

  const users = await prisma.user.findMany({
    take: 3
  });

  if (!users.length) {
    throw new Error('No users available to seed time requests.');
  }

  const [firstUser] = users;

  await ensureBalance(firstUser.id);

  await prisma.timeRequest.deleteMany({ where: { userId: firstUser.id } });

  await prisma.timeRequest.createMany({
    data: [
      {
        userId: firstUser.id,
        type: 'pto',
        status: 'pending',
        startDate: new Date(),
        endDate: new Date(Date.now() + 2 * 60 * 60 * 1000),
        hours: 2,
        reason: 'Doctor appointment'
      },
      {
        userId: firstUser.id,
        type: 'make_up',
        status: 'approved',
        startDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        endDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000),
        hours: 4,
        approverId: firstUser.id,
        approvedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000)
      },
      {
        userId: firstUser.id,
        type: 'non_pto',
        status: 'denied',
        startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        endDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000),
        hours: 8,
        approverId: firstUser.id,
        approvedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000)
      }
    ],
    skipDuplicates: true
  });

  await recalcBalance(firstUser.id);

  await prisma.$disconnect();
};

seed()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log('Seeded sample time requests');
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });

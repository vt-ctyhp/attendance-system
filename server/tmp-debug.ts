import { prisma } from './src/prisma';
import { setEmailSessionEnabled } from './src/services/featureFlags';
import { startSession } from './src/routes/sessions';
import { callHandler } from './tests/utils';

async function main() {
  await prisma.$transaction([
    prisma.event.deleteMany(),
    prisma.minuteStat.deleteMany(),
    prisma.presencePrompt.deleteMany(),
    prisma.timeRequest.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.authAuditLog.deleteMany(),
    prisma.sessionPause.deleteMany(),
    prisma.config.deleteMany(),
    prisma.session.deleteMany(),
    prisma.ptoBalance.deleteMany(),
    prisma.user.deleteMany()
  ]);
  await setEmailSessionEnabled(true);
  const employee = await prisma.user.create({
    data: {
      email: 'worker@example.com',
      name: 'Worker Bee',
      role: 'employee',
      passwordHash: 'placeholder',
      active: true
    }
  });
  console.log('user created', employee.id);
  try {
    const result = await callHandler(startSession, {
      body: { flow: 'email_only', email: employee.email }
    });
    console.log('status', result.status, result.data);
  } catch (error) {
    console.error('caught', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
});

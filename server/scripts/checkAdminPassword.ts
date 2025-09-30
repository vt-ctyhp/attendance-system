import { prisma } from '../src/prisma';
import { verifyPassword } from '../src/auth';

(async () => {
  const admin = await prisma.user.findUnique({ where: { email: 'admin@example.com' } });
  if (!admin) {
    console.log('admin missing');
    process.exit(0);
  }
  const ok = await verifyPassword('AdminPass123!', admin.passwordHash);
  console.log('password valid?', ok);
  await prisma.$disconnect();
})();

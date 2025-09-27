import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export default async function globalSetup() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const testDbPath = resolve(root, 'tests', 'test.db');

  process.env.NODE_ENV = 'test';
  process.env.PORT = process.env.PORT ?? '4850';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-1234567890!';
  process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@test.local';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'TestPassword123!';
  process.env.BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
  process.env.DATABASE_URL = `file:${testDbPath}`;
  process.env.USE_POSTGRES = process.env.USE_POSTGRES ?? '0';

  if (existsSync(testDbPath)) {
    rmSync(testDbPath);
  }

  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    cwd: root,
    env: { ...process.env },
    stdio: 'pipe'
  });
}

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

const buildAdminUrl = (databaseUrl: string) => {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
};

const dropDatabaseIfExists = async (client: Client, dbName: string) => {
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch (error) {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]);
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  }
};

const createDatabase = async (client: Client, dbName: string) => {
  await client.query(`CREATE DATABASE "${dbName}"`);
};

export default async function globalSetup() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envTestPath = resolve(root, '.env.test');
  const envExamplePath = resolve(root, '.env.test.example');
  const envPath = existsSync(envTestPath) ? envTestPath : envExamplePath;

  loadEnv({ path: envPath });

  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
  process.env.PORT = process.env.PORT ?? '4850';
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-1234567890!';
  process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@test.local';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'TestPassword123!';
  process.env.BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT}`;
  process.env.USE_POSTGRES = '1';

  const templateUrl =
    process.env.TEST_DATABASE_TEMPLATE_URL ??
    process.env.DATABASE_TEMPLATE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://attendance:attendance@127.0.0.1:5433/attendance';

  const dbName = `attendance_test_${randomUUID().replace(/-/g, '')}`;
  const databaseUrl = new URL(templateUrl);
  databaseUrl.pathname = `/${dbName}`;

  const adminUrl = buildAdminUrl(templateUrl);
  const adminClient = new Client({ connectionString: adminUrl });
  await adminClient.connect();
  try {
    await dropDatabaseIfExists(adminClient, dbName);
    await createDatabase(adminClient, dbName);
  } finally {
    await adminClient.end();
  }

  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.TEST_DATABASE_NAME = dbName;
  process.env.TEST_DATABASE_ADMIN_URL = adminUrl;

  execSync('node scripts/ensure-migrations.cjs', {
    cwd: root,
    env: { ...process.env },
    stdio: 'inherit'
  });

  console.info('Test DB ready');
}

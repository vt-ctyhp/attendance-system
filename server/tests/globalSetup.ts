import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

const ensureDatabase = async (connectionString: string) => {
  const url = new URL(connectionString);
  const databaseName = url.pathname.replace(/^\//, '');

  if (!databaseName) {
    throw new Error('DATABASE_URL must include a database name');
  }

  const connect = async (target: string) => {
    const client = new Client({ connectionString: target });
    try {
      await client.connect();
    } finally {
      await client.end().catch(() => {});
    }
  };

  try {
    await connect(connectionString);
    return;
  } catch (error) {
    const pgError = error as { code?: string };
    const missingDatabase = pgError.code === '3D000';

    if (!missingDatabase) {
      throw error;
    }
  }

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';

  const adminClient = new Client({ connectionString: adminUrl.toString() });

  try {
    await adminClient.connect();
    const quotedName = databaseName.replace(/"/g, '""');
    await adminClient.query(`CREATE DATABASE "${quotedName}"`);
  } catch (creationError) {
    throw new Error(`Failed to create database "${databaseName}": ${(creationError as Error).message}`);
  } finally {
    await adminClient.end().catch(() => {});
  }

  await connect(connectionString);
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
  process.env.USE_POSTGRES = process.env.USE_POSTGRES ?? '1';

  const databaseUrl = process.env.DATABASE_URL ?? '';
  const shadowUrl = process.env.SHADOW_DATABASE_URL;

  if (!databaseUrl.toLowerCase().startsWith('postgres')) {
    throw new Error('Tests require DATABASE_URL to start with postgres:// or postgresql://');
  }

  await ensureDatabase(databaseUrl);
  if (shadowUrl && shadowUrl.toLowerCase().startsWith('postgres')) {
    try {
      await ensureDatabase(shadowUrl);
    } catch (error) {
      console.warn(`Skipping shadow database initialization: ${(error as Error).message}`);
    }
  }

  execSync('npx prisma db push --force-reset --skip-generate', {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  });

  console.info('Test DB ready');
}

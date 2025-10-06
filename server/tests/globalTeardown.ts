import { Client } from 'pg';

const dropTestDatabase = async () => {
  const dbName = process.env.TEST_DATABASE_NAME;
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;

  if (!dbName || !adminUrl) {
    return;
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    try {
      await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } catch {
      await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]);
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    }
  } finally {
    await client.end();
  }
};

export default async function globalTeardown() {
  await dropTestDatabase();
}

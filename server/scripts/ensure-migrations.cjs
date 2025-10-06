#!/usr/bin/env node

const { execSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { Client } = require('pg');

const projectRoot = resolve(__dirname, '..');
const migrationsRoot = join(projectRoot, 'prisma', 'migrations');
const args = process.argv.slice(2);
const isFlagPresent = (flag) => {
  const normalized = flag.startsWith('--') ? flag : `--${flag}`;
  return args.includes(normalized);
};
const dryRun = isFlagPresent('--dry-run');

const info = (message) => {
  process.stdout.write(`[ensure-migrations] ${message}\n`);
};

const debug = (message) => {
  if (process.env.DEBUG_MIGRATIONS) {
    process.stdout.write(`[ensure-migrations][debug] ${message}\n`);
  }
};

const runPrismaCommand = (command, databaseUrl) => {
  info(`${dryRun ? '[dry-run] ' : ''}${command}`);
  if (dryRun) {
    return;
  }
  execSync(command, {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit'
  });
};

const getMigrations = () => {
  if (!existsSync(migrationsRoot)) {
    throw new Error(`Unable to locate migrations directory at ${migrationsRoot}`);
  }
  return readdirSync(migrationsRoot)
    .filter((entry) => !entry.startsWith('.') && entry !== 'migration_lock.toml')
    .sort();
};

const withClient = async (connectionString, callback) => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
};

const buildAdminUrl = (databaseUrl) => {
  const url = new URL(databaseUrl);
  // default to postgres database for administrative commands
  url.pathname = '/postgres';
  return url.toString();
};

const schemaHasMigrationsTable = async (databaseUrl) => {
  const result = await withClient(databaseUrl, (client) =>
    client.query("select to_regclass('_prisma_migrations') as table")
  );
  return Boolean(result.rows[0]?.table);
};

const tableExists = async (databaseUrl, tableName) => {
  const result = await withClient(databaseUrl, (client) =>
    client.query('select to_regclass($1) as table', [`public.${tableName}`])
  );
  return Boolean(result.rows[0]?.table);
};

const markBaselineMigrationsApplied = async (databaseUrl, baselineMigrations) => {
  if (!baselineMigrations.length) {
    return;
  }

  for (const migration of baselineMigrations) {
    runPrismaCommand(`npx prisma migrate resolve --applied ${migration}`, databaseUrl);
  }
};

const verifyExpectedColumns = async (databaseUrl) => {
  if (dryRun) {
    info('Skipping column verification because dry-run flag is set');
    return;
  }

  const expectations = [
    { table: 'EmployeeCompConfig', column: 'utoBalanceHours' },
    { table: 'AttendanceMonthFact', column: 'utoAbsenceHours' },
    { table: 'PtoBalance', column: 'utoHours' }
  ];

  const missing = [];

  await withClient(databaseUrl, async (client) => {
    for (const { table, column } of expectations) {
      const { rowCount } = await client.query(
        `select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`,
        [table, column]
      );
      if (rowCount === 0) {
        missing.push(`${table}.${column}`);
      } else {
        debug(`Verified column ${table}.${column}`);
      }
    }
  });

  if (missing.length) {
    throw new Error(`Migration verification failed. Missing columns: ${missing.join(', ')}`);
  }

  info('Verified expected UTO columns are present');
};

const redactDatabaseUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
};

const ensureMigrations = async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set to run migrations');
  }

  info(`Ensuring migrations for ${redactDatabaseUrl(databaseUrl)}`);

  const migrations = getMigrations();
  if (!migrations.length) {
    info('No migrations discovered; skipping');
    return;
  }

  const hasMigrationsTable = await schemaHasMigrationsTable(databaseUrl);
  const hasUserTable = await tableExists(databaseUrl, 'User');

  if (!hasMigrationsTable) {
    if (!hasUserTable) {
      info('No existing Prisma migration metadata detected; running db push baseline');
      runPrismaCommand('npx prisma db push', databaseUrl);
      await markBaselineMigrationsApplied(databaseUrl, migrations);
      await verifyExpectedColumns(databaseUrl);
      return;
    }

    // When baselining an existing schema, mark all but the latest migration as applied
    // so rename migrations execute through prisma migrate deploy.
    const baseline = migrations.slice(0, -1);
    if (baseline.length) {
      info(`Baselining ${baseline.length} existing migrations`);
      await markBaselineMigrationsApplied(databaseUrl, baseline);
    }
  }

  info('Running prisma migrate deploy');
  runPrismaCommand('npx prisma migrate deploy', databaseUrl);
  await verifyExpectedColumns(databaseUrl);
};

ensureMigrations().catch((error) => {
  console.error('Failed to ensure database migrations:', error);
  process.exit(1);
});

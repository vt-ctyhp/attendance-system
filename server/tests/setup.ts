import { afterAll, afterEach, beforeEach } from 'vitest';

process.env.BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4850';

let prisma: typeof import('../src/prisma').prisma | null = null;
let featureFlags: typeof import('../src/services/featureFlags') | null = null;

const getPrisma = async () => {
  if (!prisma) {
    ({ prisma } = await import('../src/prisma'));
  }
  return prisma;
};

const getFeatureFlags = async () => {
  if (!featureFlags) {
    featureFlags = await import('../src/services/featureFlags');
  }
  return featureFlags;
};

const resetFeatureFlags = async () => {
  const flags = await getFeatureFlags();
  flags.resetEmailSessionCache();
  await flags.setEmailSessionEnabled(false);
};

const resetDatabase = async () => {
  const client = await getPrisma();
  const tables = [
    '"AttendanceMonthFact"',
    '"BalanceLedger"',
    '"BonusCandidate"',
    '"PayrollAuditLog"',
    '"PayrollLine"',
    '"PayrollPeriod"',
    '"PresencePrompt"',
    '"SessionPause"',
    '"MinuteStat"',
    '"Event"',
    '"ShiftAssignment"',
    '"TimeRequest"',
    '"TimesheetEditRequest"',
    '"EmployeeCompConfig"',
    '"AccrualRule"',
    '"Config"',
    '"RefreshToken"',
    '"PtoBalance"',
    '"Holiday"',
    '"AuthAuditLog"',
    '"Session"',
    '"User"'
  ];

  await client.$executeRawUnsafe(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  await resetFeatureFlags();
};

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (prisma) {
    await prisma.$disconnect();
  }
});

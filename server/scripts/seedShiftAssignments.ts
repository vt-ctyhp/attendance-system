import { zonedTimeToUtc } from 'date-fns-tz';
import { prisma } from '../src/prisma';
import { TIMESHEET_TIME_ZONE } from '../src/services/timesheets';

const toUtc = (iso: string) => zonedTimeToUtc(iso, TIMESHEET_TIME_ZONE);

const SHIFT_DEFINITIONS = [
  {
    email: 'admin@example.com',
    label: 'Admin Coverage',
    start: '2025-10-06T09:00:00',
    end: '2025-10-06T17:00:00'
  },
  {
    email: 'vt@ctyhp.us',
    label: 'Retail Opening',
    start: '2025-10-07T08:30:00',
    end: '2025-10-07T16:30:00'
  },
  {
    email: 'worker@example.com',
    label: 'Inventory Count',
    start: '2025-10-08T12:00:00',
    end: '2025-10-08T20:00:00'
  }
];

const environmentName = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase();
const explicitEnable = process.env.SHIFT_SEED_ENABLED ?? '';
const allowProd = process.argv.includes('--allow-prod');
const isProductionEnv = environmentName === 'production' || environmentName === 'prod';

if (explicitEnable.toLowerCase() === 'false') {
  console.log('Shift seed disabled via SHIFT_SEED_ENABLED flag.');
  process.exit(0);
}

if (isProductionEnv && !allowProd) {
  console.log('Detected production environment; skipping shift seed. Pass --allow-prod to override.');
  process.exit(0);
}

if (!allowProd && explicitEnable && explicitEnable.toLowerCase() !== 'true' && explicitEnable !== '') {
  console.log(`Shift seed skipped (SHIFT_SEED_ENABLED=${explicitEnable}). Set to "true" to run.`);
  process.exit(0);
}

const seed = async () => {
  const users = await prisma.user.findMany({
    where: { email: { in: SHIFT_DEFINITIONS.map((shift) => shift.email) } },
    select: { id: true, email: true }
  });

  const userByEmail = new Map(users.map((user) => [user.email, user.id]));

  const missing = SHIFT_DEFINITIONS.filter((shift) => !userByEmail.has(shift.email));
  if (missing.length) {
    throw new Error(`Missing users for shift seed: ${missing.map((shift) => shift.email).join(', ')}`);
  }

  let created = 0;

  for (const shift of SHIFT_DEFINITIONS) {
    const userId = userByEmail.get(shift.email)!;
    const startsAt = toUtc(shift.start);
    const endsAt = toUtc(shift.end);

    const exists = await prisma.shiftAssignment.findFirst({
      where: {
        userId,
        startsAt,
        endsAt
      }
    });

    if (exists) {
      continue;
    }

    await prisma.shiftAssignment.create({
      data: {
        userId,
        label: shift.label,
        startsAt,
        endsAt
      }
    });

    created += 1;
  }

  if (created === 0) {
    console.log('Sample shift assignments already present; no inserts performed.');
  } else {
    console.log(`Seeded ${created} sample shift assignment${created === 1 ? '' : 's'}.`);
  }
};

seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

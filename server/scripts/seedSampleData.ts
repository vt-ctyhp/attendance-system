import { randomUUID } from 'crypto';
import { addMinutes, startOfDay, subDays } from 'date-fns';

import { prisma } from '../src/prisma';
import { hashPassword } from '../src/auth';

const SAMPLE_PASSWORD = 'SamplePass123!';
const SAMPLE_DEVICE_IDS = ['sample-device-1', 'sample-device-2'];

const sampleUsers = [
  {
    email: 'chloe.sanchez@example.com',
    name: 'Chloe Sanchez',
    role: 'employee' as const,
    deviceId: SAMPLE_DEVICE_IDS[0]
  },
  {
    email: 'marcus.lee@example.com',
    name: 'Marcus Lee',
    role: 'employee' as const,
    deviceId: SAMPLE_DEVICE_IDS[1]
  }
];

async function seedUser(email: string, name: string, role: 'employee' | 'manager' | 'admin') {
  const passwordHash = await hashPassword(SAMPLE_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, role, active: true },
    create: {
      email,
      name,
      role,
      active: true,
      passwordHash
    }
  });
  return user;
}

async function seedSessions(userId: number, deviceId: string) {
  const todayStart = startOfDay(new Date());
  const sessionStart = addMinutes(todayStart, 9 * 60); // 9:00 AM
  const sessionEnd = addMinutes(sessionStart, 8 * 60); // 8 hour shift

  const minuteStatsData = Array.from({ length: 8 * 60 }).map((_, index) => ({
    minuteStart: addMinutes(sessionStart, index),
    active: index % 10 !== 0,
    idle: index % 10 === 0,
    keysCount: index % 10 !== 0 ? 50 : 5,
    mouseCount: index % 10 !== 0 ? 30 : 4,
    fgApp: index % 10 !== 0 ? 'Figma' : 'Slack'
  }));

  await prisma.session.create({
    data: {
      userId,
      deviceId,
      startedAt: sessionStart,
      endedAt: sessionEnd,
      status: 'completed',
      minuteStats: {
        create: minuteStatsData
      },
      events: {
        create: [
          {
            id: randomUUID(),
            ts: addMinutes(sessionStart, 210),
            type: 'presence_miss',
            payload: '{}'
          }
        ]
      },
      pauses: {
        create: [
          {
            type: 'break',
            sequence: 1,
            startedAt: addMinutes(sessionStart, 120),
            endedAt: addMinutes(sessionStart, 135),
            durationMinutes: 15
          },
          {
            type: 'lunch',
            sequence: 1,
            startedAt: addMinutes(sessionStart, 240),
            endedAt: addMinutes(sessionStart, 300),
            durationMinutes: 60
          }
        ]
      }
    }
  });
}

async function seedHistoricalSessions(userId: number, deviceId: string) {
  for (let dayOffset = 1; dayOffset <= 6; dayOffset += 1) {
    const dayStart = startOfDay(subDays(new Date(), dayOffset));
    const sessionStart = addMinutes(dayStart, 9 * 60);
    const sessionEnd = addMinutes(sessionStart, 7.5 * 60);

    await prisma.session.create({
      data: {
        userId,
        deviceId,
        startedAt: sessionStart,
        endedAt: sessionEnd,
        status: 'completed',
        minuteStats: {
          create: Array.from({ length: 7.5 * 60 }).map((_, index) => ({
            minuteStart: addMinutes(sessionStart, index),
            active: index % 12 !== 0,
            idle: index % 12 === 0,
            keysCount: 40,
            mouseCount: 25,
            fgApp: 'VSCode'
          }))
        }
      }
    });
  }
}

async function seedTimeRequests(userId: number) {
  const start = subDays(startOfDay(new Date()), 3);
  await prisma.timeRequest.create({
    data: {
      userId,
      type: 'pto',
      status: 'approved',
      startDate: start,
      endDate: addMinutes(start, 60 * 8),
      hours: 8,
      reason: 'Family appointment'
    }
  });
}

async function main() {
  console.log('Seeding sample employees...');
  await prisma.sessionPause.deleteMany({ where: { session: { deviceId: { in: SAMPLE_DEVICE_IDS } } } });
  await prisma.minuteStat.deleteMany({ where: { session: { deviceId: { in: SAMPLE_DEVICE_IDS } } } });
  await prisma.event.deleteMany({ where: { session: { deviceId: { in: SAMPLE_DEVICE_IDS } } } });
  await prisma.session.deleteMany({ where: { deviceId: { in: SAMPLE_DEVICE_IDS } } });
  const sampleEmails = sampleUsers.map((user) => user.email);
  await prisma.timeRequest.deleteMany({ where: { user: { email: { in: sampleEmails } } } });

  for (const sample of sampleUsers) {
    const user = await seedUser(sample.email, sample.name, sample.role);
    await seedSessions(user.id, sample.deviceId);
    await seedHistoricalSessions(user.id, sample.deviceId);
    await seedTimeRequests(user.id);
    console.log(`Seeded data for ${sample.name} (${sample.email})`);
  }

  console.log('Sample data ready!');
  console.log(`Sample employee login uses password: ${SAMPLE_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error('Failed to seed sample data', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

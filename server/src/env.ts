import { config } from 'dotenv';
import { z } from 'zod';

config();

if (process.env.BASE_URL === '/' || process.env.BASE_URL === '') {
  delete (process.env as Record<string, string | undefined>).BASE_URL;
}

const booleanFromEnv = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return value;
}, z.boolean());

const baseUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }, 'Invalid url');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(10),
  BASE_URL: baseUrlSchema.default('http://localhost:4000'),
  USE_POSTGRES: z.coerce.number().min(0).max(1).default(0).optional(),
  SQLITE_BACKUP_ENABLED: booleanFromEnv.default(true),
  SQLITE_BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  SQLITE_BACKUP_DIR: z.string().min(1).default('./backups'),
  SQLITE_BACKUP_TIME: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .refine((value) => {
      const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10));
      return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
    }, 'SQLITE_BACKUP_TIME must be in HH:MM 24-hour format')
    .default('02:30'),
  START_SESSION_BY_EMAIL_ENABLED: booleanFromEnv.default(false),
  START_SESSION_BY_EMAIL_ALLOWED_IPS: z.string().optional(),
  START_SESSION_BY_EMAIL_CLIENT_HEADER: z.string().optional(),
  START_SESSION_BY_EMAIL_CLIENT_SECRET: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

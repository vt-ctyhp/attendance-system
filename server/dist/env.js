"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = require("dotenv");
const zod_1 = require("zod");
(0, dotenv_1.config)();
if (process.env.BASE_URL === '/' || process.env.BASE_URL === '') {
    delete process.env.BASE_URL;
}
const booleanFromEnv = zod_1.z.preprocess((value) => {
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
}, zod_1.z.boolean());
const baseUrlSchema = zod_1.z
    .string()
    .trim()
    .refine((value) => {
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}, 'Invalid url');
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    PORT: zod_1.z.coerce.number().default(4000),
    DATABASE_URL: zod_1.z.string().min(1),
    JWT_SECRET: zod_1.z.string().min(16),
    ADMIN_EMAIL: zod_1.z.string().email(),
    ADMIN_PASSWORD: zod_1.z.string().min(10),
    BASE_URL: baseUrlSchema.default('http://localhost:4000'),
    USE_POSTGRES: zod_1.z.coerce.number().min(0).max(1).default(0).optional(),
    SQLITE_BACKUP_ENABLED: booleanFromEnv.default(true),
    SQLITE_BACKUP_RETENTION_DAYS: zod_1.z.coerce.number().int().min(1).max(365).default(14),
    SQLITE_BACKUP_DIR: zod_1.z.string().min(1).default('./backups'),
    SQLITE_BACKUP_TIME: zod_1.z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .refine((value) => {
        const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10));
        return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
    }, 'SQLITE_BACKUP_TIME must be in HH:MM 24-hour format')
        .default('02:30'),
    START_SESSION_BY_EMAIL_ENABLED: booleanFromEnv.default(true),
    START_SESSION_BY_EMAIL_ALLOWED_IPS: zod_1.z.string().optional(),
    START_SESSION_BY_EMAIL_CLIENT_HEADER: zod_1.z.string().optional(),
    START_SESSION_BY_EMAIL_CLIENT_SECRET: zod_1.z.string().optional()
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
    process.exit(1);
}
exports.env = parsed.data;

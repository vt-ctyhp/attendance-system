import type { Request } from 'express';
import { env } from '../env';
import { getConfigValue, setConfigValue } from './config';

const FLAG_KEY = 'start_session_by_email_enabled';

let cachedFlag: { value: boolean; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

const allowedIps = env.START_SESSION_BY_EMAIL_ALLOWED_IPS
  ? env.START_SESSION_BY_EMAIL_ALLOWED_IPS.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  : [];

const clientHeaderName = env.START_SESSION_BY_EMAIL_CLIENT_HEADER?.trim();
const clientHeaderSecret = env.START_SESSION_BY_EMAIL_CLIENT_SECRET?.trim();

const normalizeIp = (ip?: string | null) => {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
};

export const isEmailSessionEnabled = async (): Promise<boolean> => {
  const now = Date.now();
  if (cachedFlag && now - cachedFlag.fetchedAt < CACHE_TTL_MS) {
    return cachedFlag.value;
  }
  const configValue = await getConfigValue(FLAG_KEY);
  const value = configValue === null ? env.START_SESSION_BY_EMAIL_ENABLED : configValue === 'true';
  cachedFlag = { value, fetchedAt: now };
  return value;
};

export const setEmailSessionEnabled = async (enabled: boolean): Promise<void> => {
  await setConfigValue(FLAG_KEY, enabled ? 'true' : 'false');
  cachedFlag = { value: enabled, fetchedAt: Date.now() };
};

export const resetEmailSessionCache = (): void => {
  cachedFlag = null;
};

export const isIpAllowed = (req: Request): boolean => {
  if (!allowedIps.length) {
    return true;
  }
  const ip = normalizeIp(req.ip);
  return allowedIps.includes(ip);
};

export const isClientHeaderValid = (req: Request): boolean => {
  if (!clientHeaderName || !clientHeaderSecret) {
    return true;
  }
  const headerValue = req.get(clientHeaderName);
  return headerValue === clientHeaderSecret;
};

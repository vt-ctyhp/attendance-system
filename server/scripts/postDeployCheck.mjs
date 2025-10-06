#!/usr/bin/env node
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const args = [...process.argv.slice(2)];
let strict = false;
if (args[0] === '--strict') {
  strict = true;
  args.shift();
}

const email = args[0] ?? process.env.POST_DEPLOY_EMAIL ?? process.env.SCHEDULE_CHECK_EMAIL;
const baseUrl = args[1] ?? process.env.POST_DEPLOY_BASE_URL ?? process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const attempts = Number.parseInt(process.env.POST_DEPLOY_RETRIES ?? '3', 10);
const retryDelayMs = Number.parseInt(process.env.POST_DEPLOY_RETRY_DELAY_MS ?? '1500', 10);

const warn = (message) => {
  console.warn(`[post-deploy-check] ${message}`);
};

if (!email) {
  warn('No email provided; set POST_DEPLOY_EMAIL env var or pass as first argument.');
  process.exit(strict ? 1 : 0);
}

const target = new URL('/api/app/overview', baseUrl);
target.searchParams.set('email', email);

const fetchJson = async () => {
  try {
    const response = await fetch(target, { method: 'GET' });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

let lastError = 'unknown error';
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const result = await fetchJson();
  if (result.ok) {
    const upcoming = result.body?.schedule?.upcoming;
    const count = Array.isArray(upcoming) ? upcoming.length : 0;
    if (count > 0) {
      console.log(`[post-deploy-check] PASS schedule entries found for ${email} (${count} upcoming).`);
      process.exit(0);
    }
    lastError = `Empty upcoming schedule for ${email}`;
  } else {
    lastError = result.error;
  }

  if (attempt < attempts) {
    await delay(retryDelayMs);
  }
}

warn(`Schedule check incomplete: ${lastError}`);
process.exit(strict ? 1 : 0);

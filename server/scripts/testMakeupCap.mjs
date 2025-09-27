#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REQUIRED_MESSAGE = 'Request exceeds monthly cap';

const getRootDir = () => {
  const filename = fileURLToPath(import.meta.url);
  const dir = path.dirname(filename);
  return path.resolve(dir, '..');
};

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim() || `${command} exited with code ${result.status}`;
    throw new Error(details);
  }
  return result.stdout;
};

const runSqlite = (sql) => {
  const root = getRootDir();
  const dbPath = path.join(root, 'prisma', 'dev.db');
  return runCommand('sqlite3', ['-json', dbPath, sql]);
};

const signJwt = (secret, payload) => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const headerPart = encode(header);
  const payloadPart = encode(payload);
  const body = `${headerPart}.${payloadPart}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
};

const postJson = (url, token, body) => {
  const args = [
    '-sS',
    '-w',
    '\nHTTPSTATUS:%{http_code}',
    '-H',
    'Content-Type: application/json',
    '-H',
    `Authorization: Bearer ${token}`,
    '-d',
    JSON.stringify(body),
    url
  ];
  const result = spawnSync('curl', args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = result.stderr?.trim() || `curl exited with code ${result.status}`;
    throw new Error(details);
  }
  const output = result.stdout ?? '';
  const match = output.match(/HTTPSTATUS:(\d{3})$/);
  if (!match) {
    const stderr = result.stderr?.trim();
    throw new Error(`Failed to parse curl response${stderr ? `: ${stderr}` : ''}`);
  }
  const status = Number.parseInt(match[1], 10);
  const bodyText = output.replace(/\s*HTTPSTATUS:\d{3}\s*$/, '').trim();
  const parsed = bodyText ? JSON.parse(bodyText) : {};
  return { status, body: parsed };
};

const approveRequestsViaSqlite = (ids, approverId) => {
  if (!ids.length) return;
  const sanitized = ids.map((id) => `'${String(id).replace(/'/g, "''")}'`);
  const sql = `UPDATE TimeRequest SET status='approved', approvedAt=CURRENT_TIMESTAMP, approverId=${approverId} WHERE id IN (${sanitized.join(', ')});`;
  const root = getRootDir();
  const dbPath = path.join(root, 'prisma', 'dev.db');
  runCommand('sqlite3', [dbPath, sql]);
};

const main = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  const root = getRootDir();
  const usersRaw = runSqlite('SELECT id, email, role, active FROM User ORDER BY id LIMIT 1;');
  const users = usersRaw.trim() ? JSON.parse(usersRaw) : [];
  if (!users.length) {
    throw new Error('No users found in database');
  }
  const [user] = users;
  if (!user.active) {
    throw new Error(`First user (${user.email}) is inactive`);
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    sub: user.id,
    role: 'employee',
    scope: 'full',
    typ: 'access',
    iat: issuedAt,
    exp: issuedAt + 3600,
    jti: randomUUID()
  };
  const token = signJwt(secret, tokenPayload);

  const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
  const endpoint = new URL('/api/time-requests', baseUrl).toString();

  const now = new Date();
  const zoneStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 9, 0, 0);

  const createdIds = [];

  for (let index = 0; index < 2; index += 1) {
    const startDate = new Date(zoneStart + index * 24 * 60 * 60 * 1000).toISOString();
    const response = postJson(endpoint, token, {
      type: 'make_up',
      startDate,
      hours: 4,
      reason: `Automated cap test #${index + 1}`
    });
    if (response.status !== 201) {
      throw new Error(`Expected 201 for request ${index + 1}, received ${response.status}`);
    }
    const requestId = response.body?.request?.id;
    if (!requestId) {
      throw new Error('Missing request id in response');
    }
    createdIds.push(requestId);
  }

  approveRequestsViaSqlite(createdIds, user.id);

  const thirdStartDate = new Date(zoneStart + 2 * 24 * 60 * 60 * 1000).toISOString();
  const thirdResponse = postJson(endpoint, token, {
    type: 'make_up',
    startDate: thirdStartDate,
    hours: 4,
    reason: 'Automated cap test #3'
  });

  if (thirdResponse.status !== 400) {
    throw new Error(`Expected 400 response for third request, received ${thirdResponse.status}`);
  }

  const errorMessage = typeof thirdResponse.body?.error === 'string' ? thirdResponse.body.error : '';
  if (!errorMessage.includes(REQUIRED_MESSAGE)) {
    throw new Error(`Missing expected error message: "${REQUIRED_MESSAGE}"`);
  }

  console.log('OK: Used 8h / Remaining 0h (cap 8h)');
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

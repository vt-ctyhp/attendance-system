import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { addDays, endOfDay, endOfMonth, parseISO, startOfDay, startOfMonth, subDays } from 'date-fns';
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from 'date-fns-tz';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  TIME_REQUEST_STATUSES,
  TIME_REQUEST_TYPES,
  TIMESHEET_VIEWS,
  TIMESHEET_EDIT_STATUSES,
  type TimeRequestStatus,
  type TimeRequestType,
  type TimesheetView,
  type TimesheetEditStatus
} from '../types';
import type { AuthenticatedRequest } from '../auth';
import {
  authenticate,
  requireRole,
  hashPassword,
  verifyPassword,
  generateToken,
  TOKEN_TTL_SECONDS,
  DASHBOARD_TOKEN_COOKIE_NAME,
  extractTokenFromRequest,
  resolveUserFromToken
} from '../auth';
import { env } from '../env';
import { isEmailSessionEnabled, setEmailSessionEnabled } from '../services/featureFlags';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../errors';
import { getUserTimesheet, computeTimesheetRange } from '../services/timesheets';
import { getBalanceOverview } from '../services/balances';
import {
  getMakeupCapHoursPerMonth,
  getApprovedMakeupHoursThisMonthByUser,
  remainingHoursWithinCap
} from '../services/timeRequestPolicy';

type SessionSummary = {
  userId: number;
  name: string;
  email: string;
  startedAt: Date;
  activeMinutes: number;
  idleMinutes: number;
  breaks: number;
  breakMinutes: number;
  lunches: number;
  lunchMinutes: number;
  presenceMisses: number;
};

type UserAggregate = {
  userId: number;
  name: string;
  email: string;
  activeMinutes: number;
  idleMinutes: number;
  breaks: number;
  breakMinutes: number;
  lunches: number;
  lunchMinutes: number;
  presenceMisses: number;
};

type SessionDetail = {
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  activeMinutes: number;
  idleMinutes: number;
  breaks: number;
  breakMinutes: number;
  lunches: number;
  lunchMinutes: number;
  presenceMisses: number;
};

type TotalsSource = {
  activeMinutes: number;
  idleMinutes: number;
  breaks: number;
  breakMinutes: number;
  lunches: number;
  lunchMinutes: number;
  presenceMisses: number;
};

type ActivityTotals = {
  active: number;
  idle: number;
  breaks: number;
  breakMinutes: number;
  lunches: number;
  lunchMinutes: number;
  presence: number;
};

type SessionRecord = {
  id: string;
  userId: number;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  user: { name: string; email: string };
  minuteStats: Array<{ active: boolean; idle: boolean }>;
  events: Array<{ type: string }>;
  pauses: Array<{ type: string; sequence: number; startedAt: Date; endedAt: Date | null; durationMinutes: number | null }>;
};

type PauseEntry = {
  sessionId: string;
  userId: number;
  userName: string;
  userEmail: string;
  type: 'break' | 'lunch';
  sequence: number;
  startedAt: Date;
  endedAt: Date | null;
  durationMinutes: number;
};

type RequestBadge = {
  id: string;
  userId: number;
  type: TimeRequestType;
  status: TimeRequestStatus;
  startDate: Date;
  endDate: Date;
  hours: number;
};

const DASHBOARD_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';
const ISO_DATE_TIME = "yyyy-MM-dd'T'HH:mm:ssXXX";
const ISO_DATE = 'yyyy-MM-dd';

const DASHBOARD_COOKIE_PATH = '/dashboard';
const DEFAULT_DASHBOARD_REDIRECT = '/dashboard/overview';
const DASHBOARD_LOGIN_ROUTE = '/dashboard/login';
const DASHBOARD_COOKIE_MAX_AGE_MS = TOKEN_TTL_SECONDS * 1000;
const IS_PRODUCTION = env.NODE_ENV === 'production';

const zoned = (date: Date) => utcToZonedTime(date, DASHBOARD_TIME_ZONE);
const zonedStartOfDay = (date: Date) => zonedTimeToUtc(startOfDay(zoned(date)), DASHBOARD_TIME_ZONE);
const zonedEndOfDay = (date: Date) => zonedTimeToUtc(endOfDay(zoned(date)), DASHBOARD_TIME_ZONE);
const zonedStartOfMonth = (date: Date) => zonedTimeToUtc(startOfMonth(zoned(date)), DASHBOARD_TIME_ZONE);
const zonedEndOfMonth = (date: Date) => zonedTimeToUtc(endOfMonth(zoned(date)), DASHBOARD_TIME_ZONE);

const formatDateTime = (value: Date) => formatInTimeZone(value, DASHBOARD_TIME_ZONE, 'MMM d, yyyy HH:mm');
const formatFullDate = (value: Date) => formatInTimeZone(value, DASHBOARD_TIME_ZONE, 'MMM d, yyyy');
const formatShortDate = (value: Date) => formatInTimeZone(value, DASHBOARD_TIME_ZONE, 'MMM d');
const formatIsoDateTime = (value: Date) => formatInTimeZone(value, DASHBOARD_TIME_ZONE, ISO_DATE_TIME);
const formatIsoDate = (value: Date) => formatInTimeZone(value, DASHBOARD_TIME_ZONE, ISO_DATE);

const minutesFormatter = (value: number) => `${value} min`;

const formatOptionalDate = (value: Date | null) => (value ? formatDateTime(value) : '—');

const toDateParam = (value: Date) => formatIsoDate(zonedStartOfDay(value));

const parseDateParam = (value: unknown): Date => {
  if (typeof value !== 'string' || !value) {
    return zonedStartOfDay(new Date());
  }
  const parsed = parseISO(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return zonedStartOfDay(new Date());
  }
  return zonedStartOfDay(parsed);
};

const parseMonthParam = (value: unknown): Date => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    return zonedStartOfMonth(new Date());
  }
  return zonedStartOfMonth(parseISO(`${value}-01T00:00:00`));
};

const parseDateOnlyParam = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  const parsed = parseISO(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return zonedStartOfDay(parsed);
};

const escapeCsv = (value: string | number) => {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');


const isDashboardRole = (role: string) => role === 'admin' || role === 'manager';

const sanitizeRedirect = (value: unknown): string => {
  if (typeof value !== 'string') {
    return DEFAULT_DASHBOARD_REDIRECT;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    return DEFAULT_DASHBOARD_REDIRECT;
  }
  if (trimmed.startsWith('//')) {
    return DEFAULT_DASHBOARD_REDIRECT;
  }
  if (!trimmed.startsWith('/dashboard')) {
    return DEFAULT_DASHBOARD_REDIRECT;
  }
  if (trimmed.startsWith(DASHBOARD_LOGIN_ROUTE)) {
    return DEFAULT_DASHBOARD_REDIRECT;
  }
  return trimmed;
};

const isHtmlRequest = (req: Request) => {
  const accept = req.headers.accept;
  if (typeof accept !== 'string' || accept.trim() === '') {
    return true;
  }
  return accept.includes('text/html') || accept.includes('*/*');
};

const mapLoginError = (code: string | undefined) => {
  switch (code) {
    case 'invalid':
      return 'Invalid email or password.';
    case 'forbidden':
      return 'Your account does not have access to the dashboard.';
    case 'rate_limited':
      return 'Too many attempts. Try again in a minute.';
    default:
      return undefined;
  }
};

const mapLoginMessage = (code: string | undefined) => {
  switch (code) {
    case 'logged_out':
      return 'You are now signed out.';
    case 'session_expired':
      return 'Your session has expired. Please sign in again.';
    default:
      return undefined;
  }
};

const renderLoginPage = (options: {
  redirectTo: string;
  email?: string;
  errorCode?: string;
  messageCode?: string;
}) => {
  const errorMessage = mapLoginError(options.errorCode);
  const message = mapLoginMessage(options.messageCode);
  const emailValue = options.email ? escapeHtml(options.email) : '';
  const redirectValue = escapeHtml(options.redirectTo);

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Attendance Dashboard — Sign In</title>
      <style>
        :root {
          color-scheme: light;
          font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: radial-gradient(circle at top, #1e3a8a 0%, #0f172a 55%, #0b1120 100%);
          color: #0f172a;
        }
        .login-wrapper {
          width: min(420px, calc(100% - 2rem));
          padding: 1rem;
        }
        .login-card {
          background: rgba(255, 255, 255, 0.98);
          border-radius: 14px;
          box-shadow: 0 20px 55px rgba(15, 23, 42, 0.35);
          padding: 2.25rem clamp(1.5rem, 4vw, 2.5rem);
          backdrop-filter: blur(12px);
        }
        .login-card h1 {
          margin: 0 0 0.35rem;
          font-size: 1.75rem;
          font-weight: 700;
          color: #0f172a;
          letter-spacing: -0.01em;
        }
        .login-card p {
          margin: 0 0 1.5rem;
          color: #475569;
          font-size: 0.95rem;
        }
        form {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        label {
          font-size: 0.85rem;
          font-weight: 600;
          letter-spacing: 0.01em;
          color: #1f2937;
        }
        input[type="email"],
        input[type="password"] {
          width: 100%;
          padding: 0.65rem 0.75rem;
          border-radius: 10px;
          border: 1px solid #dbeafe;
          background: #f8fafc;
          font-size: 0.95rem;
          transition: border 0.2s ease, box-shadow 0.2s ease;
        }
        input[type="email"]:focus,
        input[type="password"]:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
          outline: none;
        }
        button[type="submit"] {
          margin-top: 0.5rem;
          display: inline-flex;
          justify-content: center;
          align-items: center;
          padding: 0.7rem 1rem;
          border-radius: 999px;
          border: none;
          font-size: 0.95rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: #fff;
          background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        button[type="submit"]:hover {
          transform: translateY(-1px);
          box-shadow: 0 12px 30px rgba(37, 99, 235, 0.25);
        }
        .alert {
          border-radius: 10px;
          padding: 0.75rem 0.85rem;
          font-size: 0.88rem;
          font-weight: 500;
          margin-bottom: 0.75rem;
        }
        .alert--error {
          background: rgba(239, 68, 68, 0.12);
          color: #b91c1c;
          border: 1px solid rgba(239, 68, 68, 0.18);
        }
        .alert--info {
          background: rgba(37, 99, 235, 0.12);
          color: #1d4ed8;
          border: 1px solid rgba(37, 99, 235, 0.2);
        }
        @media (max-width: 520px) {
          .login-card {
            padding: 2rem 1.5rem;
          }
        }
      </style>
    </head>
    <body>
      <main class="login-wrapper">
        <section class="login-card">
          <h1>Attendance Dashboard</h1>
          <p>Sign in with your administrator credentials to continue.</p>
          ${message ? `<div class="alert alert--info">${escapeHtml(message)}</div>` : ''}
          ${errorMessage ? `<div class="alert alert--error">${escapeHtml(errorMessage)}</div>` : ''}
          <form method="post" action="${DASHBOARD_LOGIN_ROUTE}">
            <input type="hidden" name="redirect" value="${redirectValue}" />
            <label for="login-email">Work Email</label>
            <input id="login-email" type="email" name="email" value="${emailValue}" autocomplete="email" required autofocus />
            <label for="login-password">Password</label>
            <input id="login-password" type="password" name="password" autocomplete="current-password" required />
            <button type="submit">Sign In</button>
          </form>
        </section>
      </main>
    </body>
  </html>`;
};

const loginFormSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  redirect: z.string().optional()
});


const relevantRequestTypes: TimeRequestType[] = ['pto', 'non_pto'];
const visibleRequestStatuses: TimeRequestStatus[] = ['pending', 'approved'];

const requestTypeLabels: Record<TimeRequestType, string> = {
  pto: 'PTO',
  non_pto: 'Non-PTO',
  make_up: 'Make-Up'
};

const requestStatusLabels: Record<TimeRequestStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied'
};

const requestStatusOrder: Record<TimeRequestStatus, number> = {
  pending: 0,
  approved: 1,
  denied: 2
};

const formatRequestBadgeTitle = (badge: RequestBadge) => {
  const typeLabel = requestTypeLabels[badge.type];
  const statusLabel = requestStatusLabels[badge.status];
  const rangeLabel = `${formatShortDate(badge.startDate)} – ${formatShortDate(badge.endDate)}`;
  const hoursValue = Number.isInteger(badge.hours) ? badge.hours.toString() : badge.hours.toFixed(2);
  return `${typeLabel} ${statusLabel} • ${rangeLabel} • ${hoursValue}h`;
};

const renderRequestBadges = (badges: RequestBadge[]) => {
  if (!badges.length) {
    return '';
  }

  const sorted = badges
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) {
        return requestTypeLabels[a.type].localeCompare(requestTypeLabels[b.type]);
      }
      if (a.status !== b.status) {
        return requestStatusOrder[a.status] - requestStatusOrder[b.status];
      }
      return a.startDate.getTime() - b.startDate.getTime();
    });

  const items = sorted
    .map((badge) => {
      const label = `${requestTypeLabels[badge.type]} – ${requestStatusLabels[badge.status]}`;
      return `<span class="badge badge-${badge.type} badge-status-${badge.status}" title="${escapeHtml(formatRequestBadgeTitle(badge))}">${escapeHtml(label)}</span>`;
    })
    .join('');

  return `<div class="badges">${items}</div>`;
};

const formatHours = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
};

const minutesToHoursValue = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const formatHoursFromMinutes = (minutes: number) => formatHours(minutesToHoursValue(minutes));
const formatTimesheetStatus = (status: string) =>
  status ? `${status.charAt(0).toUpperCase()}${status.slice(1)}` : status;
const timesheetViewLabel = (view: TimesheetView) => {
  switch (view) {
    case 'pay_period':
      return 'Pay Period';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
    default:
      return 'Monthly';
  }
};

const buildSelectOptions = (options: Array<{ value: string; label: string }>, selected?: string) =>
  options
    .map(({ value, label }) =>
      `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`
    )
    .join('');

const collectRequestBadges = async (userIds: number[], rangeStart: Date, rangeEnd: Date) => {
  if (!userIds.length) {
    return new Map<number, RequestBadge[]>();
  }

  const requests = await prisma.timeRequest.findMany({
    where: {
      userId: { in: userIds },
      startDate: { lte: rangeEnd },
      endDate: { gte: rangeStart },
      type: { in: relevantRequestTypes },
      status: { in: visibleRequestStatuses }
    },
    select: {
      id: true,
      userId: true,
      type: true,
      status: true,
      startDate: true,
      endDate: true,
      hours: true
    },
    orderBy: [{ userId: 'asc' }, { startDate: 'asc' }]
  });

  return requests.reduce<Map<number, RequestBadge[]>>((acc, request) => {
    const current = acc.get(request.userId) ?? [];
    current.push({
      id: request.id,
      userId: request.userId,
      type: request.type as TimeRequestType,
      status: request.status as TimeRequestStatus,
      startDate: request.startDate,
      endDate: request.endDate,
      hours: request.hours
    });
    acc.set(request.userId, current);
    return acc;
  }, new Map<number, RequestBadge[]>());
};

const computeTotals = <T extends TotalsSource>(rows: T[]): ActivityTotals =>
  rows.reduce<ActivityTotals>(
    (acc, row) => ({
      active: acc.active + row.activeMinutes,
      idle: acc.idle + row.idleMinutes,
      breaks: acc.breaks + row.breaks,
      breakMinutes: acc.breakMinutes + row.breakMinutes,
      lunches: acc.lunches + row.lunches,
      lunchMinutes: acc.lunchMinutes + row.lunchMinutes,
      presence: acc.presence + row.presenceMisses
    }),
    { active: 0, idle: 0, breaks: 0, breakMinutes: 0, lunches: 0, lunchMinutes: 0, presence: 0 }
  );

const renderTotalsRow = (totals: ActivityTotals, leadingColumns: number) => `
  <tfoot>
    <tr class="totals">
      <th colspan="${leadingColumns}">Totals</th>
      <th>${minutesFormatter(totals.active)}</th>
      <th>${minutesFormatter(totals.idle)}</th>
      <th>${totals.breaks}</th>
      <th>${minutesFormatter(totals.breakMinutes)}</th>
      <th>${totals.lunches}</th>
      <th>${minutesFormatter(totals.lunchMinutes)}</th>
      <th>${totals.presence}</th>
    </tr>
  </tfoot>
`;

const detailLink = (userId: number, dateParam: string, label: string) =>
  `<a href="/dashboard/user/${userId}?date=${dateParam}">${escapeHtml(label)}</a>`;

const buildTodayRow = (row: SessionSummary, dateParam: string, badges: RequestBadge[] = []) => `
  <tr>
    <td>
      ${detailLink(row.userId, dateParam, row.name)}
      ${renderRequestBadges(badges)}
    </td>
    <td>${detailLink(row.userId, dateParam, row.email)}</td>
    <td>${formatDateTime(row.startedAt)}</td>
    <td>${minutesFormatter(row.activeMinutes)}</td>
    <td>${minutesFormatter(row.idleMinutes)}</td>
    <td>${row.breaks}</td>
    <td>${minutesFormatter(row.breakMinutes)}</td>
    <td>${row.lunches}</td>
    <td>${minutesFormatter(row.lunchMinutes)}</td>
    <td>${row.presenceMisses}</td>
  </tr>
`;

const buildWeeklyRow = (row: UserAggregate, index: number, dateParam: string, badges: RequestBadge[] = []) => `
  <tr>
    <td>${index + 1}</td>
    <td>
      ${detailLink(row.userId, dateParam, row.name)}
      ${renderRequestBadges(badges)}
    </td>
    <td>${detailLink(row.userId, dateParam, row.email)}</td>
    <td>${minutesFormatter(row.activeMinutes)}</td>
    <td>${minutesFormatter(row.idleMinutes)}</td>
    <td>${row.breaks}</td>
    <td>${minutesFormatter(row.breakMinutes)}</td>
    <td>${row.lunches}</td>
    <td>${minutesFormatter(row.lunchMinutes)}</td>
    <td>${row.presenceMisses}</td>
  </tr>
`;

const buildDetailRow = (detail: SessionDetail) => `
  <tr>
    <td>${formatDateTime(detail.startedAt)}</td>
    <td>${formatOptionalDate(detail.endedAt)}</td>
    <td>${minutesFormatter(detail.activeMinutes)}</td>
    <td>${minutesFormatter(detail.idleMinutes)}</td>
    <td>${detail.breaks}</td>
    <td>${minutesFormatter(detail.breakMinutes)}</td>
    <td>${detail.lunches}</td>
    <td>${minutesFormatter(detail.lunchMinutes)}</td>
    <td>${detail.presenceMisses}</td>
  </tr>
`;

const pauseLabel = (entry: PauseEntry) => `${entry.type === 'break' ? 'Break' : 'Lunch'} ${entry.sequence}`;

const renderPauseTable = (entries: PauseEntry[]) => {
  if (!entries.length) {
    return '<div class="empty">No breaks or lunches recorded for this range.</div>';
  }

  const rows = entries
    .map((entry) => `
        <tr>
          <td>${detailLink(entry.userId, toDateParam(entry.startedAt), escapeHtml(entry.userName))}</td>
          <td>${escapeHtml(pauseLabel(entry))}</td>
          <td>${formatDateTime(entry.startedAt)}</td>
          <td>${entry.endedAt ? formatDateTime(entry.endedAt) : '—'}</td>
          <td>${minutesFormatter(entry.durationMinutes)}</td>
        </tr>`)
    .join('\n');

  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Pause</th>
            <th>Start</th>
            <th>End</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
};

const computePauseDuration = (pause: { startedAt: Date; endedAt: Date | null; durationMinutes: number | null }, now: Date) =>
  pause.durationMinutes ?? Math.max(0, Math.ceil(((pause.endedAt ?? now).getTime() - pause.startedAt.getTime()) / 60_000));

const summarizePauses = (
  pauses: SessionRecord['pauses'],
  now: Date
): { breakCount: number; breakMinutes: number; lunchCount: number; lunchMinutes: number } => {
  return pauses.reduce(
    (acc, pause) => {
      const duration = computePauseDuration(pause, now);
      if (pause.type === 'break') {
        acc.breakCount += 1;
        acc.breakMinutes += duration;
      } else if (pause.type === 'lunch') {
        acc.lunchCount += 1;
        acc.lunchMinutes += duration;
      }
      return acc;
    },
    { breakCount: 0, breakMinutes: 0, lunchCount: 0, lunchMinutes: 0 }
  );
};

const toSummary = (session: SessionRecord, now: Date): SessionSummary => {
  const activeMinutes = session.minuteStats.filter((m) => m.active).length;
  const idleMinutes = session.minuteStats.filter((m) => m.idle).length;
  const presenceMisses = session.events.filter((event) => event.type === 'presence_miss').length;
  const pauseSummary = summarizePauses(session.pauses, now);

  return {
    userId: session.userId,
    name: session.user.name,
    email: session.user.email,
    startedAt: session.startedAt,
    activeMinutes,
    idleMinutes,
    breaks: pauseSummary.breakCount,
    breakMinutes: pauseSummary.breakMinutes,
    lunches: pauseSummary.lunchCount,
    lunchMinutes: pauseSummary.lunchMinutes,
    presenceMisses
  };
};

const toSessionDetail = (session: SessionRecord, now: Date): SessionDetail => {
  const activeMinutes = session.minuteStats.filter((m) => m.active).length;
  const idleMinutes = session.minuteStats.filter((m) => m.idle).length;
  const presenceMisses = session.events.filter((event) => event.type === 'presence_miss').length;
  const pauseSummary = summarizePauses(session.pauses, now);

  return {
    sessionId: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    activeMinutes,
    idleMinutes,
    breaks: pauseSummary.breakCount,
    breakMinutes: pauseSummary.breakMinutes,
    lunches: pauseSummary.lunchCount,
    lunchMinutes: pauseSummary.lunchMinutes,
    presenceMisses
  };
};

const aggregateSessionsByUser = (sessions: SessionRecord[], now: Date) =>
  sessions.reduce<Map<number, UserAggregate>>((acc, session) => {
    const summary = toSummary(session, now);

    const current = acc.get(session.userId) ?? {
      userId: session.userId,
      name: session.user.name,
      email: session.user.email,
      activeMinutes: 0,
      idleMinutes: 0,
      breaks: 0,
      breakMinutes: 0,
      lunches: 0,
      lunchMinutes: 0,
      presenceMisses: 0
    };

    current.activeMinutes += summary.activeMinutes;
    current.idleMinutes += summary.idleMinutes;
    current.breaks += summary.breaks;
    current.breakMinutes += summary.breakMinutes;
    current.lunches += summary.lunches;
    current.lunchMinutes += summary.lunchMinutes;
    current.presenceMisses += summary.presenceMisses;

    acc.set(session.userId, current);
    return acc;
  }, new Map());

const collectPauseEntries = (sessions: SessionRecord[], now: Date): PauseEntry[] =>
  sessions
    .flatMap((session) =>
      session.pauses
        .filter((pause) => pause.type === 'break' || pause.type === 'lunch')
        .map((pause) => ({
          sessionId: session.id,
          userId: session.userId,
          userName: session.user.name,
          userEmail: session.user.email,
          type: (pause.type === 'break' ? 'break' : 'lunch') as PauseEntry['type'],
        sequence: pause.sequence,
        startedAt: pause.startedAt,
        endedAt: pause.endedAt,
        durationMinutes: computePauseDuration(pause, now)
        }))
    )
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

export const fetchDailySummaries = async (referenceDate: Date) => {
  const dayStart = zonedStartOfDay(referenceDate);
  const dayEnd = zonedEndOfDay(referenceDate);
  const now = new Date();
  const sessions = (await prisma.session.findMany({
    where: {
      startedAt: {
        gte: dayStart,
        lte: dayEnd
      }
    },
    orderBy: { startedAt: 'asc' },
    include: {
      user: true,
      minuteStats: true,
      events: true,
      pauses: true
    }
  })) as SessionRecord[];

  const summaries = sessions
    .filter((session) => session.status === 'active')
    .map((session) => toSummary(session, now))
    .sort((a, b) => b.activeMinutes - a.activeMinutes);

  const requestBadges = await collectRequestBadges(
    Array.from(new Set(summaries.map((summary) => summary.userId))),
    dayStart,
    dayEnd
  );

  const pauses = collectPauseEntries(sessions, now);

  return {
    dayStart,
    dayEnd,
    dateParam: toDateParam(dayStart),
    label: formatFullDate(dayStart),
    summaries,
    totals: computeTotals(summaries),
    requestBadges,
    pauses
  };
};

const fetchWeeklyAggregates = async (startDate: Date) => {
  const windowStart = zonedStartOfDay(startDate);
  const windowEnd = zonedEndOfDay(addDays(windowStart, 6));
  const now = new Date();
  const sessions = (await prisma.session.findMany({
    where: {
      startedAt: {
        gte: windowStart,
        lte: windowEnd
      }
    },
    include: {
      user: true,
      minuteStats: true,
      events: true,
      pauses: true
    }
  })) as SessionRecord[];

  const aggregates = aggregateSessionsByUser(sessions, now);
  const summaries = Array.from(aggregates.values()).sort((a, b) => b.activeMinutes - a.activeMinutes);
  const endDate = addDays(windowStart, 6);

  const requestBadges = await collectRequestBadges(
    Array.from(new Set(summaries.map((summary) => summary.userId))),
    windowStart,
    windowEnd
  );

  return {
    windowStart,
    windowEnd,
    endDate,
    startParam: toDateParam(windowStart),
    label: `${formatFullDate(windowStart)} – ${formatFullDate(endDate)}`,
    summaries,
    totals: computeTotals(summaries),
    requestBadges
  };
};

const fetchMonthlyAggregates = async (reference: Date) => {
  const monthStart = zonedStartOfMonth(reference);
  const monthEnd = zonedEndOfMonth(reference);
  const now = new Date();
  const sessions = (await prisma.session.findMany({
    where: {
      startedAt: {
        gte: monthStart,
        lte: monthEnd
      }
    },
    include: {
      user: true,
      minuteStats: true,
      events: true,
      pauses: true
    }
  })) as SessionRecord[];

  const aggregates = aggregateSessionsByUser(sessions, now);
  const summaries = Array.from(aggregates.values()).sort((a, b) => b.activeMinutes - a.activeMinutes);

  const requestBadges = await collectRequestBadges(
    Array.from(new Set(summaries.map((summary) => summary.userId))),
    monthStart,
    monthEnd
  );

  return {
    monthStart,
    monthEnd,
    monthParam: formatInTimeZone(monthStart, DASHBOARD_TIME_ZONE, 'yyyy-MM'),
    label: formatInTimeZone(monthStart, DASHBOARD_TIME_ZONE, 'LLLL yyyy'),
    summaries,
    totals: computeTotals(summaries),
    requestBadges
  };
};

const baseStyles = `
  :root { color-scheme: light; }
  body { font-family: Arial, sans-serif; margin: 0; padding: clamp(1.5rem, 4vw, 3rem); background: #f5f5f5; color: #1f2933; min-height: 100vh; box-sizing: border-box; }
  h1 { margin-bottom: 0.5rem; }
  h2 { margin-top: 1.5rem; }
  table { width: 100%; border-collapse: collapse; background: #fff; margin-top: 1rem; box-shadow: 0 2px 6px rgba(0,0,0,0.05); }
  th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
  th { background: #eef2ff; }
  tr:hover { background: #f9fafb; }
  .totals th, .totals td { font-weight: 600; background: #e0e7ff; }
  .empty { padding: 2rem; text-align: center; color: #6b7280; background: #fff; border-radius: 6px; margin-top: 1rem; }
  .nav { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .nav a { color: #2563eb; text-decoration: none; font-weight: 500; padding-bottom: 0.25rem; }
  .nav a.active { border-bottom: 2px solid #2563eb; }
  .card { background: #fff; padding: 1.25rem; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-top: 1.5rem; max-width: 100%; }
  .stack-form { display: grid; gap: 0.75rem; max-width: 360px; }
  .stack-form label { display: grid; gap: 0.25rem; font-weight: 600; color: #1f2933; }
  .stack-form input { padding: 0.5rem 0.75rem; border-radius: 8px; border: 1px solid #cbd5f5; font-size: 1rem; }
  .stack-form button { width: fit-content; }
  .inline-form { display: inline; }
  .alert { margin: 1rem 0; padding: 0.75rem 1rem; border-radius: 10px; font-weight: 600; }
  .alert.success { background: #ecfdf5; color: #047857; }
  .alert.error { background: #fef2f2; color: #b91c1c; }
  .actions { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; margin: 1rem 0; }
  .filters { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .filters label { font-size: 0.9rem; color: #374151; display: flex; flex-direction: column; gap: 0.25rem; min-width: 180px; }
  input[type="date"], input[type="month"], select { padding: 0.4rem 0.6rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.95rem; background: #fff; color: #1f2933; }
  button, .button { padding: 0.5rem 1rem; border: none; background: #2563eb; color: #fff; border-radius: 4px; cursor: pointer; font-size: 0.95rem; display: inline-flex; align-items: center; justify-content: center; text-decoration: none; font-weight: 500; }
  button:hover, .button:hover { background: #1d4ed8; text-decoration: none; }
  .button:visited { color: #fff; text-decoration: none; }
  .print-button { background: #6b7280; }
  .print-button:hover { background: #4b5563; }
  .meta { color: #4b5563; margin-bottom: 0.75rem; }
  .tz-note { margin: 0.75rem 0 1.25rem; font-size: 0.9rem; color: #4b5563; }
  a { color: #2563eb; }
  a:hover { text-decoration: underline; }
  .no-print { }
  .tab-bar { display: flex; gap: 0.5rem; margin: 1rem 0; }
  .tab-bar a { padding: 0.4rem 0.8rem; border-radius: 4px; background: #e5e7eb; color: #1f2933; text-decoration: none; font-weight: 500; }
  .tab-bar a.active { background: #2563eb; color: #fff; }
  .tab-content { margin-top: 1.5rem; }
  .tab-content.hidden { display: none; }
  .badges { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.35rem; }
  .badge { display: inline-flex; align-items: center; padding: 0.15rem 0.45rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; background: #e5e7eb; color: #111827; border: 1px solid transparent; }
  .badge-pto { background: #fef3c7; color: #92400e; }
  .badge-non_pto { background: #dbeafe; color: #1e3a8a; }
  .badge-status-pending { border-style: dashed; border-color: currentColor; }
  .badge-status-approved { border-color: rgba(0,0,0,0.05); }
  .badge-status-denied { opacity: 0.6; text-decoration: line-through; }
  .action-buttons { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .action-buttons form { margin: 0; }
  .inline-form { display: inline; }
  .button-danger { background: #dc2626; color: #fff; }
  .button-danger:hover { background: #b91c1c; }
  .button-secondary { background: #6b7280; color: #fff; }
  .button-secondary:hover { background: #4b5563; }
  .summary-cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin: 1.5rem 0; }
  .summary-card { background: #fff; padding: 1rem; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.05); }
  .summary-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 0.25rem; }
  .summary-value { font-size: 1.6rem; font-weight: 700; color: #1f2933; }
  .summary-meta { font-size: 0.8rem; color: #6b7280; margin-top: 0.25rem; }
  .timesheet-request-form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .timesheet-request-form select,
  .timesheet-request-form input[type="text"] { padding: 0.3rem 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.85rem; }
  .timesheet-request-form button { padding: 0.4rem 0.9rem; }
  .muted { color: #6b7280; font-size: 0.8rem; }
  .table-scroll { overflow-x: auto; max-width: 100%; }
  .table-scroll table { min-width: 720px; }
  .balances-detail { margin-top: 2rem; background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(15,23,42,0.05); }
  .balances-detail h2 { margin-top: 0; }
  .balances-detail-actions { gap: 0.5rem; flex-wrap: wrap; }
  dialog { border: none; border-radius: 8px; padding: 1.5rem; max-width: 420px; width: min(420px, 100%); }
  dialog:not([open]) { display: none; }
  dialog::backdrop { background: rgba(15, 23, 42, 0.4); }
  #adjust-form label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem; font-weight: 500; color: #374151; margin-top: 1rem; }
  #adjust-form input[type="number"], #adjust-form textarea { padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.95rem; }
  #adjust-form textarea { resize: vertical; min-height: 120px; }
  .dialog-meta { font-size: 0.85rem; color: #4b5563; margin-top: 0.5rem; }
  .dialog-error { color: #b91c1c; font-size: 0.85rem; min-height: 1.25rem; margin-top: 0.75rem; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.5rem; }
  .ledger-table td:nth-child(2),
  .ledger-table th:nth-child(2),
  .ledger-table td:nth-child(3),
  .ledger-table th:nth-child(3) { text-align: right; white-space: nowrap; }
  .hidden { display: none !important; }
  .highlight-row { background: #f0f9ff; }
  @media (max-width: 1024px) {
    body { padding: clamp(1rem, 5vw, 2rem); }
    .summary-cards { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .table-scroll table { min-width: 600px; }
  }
  @media (max-width: 768px) {
    .actions { flex-direction: column; align-items: stretch; }
    .filters { flex-direction: column; align-items: stretch; }
    .filters label { width: 100%; }
    button, .button { width: fit-content; }
    .table-scroll table { min-width: 520px; }
    .balances-detail { padding: 1rem; }
  }
  @media (max-width: 640px) {
    body { padding: clamp(0.75rem, 6vw, 1.5rem); }
    table { margin-top: 0.75rem; }
    th, td { padding: 0.6rem; }
    .table-scroll table { min-width: 420px; }
  }
  @media print {
    body { margin: 0.5in; background: #fff; color: #111827; }
    table { box-shadow: none; }
    .no-print { display: none !important; }
  }
`;

const formatRangeLabel = (start: Date, end?: Date) =>
  end && end.getTime() !== start.getTime() ? `${formatFullDate(start)} – ${formatFullDate(end)}` : formatFullDate(start);

const renderTimezoneNote = (start: Date, end?: Date) =>
  `<p class="tz-note">All times shown in ${escapeHtml(DASHBOARD_TIME_ZONE)} (${escapeHtml(formatRangeLabel(start, end))})</p>`;

type NavKey =
  | 'overview'
  | 'today'
  | 'weekly'
  | 'monthly'
  | 'timesheets'
  | 'user'
  | 'requests'
  | 'balances'
  | 'settings';

const renderNav = (active: NavKey) => {
  const link = (href: string, label: string, key: NavKey) =>
    `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`;
  return `<nav class="nav no-print">${[
    link('/dashboard/overview', 'Overview', 'overview'),
    link('/dashboard/today', 'Today', 'today'),
    link('/dashboard/weekly', 'Weekly', 'weekly'),
    link('/dashboard/monthly', 'Monthly', 'monthly'),
    link('/dashboard/timesheets', 'Timesheets', 'timesheets'),
    link('/dashboard/requests', 'Requests', 'requests'),
    link('/dashboard/balances', 'Balances', 'balances'),
    link('/dashboard/settings', 'Settings', 'settings')
  ].join('')}</nav>`;
};

const setDashboardTokenCookie = (res: Response, token: string) => {
  res.cookie(DASHBOARD_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: DASHBOARD_COOKIE_MAX_AGE_MS,
    path: DASHBOARD_COOKIE_PATH
  });
};

const clearDashboardTokenCookie = (res: Response) => {
  res.cookie(DASHBOARD_TOKEN_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: 0,
    path: DASHBOARD_COOKIE_PATH
  });
};

const runMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  handler: (req: AuthenticatedRequest, res: Response, next: NextFunction) => void
) =>
  new Promise<void>((resolve, reject) => {
    handler(req, res, (err?: unknown) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

const adminRoleMiddleware = requireRole(['admin', 'manager']);

const ensureDashboardAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthenticatedRequest;
  try {
    await runMiddleware(authReq, res, authenticate);
    await runMiddleware(authReq, res, adminRoleMiddleware);
    return next();
  } catch (error) {
    if (error instanceof HttpError && isHtmlRequest(req)) {
      if (error.statusCode === 401) {
        clearDashboardTokenCookie(res);
        const redirectTarget = sanitizeRedirect(req.originalUrl ?? DEFAULT_DASHBOARD_REDIRECT);
        const params = new URLSearchParams({ message: 'session_expired' });
        if (redirectTarget && redirectTarget !== DEFAULT_DASHBOARD_REDIRECT) {
          params.set('redirect', redirectTarget);
        }
        return res.redirect(`${DASHBOARD_LOGIN_ROUTE}?${params.toString()}`);
      }
      if (error.statusCode === 403) {
        clearDashboardTokenCookie(res);
        const params = new URLSearchParams({ error: 'forbidden' });
        return res.redirect(`${DASHBOARD_LOGIN_ROUTE}?${params.toString()}`);
      }
    }
    return next(error);
  }
};

export const dashboardRouter = Router();

// Dev-only bypass for local debugging. Set DASHBOARD_ALLOW_ANON=true to skip auth.
const allowAnonDashboard = process.env.DASHBOARD_ALLOW_ANON === 'true';
if (!allowAnonDashboard) {
  dashboardRouter.get(
    '/login',
    asyncHandler(async (req, res) => {
      const redirectTo = sanitizeRedirect(req.query.redirect);
      const token = extractTokenFromRequest(req);

      if (token) {
        try {
          const { user } = await resolveUserFromToken(token);
          if (isDashboardRole(user.role)) {
            return res.redirect(redirectTo);
          }
          clearDashboardTokenCookie(res);
        } catch {
          clearDashboardTokenCookie(res);
        }
      }

      const errorCode = typeof req.query.error === 'string' ? req.query.error : undefined;
      const messageCode = typeof req.query.message === 'string' ? req.query.message : undefined;

      res.type('text/html').send(
        renderLoginPage({
          redirectTo,
          errorCode,
          messageCode
        })
      );
    })
  );

  dashboardRouter.post(
    '/login',
    asyncHandler(async (req, res) => {
      const parsed = loginFormSchema.safeParse(req.body ?? {});
      const redirectTo = sanitizeRedirect(parsed.success ? parsed.data.redirect : req.body?.redirect);
      const emailInput = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

      if (!parsed.success) {
        return res
          .status(400)
          .type('text/html')
          .send(renderLoginPage({ redirectTo, email: emailInput, errorCode: 'invalid' }));
      }

      const normalizedEmail = parsed.data.email.trim();
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

      if (!user || !isDashboardRole(user.role)) {
        return res
          .status(401)
          .type('text/html')
          .send(renderLoginPage({ redirectTo, email: emailInput, errorCode: 'invalid' }));
      }

      const passwordOk = await verifyPassword(parsed.data.password, user.passwordHash);
      if (!passwordOk) {
        return res
          .status(401)
          .type('text/html')
          .send(renderLoginPage({ redirectTo, email: emailInput, errorCode: 'invalid' }));
      }

      const token = generateToken(user);
      setDashboardTokenCookie(res, token);

      return res.redirect(redirectTo);
    })
  );

  dashboardRouter.post(
    '/logout',
    (req, res) => {
      clearDashboardTokenCookie(res);
      const redirectTo = sanitizeRedirect(req.body?.redirect ?? req.query.redirect);
      const params = new URLSearchParams({ message: 'logged_out' });
      if (redirectTo && redirectTo !== DEFAULT_DASHBOARD_REDIRECT) {
        params.set('redirect', redirectTo);
      }
      res.redirect(`${DASHBOARD_LOGIN_ROUTE}?${params.toString()}`);
    }
  );

  dashboardRouter.use((req, res, next) => ensureDashboardAuthenticated(req, res, next));
} else {
  // no-op auth in dev
  dashboardRouter.use((req, _res, next) => next());
}

dashboardRouter.get('/', (_req, res) => {
  res.redirect(DEFAULT_DASHBOARD_REDIRECT);
});
dashboardRouter.get('/today', async (req, res) => {
  const requestedDate = typeof req.query.date === 'string' ? parseDateParam(req.query.date) : zonedStartOfDay(new Date());
  const dailyData = await fetchDailySummaries(requestedDate);
  const { dayStart, dayEnd, dateParam, label, summaries, totals, requestBadges, pauses } = dailyData;

  const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
  if (wantsCsv) {
    const header = [
      'Name',
      'Email',
      'Started At ISO',
      'Active Minutes',
      'Idle Minutes',
      'Breaks',
      'Break Minutes',
      'Lunches',
      'Lunch Minutes',
      'Presence Misses',
      'Timezone'
    ];
    const rows = summaries.map((summary) =>
      [
        escapeCsv(summary.name),
        escapeCsv(summary.email),
        escapeCsv(formatIsoDateTime(summary.startedAt)),
        escapeCsv(summary.activeMinutes),
        escapeCsv(summary.idleMinutes),
        escapeCsv(summary.breaks),
        escapeCsv(summary.breakMinutes),
        escapeCsv(summary.lunches),
        escapeCsv(summary.lunchMinutes),
        escapeCsv(summary.presenceMisses),
        escapeCsv(DASHBOARD_TIME_ZONE)
      ].join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="today-${dateParam}.csv"`);
    return res.send(csv);
  }

  const tableRows = summaries
    .map((summary) => buildTodayRow(summary, dateParam, requestBadges.get(summary.userId) ?? []))
    .join('\n');
  const totalsRow = renderTotalsRow(totals, 3);

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Attendance Dashboard – ${dateParam}</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('today')}
        ${renderTimezoneNote(dayStart, dayEnd)}
        <h1>Sessions for ${label}</h1>
        <div class="actions no-print">
          <form method="get" action="/dashboard/today" class="filters">
            <label>
              <span>Date</span>
              <input type="date" name="date" value="${dateParam}" />
            </label>
            <button type="submit">Apply</button>
          </form>
          <form method="get" action="/dashboard/today">
            <input type="hidden" name="date" value="${dateParam}" />
            <input type="hidden" name="download" value="csv" />
            <button type="submit">Download CSV</button>
          </form>
          <button type="button" class="print-button" onclick="window.print()">Print</button>
        </div>
        ${
          tableRows
            ? `<div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Email</th>
                      <th>Started At</th>
                      <th>Active Minutes</th>
                      <th>Idle Minutes</th>
                      <th>Breaks</th>
                      <th>Break Minutes</th>
                      <th>Lunches</th>
                      <th>Lunch Minutes</th>
                      <th>Presence Misses</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                  ${totalsRow}
                </table>
              </div>`
            : '<div class="empty">No sessions recorded for this date.</div>'
        }
        <section class="card">
          <h2>Breaks and Lunches</h2>
          ${renderPauseTable(pauses)}
        </section>
      </body>
    </html>
  `;

  res.type('html').send(html);
});

dashboardRouter.get('/weekly', async (req, res) => {
  const today = zonedStartOfDay(new Date());
  const baseStart = typeof req.query.start === 'string' ? parseDateParam(req.query.start) : subDays(today, 6);
  const weeklyData = await fetchWeeklyAggregates(baseStart);
  const { windowStart, windowEnd, startParam, label, summaries, totals, requestBadges } = weeklyData;

  const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
  if (wantsCsv) {
    const header = [
      'Name',
      'Email',
      'Active Minutes',
      'Idle Minutes',
      'Breaks',
      'Break Minutes',
      'Lunches',
      'Lunch Minutes',
      'Presence Misses',
      'Range Start ISO',
      'Range End ISO',
      'Timezone'
    ];
    const rows = summaries.map((summary) =>
      [
        escapeCsv(summary.name),
        escapeCsv(summary.email),
        escapeCsv(summary.activeMinutes),
        escapeCsv(summary.idleMinutes),
        escapeCsv(summary.breaks),
        escapeCsv(summary.breakMinutes),
        escapeCsv(summary.lunches),
        escapeCsv(summary.lunchMinutes),
        escapeCsv(summary.presenceMisses),
        escapeCsv(formatIsoDate(windowStart)),
        escapeCsv(formatIsoDate(windowEnd)),
        escapeCsv(DASHBOARD_TIME_ZONE)
      ].join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="weekly-${startParam}.csv"`);
    return res.send(csv);
  }

  const tableRows = summaries
    .map((summary, index) => buildWeeklyRow(summary, index, startParam, requestBadges.get(summary.userId) ?? []))
    .join('\n');
  const totalsRow = renderTotalsRow(totals, 3);

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Weekly Attendance Summary</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('weekly')}
        ${renderTimezoneNote(windowStart, windowEnd)}
        <h1>Weekly Summary</h1>
        <div class="actions no-print">
          <form method="get" action="/dashboard/weekly" class="filters">
            <label>
              <span>Week starting</span>
              <input type="date" name="start" value="${startParam}" />
            </label>
            <button type="submit">Apply</button>
          </form>
          <form method="get" action="/dashboard/weekly">
            <input type="hidden" name="start" value="${startParam}" />
            <input type="hidden" name="download" value="csv" />
            <button type="submit">Download CSV</button>
          </form>
          <button type="button" class="print-button" onclick="window.print()">Print</button>
        </div>
        <h2>${label}</h2>
        ${
          tableRows
            ? `<div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>User</th>
                    <th>Email</th>
                    <th>Active Minutes</th>
                    <th>Idle Minutes</th>
                    <th>Breaks</th>
                    <th>Break Minutes</th>
                    <th>Lunches</th>
                    <th>Lunch Minutes</th>
                    <th>Presence Misses</th>
                  </tr>
                </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                  ${totalsRow}
                </table>
              </div>`
            : '<div class="empty">No activity recorded for this range.</div>'
        }
      </body>
    </html>
  `;

  res.type('html').send(html);
});

dashboardRouter.get('/monthly', async (req, res) => {
  const reference = parseMonthParam(req.query.month);
  const monthlyData = await fetchMonthlyAggregates(reference);
  const { monthStart, monthEnd, monthParam, label, summaries, totals, requestBadges } = monthlyData;

  const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
  if (wantsCsv) {
    const header = [
      'Name',
      'Email',
      'Active Minutes',
      'Idle Minutes',
      'Breaks',
      'Break Minutes',
      'Lunches',
      'Lunch Minutes',
      'Presence Misses',
      'Range Start ISO',
      'Range End ISO',
      'Timezone'
    ];
    const rows = summaries.map((summary) =>
      [
        escapeCsv(summary.name),
        escapeCsv(summary.email),
        escapeCsv(summary.activeMinutes),
        escapeCsv(summary.idleMinutes),
        escapeCsv(summary.breaks),
        escapeCsv(summary.breakMinutes),
        escapeCsv(summary.lunches),
        escapeCsv(summary.lunchMinutes),
        escapeCsv(summary.presenceMisses),
        escapeCsv(formatIsoDate(monthStart)),
        escapeCsv(formatIsoDate(monthEnd)),
        escapeCsv(DASHBOARD_TIME_ZONE)
      ].join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="monthly-${monthParam}.csv"`);
    return res.send(csv);
  }

  const tableRows = summaries
    .map((summary, index) =>
      buildWeeklyRow(summary, index, formatIsoDate(monthStart), requestBadges.get(summary.userId) ?? [])
    )
    .join('\n');
  const totalsRow = renderTotalsRow(totals, 3);

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${label} Attendance Summary</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('monthly')}
        ${renderTimezoneNote(monthStart, monthEnd)}
        <h1>${label}</h1>
        <div class="actions no-print">
          <form method="get" action="/dashboard/monthly" class="filters">
            <label>
              <span>Month</span>
              <input type="month" name="month" value="${monthParam}" />
            </label>
            <button type="submit">Apply</button>
          </form>
          <form method="get" action="/dashboard/monthly">
            <input type="hidden" name="month" value="${monthParam}" />
            <input type="hidden" name="download" value="csv" />
            <button type="submit">Download CSV</button>
          </form>
          <button type="button" class="print-button" onclick="window.print()">Print</button>
        </div>
        ${
          tableRows
            ? `<div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>User</th>
                      <th>Email</th>
                      <th>Active Minutes</th>
                      <th>Idle Minutes</th>
                      <th>Breaks</th>
                      <th>Break Minutes</th>
                      <th>Lunches</th>
                      <th>Lunch Minutes</th>
                      <th>Presence Misses</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                  ${totalsRow}
                </table>
              </div>`
            : '<div class="empty">No activity recorded for this month.</div>'
        }
      </body>
    </html>
  `;

  res.type('html').send(html);
});

dashboardRouter.get(
  '/timesheets',
  asyncHandler(async (req, res) => {
    const rawView = typeof req.query.view === 'string' ? req.query.view : undefined;
    const normalizedView: TimesheetView = rawView && (TIMESHEET_VIEWS as readonly string[]).includes(rawView as TimesheetView)
      ? (rawView as TimesheetView)
      : 'pay_period';

    const rawDate = typeof req.query.date === 'string' ? req.query.date : '';
    const rawMonth = typeof req.query.month === 'string' ? req.query.month : '';
    const message = typeof req.query.message === 'string' ? req.query.message : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';

    const reference = normalizedView === 'monthly' ? parseMonthParam(rawMonth || rawDate) : parseDateParam(rawDate);
    const range = computeTimesheetRange(normalizedView, reference);

    const dateValue = normalizedView === 'monthly' ? rawDate : rawDate || toDateParam(range.start);
    const monthValue = normalizedView === 'monthly'
      ? rawMonth || formatInTimeZone(range.start, DASHBOARD_TIME_ZONE, 'yyyy-MM')
      : rawMonth;

    const employees = await prisma.user.findMany({
      where: { role: 'employee' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, active: true }
    });

    const summaries = await Promise.all(
      employees.map(async (employee) => ({
        employee,
        summary: await getUserTimesheet(employee.id, normalizedView, reference)
      }))
    );

    const aggregate = summaries.reduce(
      (acc, entry) => ({
        activeMinutes: acc.activeMinutes + entry.summary.totals.activeMinutes,
        idleMinutes: acc.idleMinutes + entry.summary.totals.idleMinutes,
        breaks: acc.breaks + entry.summary.totals.breaks,
        lunches: acc.lunches + entry.summary.totals.lunches,
        presence: acc.presence + entry.summary.totals.presenceMisses
      }),
      { activeMinutes: 0, idleMinutes: 0, breaks: 0, lunches: 0, presence: 0 }
    );

    const aggregateCards = summaries.length
      ? `
          <div class="summary-cards">
            <div class="summary-card">
              <div class="summary-title">Active Hours</div>
              <div class="summary-value">${formatHoursFromMinutes(aggregate.activeMinutes)}</div>
              <div class="summary-meta">${aggregate.activeMinutes} minutes</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Idle Hours</div>
              <div class="summary-value">${formatHoursFromMinutes(aggregate.idleMinutes)}</div>
              <div class="summary-meta">${aggregate.idleMinutes} minutes</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Breaks</div>
              <div class="summary-value">${aggregate.breaks}</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Lunches</div>
              <div class="summary-value">${aggregate.lunches}</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Presence Misses</div>
              <div class="summary-value">${aggregate.presence}</div>
            </div>
          </div>
        `
      : '';

    const employeeSections = summaries.length
      ? summaries
          .map(({ employee, summary }) => {
            const dayRows = summary.days.length
              ? summary.days
                  .map((day) => {
                    const requestsText = day.editRequests.length
                      ? day.editRequests.map((req) => formatTimesheetStatus(req.status)).join(', ')
                      : '—';
                    return `
                      <tr>
                        <td>${escapeHtml(day.label)}</td>
                        <td>${formatHoursFromMinutes(day.activeMinutes)}</td>
                        <td>${formatHoursFromMinutes(day.idleMinutes)}</td>
                        <td>${day.breaks}</td>
                        <td>${day.lunches}</td>
                        <td>${day.presenceMisses}</td>
                        <td>${escapeHtml(requestsText)}</td>
                      </tr>
                    `;
                  })
                  .join('\n')
              : '<tr><td colspan="7" class="empty">No activity recorded for this range.</td></tr>';

            const employeeStatus = employee.active ? '' : ' <span class="muted">(Inactive)</span>';

            return `
              <section class="card">
                <h2>${escapeHtml(employee.name ?? 'Employee')}${employeeStatus}</h2>
                <div class="meta">${escapeHtml(employee.email)}</div>
                <div class="summary-cards">
                  <div class="summary-card">
                    <div class="summary-title">Active Hours</div>
                    <div class="summary-value">${formatHoursFromMinutes(summary.totals.activeMinutes)}</div>
                    <div class="summary-meta">${summary.totals.activeMinutes} minutes</div>
                  </div>
                  <div class="summary-card">
                    <div class="summary-title">Idle Hours</div>
                    <div class="summary-value">${formatHoursFromMinutes(summary.totals.idleMinutes)}</div>
                    <div class="summary-meta">${summary.totals.idleMinutes} minutes</div>
                  </div>
                  <div class="summary-card">
                    <div class="summary-title">Breaks</div>
                    <div class="summary-value">${summary.totals.breaks}</div>
                  </div>
                  <div class="summary-card">
                    <div class="summary-title">Lunches</div>
                    <div class="summary-value">${summary.totals.lunches}</div>
                  </div>
                  <div class="summary-card">
                    <div class="summary-title">Presence Misses</div>
                    <div class="summary-value">${summary.totals.presenceMisses}</div>
                  </div>
                </div>
                <div class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Active Hours</th>
                        <th>Idle Hours</th>
                        <th>Breaks</th>
                        <th>Lunches</th>
                        <th>Presence</th>
                        <th>Edit Requests</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${dayRows}
                    </tbody>
                  </table>
                </div>
              </section>
            `;
          })
          .join('\n')
      : '<section class="card"><div class="empty">No employees found.</div></section>';

    const editRequests = await prisma.timesheetEditRequest.findMany({
      where: {
        view: normalizedView,
        periodStart: range.start,
        periodEnd: range.end
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        reviewer: { select: { id: true, name: true, email: true } }
      }
    });

    const requestRows = editRequests.length
      ? editRequests
          .map((request) => {
            const requestedHours = request.requestedMinutes ? formatHoursFromMinutes(request.requestedMinutes) : '—';
            return `
              <tr>
                <td>${formatFullDate(request.targetDate)}</td>
                <td>
                  ${escapeHtml(request.user?.name ?? 'Unknown')}
                  <div class="muted">${escapeHtml(request.user?.email ?? '')}</div>
                </td>
                <td>${formatTimesheetStatus(request.status)}</td>
                <td>${escapeHtml(request.reason)}</td>
                <td>${requestedHours}</td>
                <td>${request.reviewedAt ? formatDateTime(request.reviewedAt) : '—'}</td>
                <td>
                  <form method="post" action="/dashboard/timesheets/requests/${request.id}" class="timesheet-request-form">
                    <input type="hidden" name="view" value="${escapeHtml(normalizedView)}" />
                    <input type="hidden" name="date" value="${escapeHtml(dateValue)}" />
                    <input type="hidden" name="month" value="${escapeHtml(monthValue)}" />
                    <select name="status">
                      ${TIMESHEET_EDIT_STATUSES.map(
                        (value) =>
                          `<option value="${value}"${request.status === value ? ' selected' : ''}>${formatTimesheetStatus(value)}</option>`
                      ).join('')}
                    </select>
                    <input type="text" name="adminNote" placeholder="Note" value="${escapeHtml(request.adminNote ?? '')}" />
                    <button type="submit">Save</button>
                  </form>
                </td>
              </tr>
            `;
          })
          .join('\n')
      : '<tr><td colspan="7" class="empty">No edit requests for this range.</td></tr>';

    const currentViewLabel = timesheetViewLabel(normalizedView);
    const viewOptions = (TIMESHEET_VIEWS as readonly TimesheetView[])
      .map((value) => `<option value="${value}"${value === normalizedView ? ' selected' : ''}>${escapeHtml(timesheetViewLabel(value))}</option>`)
      .join('');

    const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Timesheet Review</title>
          <style>${baseStyles}</style>
        </head>
        <body>
          ${renderNav('timesheets')}
          ${renderTimezoneNote(range.start, range.end)}
          <h1>Timesheet Review</h1>
          ${message ? `<div class="alert success no-print">${escapeHtml(message)}</div>` : ''}
          ${error ? `<div class="alert error no-print">${escapeHtml(error)}</div>` : ''}
          <section class="card no-print">
            <h2>Filters</h2>
            <form method="get" class="filters">
              <label>
                <span>View</span>
                <select name="view">${viewOptions}</select>
              </label>
              <label>
                <span>Date (weekly/pay period)</span>
                <input type="date" name="date" value="${escapeHtml(dateValue)}" />
              </label>
              <label>
                <span>Month (monthly)</span>
                <input type="month" name="month" value="${escapeHtml(monthValue)}" />
              </label>
              <button type="submit">Apply</button>
            </form>
            <div class="meta">Viewing ${escapeHtml(currentViewLabel)} • ${escapeHtml(range.label)}</div>
          </section>
          ${aggregateCards}
          ${employeeSections}
          <section class="card">
            <h2>Edit Requests</h2>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Employee</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Requested Hours</th>
                    <th>Reviewed</th>
                    <th>Update</th>
                  </tr>
                </thead>
                <tbody>
                  ${requestRows}
                </tbody>
              </table>
            </div>
          </section>
        </body>
      </html>
    `;

    res.type('html').send(html);
  })
);

dashboardRouter.post(
  '/timesheets/requests/:id',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const { status, adminNote, view, date, month } = req.body ?? {};

    const params = new URLSearchParams();
    if (typeof view === 'string' && view) {
      params.set('view', view);
    }
    if (typeof date === 'string' && date) {
      params.set('date', date);
    }
    if (typeof month === 'string' && month) {
      params.set('month', month);
    }

    const baseUrl = params.size ? `/dashboard/timesheets?${params.toString()}` : '/dashboard/timesheets';

    if (typeof status !== 'string' || !(TIMESHEET_EDIT_STATUSES as readonly string[]).includes(status as TimesheetEditStatus)) {
      const redirect = params.size ? `${baseUrl}&error=${encodeURIComponent('Invalid status')}` : `${baseUrl}?error=${encodeURIComponent('Invalid status')}`;
      return res.redirect(redirect);
    }

    const request = await prisma.timesheetEditRequest.findUnique({ where: { id } });
    if (!request) {
      const redirect = params.size ? `${baseUrl}&error=${encodeURIComponent('Request not found')}` : `${baseUrl}?error=${encodeURIComponent('Request not found')}`;
      return res.redirect(redirect);
    }

    const trimmedNote = typeof adminNote === 'string' ? adminNote.trim() : '';

    const updates: Prisma.TimesheetEditRequestUpdateInput = {
      status,
      adminNote: trimmedNote.length ? trimmedNote : null
    };

    if (status === 'pending') {
      updates.reviewedAt = null;
      updates.reviewer = { disconnect: true };
    } else {
      updates.reviewedAt = new Date();
      updates.reviewer = { connect: { id: req.user!.id } };
    }

    await prisma.timesheetEditRequest.update({ where: { id }, data: updates });

    const redirect = params.size ? `${baseUrl}&message=${encodeURIComponent('Request updated.')}` : `${baseUrl}?message=${encodeURIComponent('Request updated.')}`;
    return res.redirect(redirect);
  })
);


dashboardRouter.get('/requests', async (req, res) => {
  const statusParamRaw = typeof req.query.status === 'string' ? req.query.status.toLowerCase() : '';
  const typeParamRaw = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : '';
  const fromDate = parseDateOnlyParam(req.query.from);
  const toDate = parseDateOnlyParam(req.query.to);

  const selectedStatus = TIME_REQUEST_STATUSES.find((status) => status === statusParamRaw) as TimeRequestStatus | undefined;
  const selectedType = TIME_REQUEST_TYPES.find((type) => type === typeParamRaw) as TimeRequestType | undefined;

  const filters: Prisma.TimeRequestWhereInput = {};
  const rangeConditions: Prisma.TimeRequestWhereInput[] = [];

  if (selectedStatus) {
    filters.status = selectedStatus;
  }

  if (selectedType) {
    filters.type = selectedType;
  }

  if (fromDate) {
    rangeConditions.push({ endDate: { gte: zonedStartOfDay(fromDate) } });
  }

  if (toDate) {
    rangeConditions.push({ startDate: { lte: zonedEndOfDay(toDate) } });
  }

  if (rangeConditions.length) {
    const existingAnd = filters.AND;
    const normalized = Array.isArray(existingAnd) ? existingAnd : existingAnd ? [existingAnd] : [];
    filters.AND = [...normalized, ...rangeConditions];
  }

  const requests = await prisma.timeRequest.findMany({
    where: filters,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, name: true, email: true } },
      approver: { select: { id: true, name: true, email: true } }
    }
  });

  const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
  if (wantsCsv) {
    const header = [
      'Created At ISO',
      'Name',
      'Email',
      'Type',
      'Status',
      'Start Date ISO',
      'End Date ISO',
      'Hours',
      'Reason',
      'Approver Name',
      'Approver Email',
      'Timezone'
    ];
    const rows = requests.map((request) =>
      [
        escapeCsv(formatIsoDateTime(request.createdAt)),
        escapeCsv(request.user.name),
        escapeCsv(request.user.email),
        escapeCsv(request.type),
        escapeCsv(request.status),
        escapeCsv(formatIsoDate(request.startDate)),
        escapeCsv(formatIsoDate(request.endDate)),
        escapeCsv(formatHours(request.hours)),
        escapeCsv(request.reason ?? ''),
        escapeCsv(request.approver?.name ?? ''),
        escapeCsv(request.approver?.email ?? ''),
        escapeCsv(DASHBOARD_TIME_ZONE)
      ].join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="time-requests.csv"');
    return res.send(csv);
  }

  const makeUpUserIds = Array.from(
    new Set(requests.filter((request) => request.type === 'make_up').map((request) => request.userId))
  );
  const makeupCap = makeUpUserIds.length ? await getMakeupCapHoursPerMonth() : undefined;
  const makeupUsage = makeUpUserIds.length
    ? await getApprovedMakeupHoursThisMonthByUser(prisma, makeUpUserIds)
    : new Map<number, number>();

  const statusValue = selectedStatus ?? '';
  const typeValue = selectedType ?? '';
  const fromValue = fromDate ? toDateParam(fromDate) : '';
  const toValue = toDate ? toDateParam(toDate) : '';

  const statusOptions = [
    { value: '', label: 'All Statuses' },
    ...TIME_REQUEST_STATUSES.map((value) => ({ value, label: requestStatusLabels[value] }))
  ];
  const typeOptions = [
    { value: '', label: 'All Types' },
    ...TIME_REQUEST_TYPES.map((value) => ({ value, label: requestTypeLabels[value] }))
  ];

  const tableRows = requests
    .map((request) => {
      const typeLabel = requestTypeLabels[request.type as TimeRequestType];
      const statusLabel = requestStatusLabels[request.status as TimeRequestStatus];
      const typeBadge = `<span class="badge badge-${request.type}">${escapeHtml(typeLabel)}</span>`;
      const statusBadge = `<span class="badge badge-status-${request.status}">${escapeHtml(statusLabel)}</span>`;
      const rangeLabel = `${formatShortDate(request.startDate)} – ${formatShortDate(request.endDate)}`;
      const approverLabel = request.approver
        ? `${escapeHtml(request.approver.name)}<div class="meta">${escapeHtml(request.approver.email)}</div>`
        : '—';
      const hoursMeta =
        request.type === 'make_up' && makeupCap !== undefined
          ? (() => {
              const usedHours = makeupUsage.get(request.userId) ?? 0;
              const remaining = remainingHoursWithinCap(usedHours, makeupCap);
              const usedLabel = `${formatHours(usedHours)}h`;
              const remainingLabel = `${formatHours(remaining)}h`;
              return `<div class="meta">Used/Remaining this month: ${escapeHtml(usedLabel)} / ${escapeHtml(remainingLabel)}</div>`;
            })()
          : '';
      const actions =
        request.status === 'pending'
          ? `<div class="action-buttons">
              <form method="post" action="/api/time-requests/${request.id}/approve" class="inline-form">
                <button type="submit">Approve</button>
              </form>
              <form method="post" action="/api/time-requests/${request.id}/deny" class="inline-form">
                <button type="submit" class="button-danger">Deny</button>
              </form>
            </div>`
          : '<span class="meta">Processed</span>';
      return `<tr>
        <td>${formatDateTime(request.createdAt)}</td>
        <td>
          ${escapeHtml(request.user.name)}
          <div class="meta">${escapeHtml(request.user.email)}</div>
          <div class="meta"><a href="/dashboard/balances?userId=${request.user.id}">Balance history</a></div>
        </td>
        <td>${typeBadge}</td>
        <td>${statusBadge}</td>
        <td>${rangeLabel}</td>
        <td>${formatHours(request.hours)}${hoursMeta}</td>
        <td>${request.reason ? escapeHtml(request.reason) : '—'}</td>
        <td>${approverLabel}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('\n');

  const rangeStartForNote = fromDate ?? (requests.length ? zonedStartOfDay(requests[requests.length - 1].startDate) : zonedStartOfDay(new Date()));
  const rangeEndForNote = toDate ?? (requests.length ? zonedEndOfDay(requests[0].endDate) : zonedEndOfDay(new Date()));

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Time Requests</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('requests')}
        ${renderTimezoneNote(rangeStartForNote, rangeEndForNote)}
        <h1>Time Requests</h1>
        <div class="meta">Showing ${requests.length} ${requests.length === 1 ? 'request' : 'requests'}.</div>
        <div class="actions no-print">
          <form method="get" action="/dashboard/requests" class="filters">
            <label>
              <span>Status</span>
              <select name="status">
                ${buildSelectOptions(statusOptions, statusValue)}
              </select>
            </label>
            <label>
              <span>Type</span>
              <select name="type">
                ${buildSelectOptions(typeOptions, typeValue)}
              </select>
            </label>
            <label>
              <span>From</span>
              <input type="date" name="from" value="${fromValue}" />
            </label>
            <label>
              <span>To</span>
              <input type="date" name="to" value="${toValue}" />
            </label>
            <button type="submit">Apply</button>
          </form>
          <form method="get" action="/dashboard/requests">
            <input type="hidden" name="status" value="${statusValue}" />
            <input type="hidden" name="type" value="${typeValue}" />
            <input type="hidden" name="from" value="${fromValue}" />
            <input type="hidden" name="to" value="${toValue}" />
            <input type="hidden" name="download" value="csv" />
            <button type="submit">Download CSV</button>
          </form>
        </div>
        ${
          requests.length
            ? `<div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Submitted</th>
                      <th>Employee</th>
                      <th>Type</th>
                    <th>Status</th>
                    <th>Date Range</th>
                    <th>Hours</th>
                    <th>Reason</th>
                    <th>Approver</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                </table>
              </div>`
            : '<div class="empty">No requests match the selected filters.</div>'
        }
      </body>
    </html>
  `;

  res.type('html').send(html);
});

dashboardRouter.get('/overview', async (req, res) => {
  const viewParam = typeof req.query.view === 'string' ? req.query.view.toLowerCase() : 'today';
  const activeView: 'today' | 'weekly' | 'monthly' = viewParam === 'weekly' ? 'weekly' : viewParam === 'monthly' ? 'monthly' : 'today';

  const dateInput = typeof req.query.date === 'string' ? parseDateParam(req.query.date) : zonedStartOfDay(new Date());
  const weekStartInput = typeof req.query.start === 'string' ? parseDateParam(req.query.start) : subDays(zonedStartOfDay(new Date()), 6);
  const monthInput = parseMonthParam(req.query.month);

  const [dailyData, weeklyData, monthlyData] = await Promise.all([
    fetchDailySummaries(dateInput),
    fetchWeeklyAggregates(weekStartInput),
    fetchMonthlyAggregates(monthInput)
  ]);

  const rangeStartForNote =
    activeView === 'today'
      ? dailyData.dayStart
      : activeView === 'weekly'
      ? weeklyData.windowStart
      : monthlyData.monthStart;
  const rangeEndForNote =
    activeView === 'today'
      ? dailyData.dayEnd
      : activeView === 'weekly'
      ? weeklyData.windowEnd
      : monthlyData.monthEnd;

  const todayRows = dailyData.summaries
    .map((summary) =>
      buildTodayRow(summary, dailyData.dateParam, dailyData.requestBadges.get(summary.userId) ?? [])
    )
    .join('\n');
  const todayTotals = renderTotalsRow(dailyData.totals, 3);
  const weeklyRows = weeklyData.summaries
    .map((summary, index) =>
      buildWeeklyRow(summary, index, weeklyData.startParam, weeklyData.requestBadges.get(summary.userId) ?? [])
    )
    .join('\n');
  const weeklyTotals = renderTotalsRow(weeklyData.totals, 3);
  const monthlyRows = monthlyData.summaries
    .map((summary, index) =>
      buildWeeklyRow(
        summary,
        index,
        formatIsoDate(monthlyData.monthStart),
        monthlyData.requestBadges.get(summary.userId) ?? []
      )
    )
    .join('\n');
  const monthlyTotals = renderTotalsRow(monthlyData.totals, 3);

  const tabLink = (key: 'today' | 'weekly' | 'monthly', label: string, href: string) =>
    `<a href="${href}"${activeView === key ? ' class="active"' : ''}>${label}</a>`;

  const tabBar = `<div class="tab-bar no-print">
    ${tabLink('today', 'Today', `/dashboard/overview?view=today&date=${dailyData.dateParam}`)}
    ${tabLink('weekly', 'Weekly', `/dashboard/overview?view=weekly&start=${weeklyData.startParam}`)}
    ${tabLink('monthly', 'Monthly', `/dashboard/overview?view=monthly&month=${monthlyData.monthParam}`)}
  </div>`;

  const todaySection = `
    <section class="tab-content${activeView === 'today' ? '' : ' hidden'}" id="tab-today">
      <h2>Today – ${dailyData.label}</h2>
      <div class="actions no-print">
        <form method="get" action="/dashboard/overview" class="filters">
          <input type="hidden" name="view" value="today" />
          <label>
            <span>Date</span>
            <input type="date" name="date" value="${dailyData.dateParam}" />
          </label>
          <button type="submit">Apply</button>
        </form>
        <form method="get" action="/dashboard/today">
          <input type="hidden" name="date" value="${dailyData.dateParam}" />
          <input type="hidden" name="download" value="csv" />
          <button type="submit">Download CSV</button>
        </form>
        <button type="button" class="print-button" onclick="window.print()">Print</button>
      </div>
      ${
        todayRows
          ? `<div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    <th>Started At</th>
                    <th>Active Minutes</th>
                    <th>Idle Minutes</th>
                    <th>Breaks</th>
                    <th>Break Minutes</th>
                    <th>Lunches</th>
                    <th>Lunch Minutes</th>
                    <th>Presence Misses</th>
                  </tr>
                </thead>
                <tbody>
                  ${todayRows}
                </tbody>
                ${todayTotals}
              </table>
            </div>`
          : '<div class="empty">No sessions recorded for this date.</div>'
      }
    </section>
  `;

  const weeklySection = `
    <section class="tab-content${activeView === 'weekly' ? '' : ' hidden'}" id="tab-weekly">
      <h2>Weekly – ${weeklyData.label}</h2>
      <div class="actions no-print">
        <form method="get" action="/dashboard/overview" class="filters">
          <input type="hidden" name="view" value="weekly" />
          <label>
            <span>Week starting</span>
            <input type="date" name="start" value="${weeklyData.startParam}" />
          </label>
          <button type="submit">Apply</button>
        </form>
        <form method="get" action="/dashboard/weekly">
          <input type="hidden" name="start" value="${weeklyData.startParam}" />
          <input type="hidden" name="download" value="csv" />
          <button type="submit">Download CSV</button>
        </form>
        <button type="button" class="print-button" onclick="window.print()">Print</button>
      </div>
      ${
        weeklyRows
          ? `<div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>User</th>
                    <th>Email</th>
                    <th>Active Minutes</th>
                    <th>Idle Minutes</th>
                    <th>Breaks</th>
                    <th>Break Minutes</th>
                    <th>Lunches</th>
                    <th>Lunch Minutes</th>
                    <th>Presence Misses</th>
                  </tr>
                </thead>
                <tbody>
                  ${weeklyRows}
                </tbody>
                ${weeklyTotals}
              </table>
            </div>`
          : '<div class="empty">No activity recorded for this range.</div>'
      }
    </section>
  `;

  const monthlySection = `
    <section class="tab-content${activeView === 'monthly' ? '' : ' hidden'}" id="tab-monthly">
      <h2>Monthly – ${monthlyData.label}</h2>
      <div class="actions no-print">
        <form method="get" action="/dashboard/overview" class="filters">
          <input type="hidden" name="view" value="monthly" />
          <label>
            <span>Month</span>
            <input type="month" name="month" value="${monthlyData.monthParam}" />
          </label>
          <button type="submit">Apply</button>
        </form>
        <form method="get" action="/dashboard/monthly">
          <input type="hidden" name="month" value="${monthlyData.monthParam}" />
          <input type="hidden" name="download" value="csv" />
          <button type="submit">Download CSV</button>
        </form>
        <button type="button" class="print-button" onclick="window.print()">Print</button>
      </div>
      ${
        monthlyRows
          ? `<div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>User</th>
                    <th>Email</th>
                    <th>Active Minutes</th>
                    <th>Idle Minutes</th>
                    <th>Breaks</th>
                    <th>Break Minutes</th>
                    <th>Lunches</th>
                    <th>Lunch Minutes</th>
                    <th>Presence Misses</th>
                  </tr>
                </thead>
                <tbody>
                  ${monthlyRows}
                </tbody>
                ${monthlyTotals}
              </table>
            </div>`
          : '<div class="empty">No activity recorded for this month.</div>'
      }
    </section>
  `;

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Dashboard Overview</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('overview')}
        ${renderTimezoneNote(rangeStartForNote, rangeEndForNote)}
        <h1>Dashboard Overview</h1>
        ${tabBar}
        ${todaySection}
        ${weeklySection}
        ${monthlySection}
      </body>
    </html>
  `;

  res.type('html').send(html);
});



dashboardRouter.get('/balances', async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    include: { balance: true }
  });

  const rows = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    pto: user.balance?.ptoHours ?? 0,
    nonPto: user.balance?.nonPtoHours ?? 0,
    makeUp: user.balance?.makeUpHours ?? 0,
    basePto: user.balance?.basePtoHours ?? 0,
    baseNonPto: user.balance?.baseNonPtoHours ?? 0,
    baseMakeUp: user.balance?.baseMakeUpHours ?? 0,
    updatedAt: user.balance?.updatedAt ?? null
  }));

  const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
  if (wantsCsv) {
    const header = [
      'Name',
      'Email',
      'PTO Hours',
      'Non-PTO Hours',
      'Make-Up Hours',
      'Base PTO',
      'Base Non-PTO',
      'Base Make-Up',
      'Updated At ISO',
      'Timezone'
    ];
    const csvRows = rows.map((row) =>
      [
        escapeCsv(row.name),
        escapeCsv(row.email),
        escapeCsv(formatHours(row.pto)),
        escapeCsv(formatHours(row.nonPto)),
        escapeCsv(formatHours(row.makeUp)),
        escapeCsv(formatHours(row.basePto)),
        escapeCsv(formatHours(row.baseNonPto)),
        escapeCsv(formatHours(row.baseMakeUp)),
        escapeCsv(row.updatedAt ? formatIsoDateTime(row.updatedAt) : ''),
        escapeCsv(DASHBOARD_TIME_ZONE)
      ].join(',')
    );
    const csv = [header.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="balances.csv"');
    return res.send(csv);
  }

  const requestedUserId =
    typeof req.query.userId === 'string' ? Number.parseInt(req.query.userId, 10) : Number.NaN;
  const selectedUser =
    Number.isFinite(requestedUserId) && requestedUserId > 0
      ? users.find((user) => user.id === requestedUserId) ?? null
      : users[0] ?? null;

  const totals = rows.reduce(
    (acc, row) => {
      acc.pto += row.pto;
      acc.nonPto += row.nonPto;
      acc.makeUp += row.makeUp;
      return acc;
    },
    { pto: 0, nonPto: 0, makeUp: 0 }
  );

  const tableRows = rows
    .map((row) => {
      const updatedLabel = row.updatedAt ? formatDateTime(row.updatedAt) : '—';
      const isSelected = selectedUser?.id === row.id;
      return `<tr${isSelected ? ' class="highlight-row"' : ''}>
        <td><a href="/dashboard/balances?userId=${row.id}">${escapeHtml(row.name)}</a></td>
        <td>${escapeHtml(row.email)}</td>
        <td>${escapeHtml(formatHours(row.pto))} h<div class="meta">Base ${escapeHtml(formatHours(row.basePto))} h</div></td>
        <td>${escapeHtml(formatHours(row.nonPto))} h<div class="meta">Base ${escapeHtml(formatHours(row.baseNonPto))} h</div></td>
        <td>${escapeHtml(formatHours(row.makeUp))} h<div class="meta">Base ${escapeHtml(formatHours(row.baseMakeUp))} h</div></td>
        <td>${escapeHtml(updatedLabel)}</td>
      </tr>`;
    })
    .join('\n');

  const totalsRow = rows.length
    ? `<tfoot>
        <tr class="totals">
          <th colspan="2">Totals</th>
          <th>${escapeHtml(formatHours(totals.pto))} h</th>
          <th>${escapeHtml(formatHours(totals.nonPto))} h</th>
          <th>${escapeHtml(formatHours(totals.makeUp))} h</th>
          <th></th>
        </tr>
      </tfoot>`
    : '';

  const updatedDates = rows.map((row) => row.updatedAt).filter((value): value is Date => Boolean(value));
  const balancesRangeStart = updatedDates.length
    ? zonedStartOfDay(updatedDates.reduce((min, current) => (current < min ? current : min)))
    : zonedStartOfDay(new Date());
  const balancesRangeEnd = updatedDates.length
    ? zonedEndOfDay(updatedDates.reduce((max, current) => (current > max ? current : max)))
    : zonedEndOfDay(new Date());

  let detailSection = '<section class="balances-detail"><div class="empty">No users available.</div></section>';
  if (selectedUser) {
    const overview = await getBalanceOverview(selectedUser.id, { limit: 200 });
    const { balance, ledger } = overview;
    const summaryCards = `
      <div class="summary-cards">
        <div class="summary-card">
          <div class="summary-title">PTO Remaining</div>
          <div class="summary-value"><span data-balance-current>${escapeHtml(formatHours(balance.ptoHours))}</span> h</div>
          <div class="summary-meta">Base <span data-balance-base>${escapeHtml(formatHours(balance.basePtoHours))}</span> h</div>
        </div>
        <div class="summary-card">
          <div class="summary-title">Non-PTO Remaining</div>
          <div class="summary-value">${escapeHtml(formatHours(balance.nonPtoHours))} h</div>
          <div class="summary-meta">Base ${escapeHtml(formatHours(balance.baseNonPtoHours))} h</div>
        </div>
        <div class="summary-card">
          <div class="summary-title">Make-Up Hours</div>
          <div class="summary-value">${escapeHtml(formatHours(balance.makeUpHours))} h</div>
          <div class="summary-meta">Base ${escapeHtml(formatHours(balance.baseMakeUpHours))} h</div>
        </div>
        <div class="summary-card">
          <div class="summary-title">Last Updated</div>
          <div class="summary-value" data-balance-updated>${balance.updatedAt ? escapeHtml(formatDateTime(balance.updatedAt)) : '—'}</div>
          <div class="summary-meta">Ledger entries update instantly.</div>
        </div>
      </div>
    `;

    let running = balance.ptoHours;
    const ledgerRows = ledger
      .map((entry) => {
        const after = running;
        running -= entry.deltaHours;
        const changeLabel = `${entry.deltaHours >= 0 ? '+' : '-'}${formatHours(Math.abs(entry.deltaHours))}`;
        const actorLabel = entry.createdBy
          ? `${escapeHtml(entry.createdBy.name)}<div class="meta">${escapeHtml(entry.createdBy.email)}</div>`
          : '<span class="meta">System</span>';
        const reasonLabel = entry.reason ? escapeHtml(entry.reason) : '—';
        return `<tr>
          <td>${formatDateTime(entry.createdAt)}</td>
          <td>${escapeHtml(changeLabel)} h</td>
          <td>${escapeHtml(formatHours(after))} h</td>
          <td>${reasonLabel}</td>
          <td>${actorLabel}</td>
        </tr>`;
      })
      .join('\\n');

    const ledgerTable = `<div class="table-scroll${ledgerRows ? '' : ' hidden'}" data-ledger-container>
        <table class="ledger-table">
          <thead>
            <tr>
              <th>Recorded</th>
              <th>Change</th>
              <th>Balance After</th>
              <th>Reason</th>
              <th>Entered By</th>
            </tr>
          </thead>
          <tbody data-ledger-body>${ledgerRows}</tbody>
        </table>
      </div>`;

    const ledgerEmpty = `<div class="empty${ledgerRows ? ' hidden' : ''}" data-ledger-empty>No ledger entries recorded yet. Adjustments and approved PTO requests will appear here.</div>`;

    const dialogHtml = `
      <dialog id="adjust-dialog">
        <form id="adjust-form">
          <h3>Adjust PTO Balance</h3>
          <p class="dialog-meta">Use positive values to grant hours, negative values to remove them.</p>
          <label>
            <span>Hours</span>
            <input type="number" name="deltaHours" step="0.25" min="-1000" max="1000" required />
          </label>
          <label>
            <span>Reason</span>
            <textarea name="reason" rows="3" maxlength="500" required></textarea>
          </label>
          <p class="dialog-error" data-adjust-error></p>
          <div class="dialog-actions">
            <button type="submit">Apply</button>
            <button type="button" class="button-secondary" data-close-adjust>Cancel</button>
          </div>
        </form>
      </dialog>
    `;

    detailSection = `
      <section class="balances-detail" id="balance-detail" data-user-id="${selectedUser.id}">
        <h2>${escapeHtml(selectedUser.name)}</h2>
        <div class="meta">${escapeHtml(selectedUser.email)}</div>
        ${summaryCards}
        <div class="actions no-print balances-detail-actions">
          <button type="button" class="button" data-open-adjust>Adjust Balance</button>
          <a href="/dashboard/requests?type=pto" class="button button-secondary">Review PTO Requests</a>
        </div>
        ${dialogHtml}
        <h3>PTO Ledger</h3>
        <div class="meta">Entries are sorted newest first.</div>
        ${ledgerTable}
        ${ledgerEmpty}
      </section>
    `;
  }

  const script = `
        <script>
          (() => {
            const detail = document.getElementById('balance-detail');
            if (!detail) return;
            const userId = detail.dataset.userId;
            if (!userId) return;
            const dialog = detail.querySelector('#adjust-dialog');
            const form = detail.querySelector('#adjust-form');
            const errorEl = detail.querySelector('[data-adjust-error]');
            const openBtn = detail.querySelector('[data-open-adjust]');
            const closeBtn = detail.querySelector('[data-close-adjust]');
            const toggleDialog = (open) => {
              if (!dialog) return;
              if (typeof dialog.showModal === 'function') {
                open ? dialog.showModal() : dialog.close();
              } else {
                dialog.classList.toggle('hidden', !open);
              }
            };
            openBtn?.addEventListener('click', () => {
              if (errorEl) errorEl.textContent = '';
              form?.reset();
              toggleDialog(true);
            });
            closeBtn?.addEventListener('click', (event) => {
              event.preventDefault();
              toggleDialog(false);
            });
            dialog?.addEventListener('cancel', () => {
              if (errorEl) errorEl.textContent = '';
            });
            form?.addEventListener('submit', async (event) => {
              event.preventDefault();
              if (!form) return;
              const hoursInput = form.querySelector('[name="deltaHours"]');
              const reasonInput = form.querySelector('[name="reason"]');
              const delta = Number(hoursInput ? hoursInput.value : '');
              const reason = (reasonInput ? reasonInput.value : '').trim();
              if (!Number.isFinite(delta) || delta === 0) {
                if (errorEl) errorEl.textContent = 'Enter a non-zero number of hours.';
                return;
              }
              if (!reason) {
                if (errorEl) errorEl.textContent = 'Reason is required.';
                return;
              }
              const submitButton = form.querySelector('button[type="submit"]');
              if (submitButton) submitButton.disabled = true;
              if (errorEl) errorEl.textContent = '';
              try {
                const response = await fetch('/api/balances/' + userId + '/adjust', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ deltaHours: delta, reason })
                });
                if (response.ok) {
                  window.location.reload();
                  return;
                }
                let message = 'Unable to adjust balance.';
                try {
                  const data = await response.json();
                  if (data && data.message) {
                    message = data.message;
                  }
                } catch (_err) {}
                if (errorEl) errorEl.textContent = message;
              } catch (err) {
                if (errorEl) errorEl.textContent = err instanceof Error ? err.message : 'Unable to adjust balance.';
              } finally {
                if (submitButton) submitButton.disabled = false;
              }
            });
          })();
        </script>
  `;

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Balances</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('balances')}
        ${renderTimezoneNote(balancesRangeStart, balancesRangeEnd)}
        <h1>Balances</h1>
        <div class="meta">Tracking ${rows.length} ${rows.length === 1 ? 'user' : 'users'}. Select a user to view ledger history and make adjustments.</div>
        <div class="actions no-print">
          <form method="get" action="/dashboard/balances">
            <input type="hidden" name="download" value="csv" />
            <button type="submit">Download CSV</button>
          </form>
          <a href="/dashboard/requests" class="button button-secondary">Review Requests</a>
        </div>
        ${
          rows.length
            ? `<div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Email</th>
                      <th>PTO</th>
                      <th>Non-PTO</th>
                      <th>Make-Up</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                  ${totalsRow}
                </table>
              </div>`
            : '<div class="empty">No balances recorded yet.</div>'
        }
        ${detailSection}
        ${script}
      </body>
    </html>
  `;

  res.type('html').send(html);
});

dashboardRouter.get('/user/:userId/balances', async (req, res) => {
  const userId = Number.parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).type('html').send('<h1>Invalid user id</h1>');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { balance: true }
  });

  if (!user) {
    return res.status(404).type('html').send('<h1>User not found</h1>');
  }

  const requests = await prisma.timeRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      approver: { select: { id: true, name: true, email: true } }
    }
  });

  const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
  if (wantsCsv) {
    const header = [
      'Created At ISO',
      'Type',
      'Status',
      'Start Date ISO',
      'End Date ISO',
      'Hours',
      'Reason',
      'Approver Name',
      'Approver Email',
      'Timezone'
    ];
    const rowsCsv = requests.map((request) =>
      [
        escapeCsv(formatIsoDateTime(request.createdAt)),
        escapeCsv(request.type),
        escapeCsv(request.status),
        escapeCsv(formatIsoDate(request.startDate)),
        escapeCsv(formatIsoDate(request.endDate)),
        escapeCsv(formatHours(request.hours)),
        escapeCsv(request.reason ?? ''),
        escapeCsv(request.approver?.name ?? ''),
        escapeCsv(request.approver?.email ?? ''),
        escapeCsv(DASHBOARD_TIME_ZONE)
      ].join(',')
    );
    const csv = [header.join(','), ...rowsCsv].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="user-${userId}-requests.csv"`);
    return res.send(csv);
  }

  const balance = user.balance;
  const summary = {
    pto: balance?.ptoHours ?? 0,
    nonPto: balance?.nonPtoHours ?? 0,
    makeUp: balance?.makeUpHours ?? 0,
    basePto: balance?.basePtoHours ?? 0,
    baseNonPto: balance?.baseNonPtoHours ?? 0,
    baseMakeUp: balance?.baseMakeUpHours ?? 0,
    updatedAt: balance?.updatedAt ?? null
  };

  const requestRangeStart = requests.length
    ? zonedStartOfDay(requests[requests.length - 1].startDate)
    : summary.updatedAt
    ? zonedStartOfDay(summary.updatedAt)
    : zonedStartOfDay(new Date());
  const requestRangeEnd = requests.length
    ? zonedEndOfDay(requests[0].endDate)
    : summary.updatedAt
    ? zonedEndOfDay(summary.updatedAt)
    : zonedEndOfDay(new Date());

  const summaryCards = `
    <div class="summary-cards">
      <div class="summary-card">
        <div class="summary-title">PTO Remaining</div>
        <div class="summary-value">${escapeHtml(formatHours(summary.pto))} h</div>
        <div class="summary-meta">Base ${escapeHtml(formatHours(summary.basePto))} h</div>
      </div>
      <div class="summary-card">
        <div class="summary-title">Non-PTO Remaining</div>
        <div class="summary-value">${escapeHtml(formatHours(summary.nonPto))} h</div>
        <div class="summary-meta">Base ${escapeHtml(formatHours(summary.baseNonPto))} h</div>
      </div>
      <div class="summary-card">
        <div class="summary-title">Make-Up Earned</div>
        <div class="summary-value">${escapeHtml(formatHours(summary.makeUp))} h</div>
        <div class="summary-meta">Base ${escapeHtml(formatHours(summary.baseMakeUp))} h</div>
      </div>
      <div class="summary-card">
        <div class="summary-title">Last Updated</div>
        <div class="summary-value">${summary.updatedAt ? escapeHtml(formatDateTime(summary.updatedAt)) : '—'}</div>
        <div class="summary-meta">Balance recalculates after approvals.</div>
      </div>
    </div>
  `;

  const requestRows = requests
    .map((request) => {
      const typeLabel = requestTypeLabels[request.type as TimeRequestType];
      const statusLabel = requestStatusLabels[request.status as TimeRequestStatus];
      const typeBadge = `<span class="badge badge-${request.type}">${escapeHtml(typeLabel)}</span>`;
      const statusBadge = `<span class="badge badge-status-${request.status}">${escapeHtml(statusLabel)}</span>`;
      const rangeLabel = `${formatShortDate(request.startDate)} – ${formatShortDate(request.endDate)}`;
      const approverLabel = request.approver
        ? `${escapeHtml(request.approver.name)}<div class="meta">${escapeHtml(request.approver.email)}</div>`
        : '—';
      const actions =
        request.status === 'pending'
          ? `<div class="action-buttons">
              <form method="post" action="/api/time-requests/${request.id}/approve" class="inline-form">
                <button type="submit">Approve</button>
              </form>
              <form method="post" action="/api/time-requests/${request.id}/deny" class="inline-form">
                <button type="submit" class="button-danger">Deny</button>
              </form>
            </div>`
          : '<span class="meta">Processed</span>';
      return `<tr>
        <td>${formatDateTime(request.createdAt)}</td>
        <td>${typeBadge}</td>
        <td>${statusBadge}</td>
        <td>${rangeLabel}</td>
        <td>${formatHours(request.hours)}</td>
        <td>${request.reason ? escapeHtml(request.reason) : '—'}</td>
        <td>${approverLabel}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('\n');

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(user.name)} – Balances</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('balances')}
        <a href="/dashboard/balances" class="no-print">← Back to Balances</a>
        <h1>${escapeHtml(user.name)}</h1>
        <div class="meta">${escapeHtml(user.email)}</div>
        ${summaryCards}
        <div class="actions no-print">
          <form method="get" action="/dashboard/balances">
            <input type="hidden" name="download" value="csv" />
            <input type="hidden" name="userId" value="${userId}" />
            <button type="submit">Download CSV</button>
          </form>
          <a href="/dashboard/requests?type=pto&status=pending" class="button button-secondary">Review Requests</a>
        </div>
        <h2>Request History</h2>
        <div class="meta">${requests.length === 0 ? 'No requests submitted yet.' : `Showing ${requests.length} ${requests.length === 1 ? 'request' : 'requests'}.`}</div>
        ${
          requests.length
            ? `<div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Submitted</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Date Range</th>
                      <th>Hours</th>
                      <th>Reason</th>
                      <th>Approver</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${requestRows}
                  </tbody>
                </table>
              </div>`
            : '<div class="empty">No requests recorded for this user.</div>'
        }
      </body>
    </html>
  `;

  res.type('html').send(html);
});

dashboardRouter.get('/user/:userId', async (req, res) => {
  const userId = Number.parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) {
    return res.status(400).type('html').send('<h1>Invalid user id</h1>');
  }

  const requestedDate = typeof req.query.date === 'string' ? parseDateParam(req.query.date) : zonedStartOfDay(new Date());
  const dayStart = zonedStartOfDay(requestedDate);
  const dayEnd = zonedEndOfDay(requestedDate);
  const dateParam = toDateParam(dayStart);

  const sessions = await prisma.session.findMany({
    where: {
      userId,
      startedAt: {
        gte: dayStart,
        lte: dayEnd
      }
    },
    orderBy: { startedAt: 'asc' },
    include: {
      user: true,
      minuteStats: true,
      events: true,
      pauses: true
    }
  });

  const user = sessions[0]?.user ?? (await prisma.user.findUnique({ where: { id: userId } }));
  if (!user) {
    return res.status(404).type('html').send('<h1>User not found</h1>');
  }

  const now = new Date();
  const sessionRecords = sessions as SessionRecord[];
  const details = sessionRecords.map((session) => toSessionDetail(session, now));
  const pauseEntries = collectPauseEntries(sessionRecords, now);

  const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
  if (wantsCsv) {
    const header = [
      'Session ID',
      'Started At ISO',
      'Ended At ISO',
      'Active Minutes',
      'Idle Minutes',
      'Breaks',
      'Break Minutes',
      'Lunches',
      'Lunch Minutes',
      'Presence Misses',
      'Timezone'
    ];
    const rows = details.map((detail) =>
      [
        escapeCsv(detail.sessionId),
        escapeCsv(formatIsoDateTime(detail.startedAt)),
        escapeCsv(detail.endedAt ? formatIsoDateTime(detail.endedAt) : ''),
        escapeCsv(detail.activeMinutes),
        escapeCsv(detail.idleMinutes),
        escapeCsv(detail.breaks),
        escapeCsv(detail.breakMinutes),
        escapeCsv(detail.lunches),
        escapeCsv(detail.lunchMinutes),
        escapeCsv(detail.presenceMisses),
        escapeCsv(DASHBOARD_TIME_ZONE)
      ].join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="user-${userId}-${dateParam}.csv"`);
    return res.send(csv);
  }

  const dateLabel = formatFullDate(dayStart);
  const detailRows = details.map((detail) => buildDetailRow(detail)).join('\n');

  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(user.name)} – ${dateLabel}</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('user')}
        ${renderTimezoneNote(dayStart, dayEnd)}
        <a href="/dashboard/today" class="no-print">← Back to Today</a>
        <h1>${escapeHtml(user.name)}</h1>
        <div class="meta">${escapeHtml(user.email)}</div>
        <h2>${dateLabel}</h2>
        <div class="actions no-print">
          <form method="get" action="/dashboard/user/${userId}" class="filters">
            <label>
              <span>Date</span>
              <input type="date" name="date" value="${dateParam}" />
            </label>
            <button type="submit">Apply</button>
          </form>
          <form method="get" action="/dashboard/user/${userId}">
            <input type="hidden" name="date" value="${dateParam}" />
            <input type="hidden" name="download" value="csv" />
            <button type="submit">Download CSV</button>
          </form>
          <button type="button" class="print-button" onclick="window.print()">Print</button>
        </div>
        ${
          detailRows
            ? `<div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Session Start</th>
                      <th>Session End</th>
                      <th>Active Minutes</th>
                      <th>Idle Minutes</th>
                      <th>Breaks</th>
                      <th>Break Minutes</th>
                      <th>Lunches</th>
                      <th>Lunch Minutes</th>
                      <th>Presence Misses</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${detailRows}
                  </tbody>
                </table>
              </div>`
            : '<div class="empty">No sessions recorded for this date.</div>'
        }
        <section class="card">
          <h2>Breaks and Lunches</h2>
          ${renderPauseTable(pauseEntries)}
        </section>
      </body>
    </html>
  `;

  res.type('html').send(html);
});

type SettingsContext = {
  enabled: boolean;
  employees: Array<{ id: number; name: string; email: string; active: boolean; createdAt: Date }>;
  logs: Array<{
    id: string;
    email: string;
    userId: number | null;
    event: string;
    success: boolean;
    reason: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    deviceId: string | null;
    createdAt: Date;
  }>;
  message?: string;
  error?: string;
};

const addEmployeeSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email()
});

const renderSettingsPage = ({ enabled, employees, logs, message, error }: SettingsContext) => {
  const renderAlert = () => {
    if (message) {
      return `<div class="alert success">${escapeHtml(message)}</div>`;
    }
    if (error) {
      return `<div class="alert error">${escapeHtml(error)}</div>`;
    }
    return '';
  };

  const employeeRows = employees.length
    ? employees
        .map((employee) => {
          const toggleLabel = employee.active ? 'Deactivate' : 'Activate';
          const nextValue = employee.active ? 'false' : 'true';
          return `
            <tr>
              <td>${escapeHtml(employee.name)}</td>
              <td>${escapeHtml(employee.email)}</td>
              <td>${employee.active ? 'Active' : 'Inactive'}</td>
              <td>${formatDateTime(employee.createdAt)}</td>
              <td>
                <form method="post" action="/dashboard/settings/employees/${employee.id}/active" class="inline-form">
                  <input type="hidden" name="active" value="${nextValue}" />
                  <button type="submit">${toggleLabel}</button>
                </form>
              </td>
            </tr>
          `;
        })
        .join('\n')
    : '<tr><td colspan="5" class="empty">No employees found.</td></tr>';

  const auditRows = logs.length
    ? logs
        .map((log) => `
            <tr>
              <td>${formatDateTime(log.createdAt)}</td>
              <td>${escapeHtml(log.email)}</td>
              <td>${log.success ? 'Success' : 'Denied'}</td>
              <td>${log.reason ? escapeHtml(log.reason) : ''}</td>
              <td>${log.ipAddress ? escapeHtml(log.ipAddress) : ''}</td>
              <td>${log.deviceId ? escapeHtml(log.deviceId) : ''}</td>
            </tr>
          `)
        .join('\n')
    : '<tr><td colspan="6" class="empty">No sign-in attempts recorded.</td></tr>';

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Settings – Email Sign-In</title>
        <style>${baseStyles}</style>
      </head>
      <body>
        ${renderNav('settings')}
        <h1>Email Sign-In Settings</h1>
        ${renderAlert()}
        <section class="card no-print">
          <h2>Feature Flag</h2>
          <p>Allow employees to request session access with email only. Current status: <strong>${
            enabled ? 'Enabled' : 'Disabled'
          }</strong>.</p>
          <form method="post" action="/dashboard/settings/toggle-email-signin">
            <input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}" />
            <button type="submit">${enabled ? 'Disable' : 'Enable'} Email Sign-In</button>
          </form>
        </section>
        <section class="card no-print">
          <h2>Add Employee</h2>
          <form method="post" action="/dashboard/settings/employees" class="stack-form">
            <label>
              <span>Name</span>
              <input type="text" name="name" required />
            </label>
            <label>
              <span>Email</span>
              <input type="email" name="email" required />
            </label>
            <button type="submit">Add Employee</button>
          </form>
        </section>
        <section class="card">
          <h2>Employee Roster</h2>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${employeeRows}
              </tbody>
            </table>
          </div>
        </section>
        <section class="card">
          <h2>Sign-In Audit Trail</h2>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Email</th>
                  <th>Result</th>
                  <th>Reason</th>
                  <th>IP</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                ${auditRows}
              </tbody>
            </table>
          </div>
        </section>
      </body>
    </html>
  `;
};

dashboardRouter.get('/settings', async (req, res) => {
  const toOptionalString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

  const message = toOptionalString(req.query.message);
  const error = toOptionalString(req.query.error);

  const [enabled, employees, logs] = await Promise.all([
    isEmailSessionEnabled(),
    prisma.user.findMany({
      where: { role: 'employee' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, active: true, createdAt: true }
    }),
    prisma.authAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        email: true,
        userId: true,
        event: true,
        success: true,
        reason: true,
        ipAddress: true,
        userAgent: true,
        deviceId: true,
        createdAt: true
      }
    })
  ]);

  const html = renderSettingsPage({ enabled, employees, logs, message, error });
  res.type('text/html').send(html);
});

dashboardRouter.post(
  '/settings/toggle-email-signin',
  asyncHandler(async (req, res) => {
    const raw = String((req.body?.enabled ?? '').toString()).toLowerCase();
    const nextEnabled = ['1', 'true', 'on', 'yes'].includes(raw);
    await setEmailSessionEnabled(nextEnabled);
    res.redirect('/dashboard/settings');
  })
);

dashboardRouter.post(
  '/settings/employees',
  asyncHandler(async (req, res) => {
    const parsed = addEmployeeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Provide a name and valid email.'));
    }

    const name = parsed.data.name.trim();
    const normalizedEmail = parsed.data.email.trim().toLowerCase();

    if (!name) {
      return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Name is required.'));
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Employee already exists.'));
    }

    const passwordHash = await hashPassword(randomUUID());

    await prisma.user.create({
      data: {
        name,
        email: normalizedEmail,
        role: 'employee',
        passwordHash,
        active: true
      }
    });

    res.redirect('/dashboard/settings?message=' + encodeURIComponent('Employee added.'));
  })
);

dashboardRouter.post(
  '/settings/employees/:id/active',
  asyncHandler(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      throw HttpError.badRequest('Invalid employee id');
    }
    const raw = String((req.body?.active ?? '').toString()).toLowerCase();
    const nextActive = ['1', 'true', 'on', 'yes'].includes(raw);

    const employee = await prisma.user.findUnique({ where: { id } });
    if (!employee || employee.role !== 'employee') {
      throw HttpError.notFound('Employee not found');
    }

    await prisma.user.update({ where: { id }, data: { active: nextActive } });
    res.redirect('/dashboard/settings');
  })
);

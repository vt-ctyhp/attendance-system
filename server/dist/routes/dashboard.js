"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dashboardRouter = exports.fetchDailySummaries = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const zod_1 = require("zod");
const prisma_1 = require("../prisma");
const types_1 = require("../types");
const auth_1 = require("../auth");
const env_1 = require("../env");
const featureFlags_1 = require("../services/featureFlags");
const asyncHandler_1 = require("../middleware/asyncHandler");
const errors_1 = require("../errors");
const timesheets_1 = require("../services/timesheets");
const balances_1 = require("../services/balances");
const timeRequestPolicy_1 = require("../services/timeRequestPolicy");
const DASHBOARD_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';
const ISO_DATE_TIME = "yyyy-MM-dd'T'HH:mm:ssXXX";
const ISO_DATE = 'yyyy-MM-dd';
const DASHBOARD_COOKIE_PATH = '/dashboard';
const DEFAULT_DASHBOARD_REDIRECT = '/dashboard/overview';
const DASHBOARD_LOGIN_ROUTE = '/dashboard/login';
const DASHBOARD_COOKIE_MAX_AGE_MS = auth_1.TOKEN_TTL_SECONDS * 1000;
const IS_PRODUCTION = env_1.env.NODE_ENV === 'production';
const zoned = (date) => (0, date_fns_tz_1.utcToZonedTime)(date, DASHBOARD_TIME_ZONE);
const zonedStartOfDay = (date) => (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfDay)(zoned(date)), DASHBOARD_TIME_ZONE);
const zonedEndOfDay = (date) => (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfDay)(zoned(date)), DASHBOARD_TIME_ZONE);
const zonedStartOfMonth = (date) => (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfMonth)(zoned(date)), DASHBOARD_TIME_ZONE);
const zonedEndOfMonth = (date) => (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfMonth)(zoned(date)), DASHBOARD_TIME_ZONE);
const formatDateTime = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, 'MMM d, yyyy HH:mm');
const formatFullDate = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, 'MMM d, yyyy');
const formatShortDate = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, 'MMM d');
const formatIsoDateTime = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, ISO_DATE_TIME);
const formatIsoDate = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, ISO_DATE);
const formatTimeOfDay = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, 'h:mm a');
const minutesFormatter = (value) => `${value} min`;
const formatOptionalDate = (value) => (value ? formatDateTime(value) : '—');
const toDateParam = (value) => formatIsoDate(zonedStartOfDay(value));
const parseDateInput = (value) => {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const parsed = (0, date_fns_tz_1.zonedTimeToUtc)(`${trimmed}T00:00:00`, DASHBOARD_TIME_ZONE);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};
const parseDateParam = (value) => {
    if (typeof value === 'string') {
        const parsed = parseDateInput(value);
        if (parsed) {
            return zonedStartOfDay(parsed);
        }
    }
    return zonedStartOfDay(new Date());
};
const parseMonthParam = (value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) {
        const parsed = parseDateInput(`${value}-01`);
        if (parsed) {
            return zonedStartOfMonth(parsed);
        }
    }
    return zonedStartOfMonth(new Date());
};
const parseDateOnlyParam = (value) => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const parsed = parseDateInput(value);
    return parsed ? zonedStartOfDay(parsed) : undefined;
};
const escapeCsv = (value) => {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
};
const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const isDashboardRole = (role) => role === 'admin' || role === 'manager';
const sanitizeRedirect = (value) => {
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
const isHtmlRequest = (req) => {
    const accept = req.headers.accept;
    if (typeof accept !== 'string' || accept.trim() === '') {
        return true;
    }
    return accept.includes('text/html') || accept.includes('*/*');
};
const mapLoginError = (code) => {
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
const mapLoginMessage = (code) => {
    switch (code) {
        case 'logged_out':
            return 'You are now signed out.';
        case 'session_expired':
            return 'Your session has expired. Please sign in again.';
        default:
            return undefined;
    }
};
const renderLoginPage = (options) => {
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
const loginFormSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1),
    redirect: zod_1.z.string().optional()
});
const relevantRequestTypes = ['pto', 'non_pto'];
const visibleRequestStatuses = ['pending', 'approved'];
const requestTypeLabels = {
    pto: 'PTO',
    non_pto: 'Non-PTO',
    make_up: 'Make-Up'
};
const requestStatusLabels = {
    pending: 'Pending',
    approved: 'Approved',
    denied: 'Denied'
};
const requestStatusOrder = {
    pending: 0,
    approved: 1,
    denied: 2
};
const formatRequestBadgeTitle = (badge) => {
    const typeLabel = requestTypeLabels[badge.type];
    const statusLabel = requestStatusLabels[badge.status];
    const rangeLabel = `${formatShortDate(badge.startDate)} – ${formatShortDate(badge.endDate)}`;
    const hoursValue = Number.isInteger(badge.hours) ? badge.hours.toString() : badge.hours.toFixed(2);
    return `${typeLabel} ${statusLabel} • ${rangeLabel} • ${hoursValue}h`;
};
const renderRequestBadges = (badges) => {
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
const formatHours = (value) => {
    if (!Number.isFinite(value)) {
        return '0';
    }
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
};
const minutesToHoursValue = (minutes) => Math.round((minutes / 60) * 100) / 100;
const formatHoursFromMinutes = (minutes) => formatHours(minutesToHoursValue(minutes));
const formatTimesheetStatus = (status) => status ? `${status.charAt(0).toUpperCase()}${status.slice(1)}` : status;
const timesheetViewLabel = (view) => {
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
const buildSelectOptions = (options, selected) => options
    .map(({ value, label }) => `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
const collectRequestBadges = async (userIds, rangeStart, rangeEnd) => {
    if (!userIds.length) {
        return new Map();
    }
    const requests = await prisma_1.prisma.timeRequest.findMany({
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
    return requests.reduce((acc, request) => {
        const current = acc.get(request.userId) ?? [];
        current.push({
            id: request.id,
            userId: request.userId,
            type: request.type,
            status: request.status,
            startDate: request.startDate,
            endDate: request.endDate,
            hours: request.hours
        });
        acc.set(request.userId, current);
        return acc;
    }, new Map());
};
const computeTotals = (rows) => rows.reduce((acc, row) => ({
    active: acc.active + row.activeMinutes,
    idle: acc.idle + row.idleMinutes,
    breaks: acc.breaks + row.breaks,
    breakMinutes: acc.breakMinutes + row.breakMinutes,
    lunches: acc.lunches + row.lunches,
    lunchMinutes: acc.lunchMinutes + row.lunchMinutes,
    presence: acc.presence + row.presenceMisses
}), { active: 0, idle: 0, breaks: 0, breakMinutes: 0, lunches: 0, lunchMinutes: 0, presence: 0 });
const renderTotalsRow = (totals, leadingColumns) => `
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
const detailLink = (userId, dateParam, label) => `<a href="/dashboard/user/${userId}?date=${dateParam}">${escapeHtml(label)}</a>`;
const buildTodayRow = (row, dateParam, badges = []) => `
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
const buildWeeklyRow = (row, index, dateParam, badges = []) => `
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
const buildDetailRow = (detail) => `
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
const pauseLabel = (entry) => `${entry.type === 'break' ? 'Break' : 'Lunch'} ${entry.sequence}`;
const renderPauseTable = (entries) => {
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
const computePauseDuration = (pause, now) => pause.durationMinutes ?? Math.max(0, Math.ceil(((pause.endedAt ?? now).getTime() - pause.startedAt.getTime()) / 60000));
const summarizePauses = (pauses, now) => {
    return pauses.reduce((acc, pause) => {
        const duration = computePauseDuration(pause, now);
        if (pause.type === 'break') {
            acc.breakCount += 1;
            acc.breakMinutes += duration;
        }
        else if (pause.type === 'lunch') {
            acc.lunchCount += 1;
            acc.lunchMinutes += duration;
        }
        return acc;
    }, { breakCount: 0, breakMinutes: 0, lunchCount: 0, lunchMinutes: 0 });
};
const toSummary = (session, now) => {
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
const toSessionDetail = (session, now) => {
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
const aggregateSessionsByUser = (sessions, now) => sessions.reduce((acc, session) => {
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
const collectPauseEntries = (sessions, now) => sessions
    .flatMap((session) => session.pauses
    .filter((pause) => pause.type === 'break' || pause.type === 'lunch')
    .map((pause) => ({
    sessionId: session.id,
    userId: session.userId,
    userName: session.user.name,
    userEmail: session.user.email,
    type: (pause.type === 'break' ? 'break' : 'lunch'),
    sequence: pause.sequence,
    startedAt: pause.startedAt,
    endedAt: pause.endedAt,
    durationMinutes: computePauseDuration(pause, now)
})))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
const MINUTE_MS = 60000;
const clampIntervalToRange = (start, end, now, rangeStart, rangeEnd) => {
    const effectiveEnd = end ?? now;
    const clampedStart = start < rangeStart ? rangeStart : start;
    const clampedEnd = effectiveEnd > rangeEnd ? rangeEnd : effectiveEnd;
    if (clampedEnd <= clampedStart) {
        return null;
    }
    return { start: clampedStart, end: clampedEnd };
};
const intervalOverlaps = (intervals, start, end) => intervals.some((interval) => start < interval.end && end > interval.start);
const sumIntervalsInMinutes = (intervals) => intervals.reduce((total, interval) => total + Math.max(0, Math.ceil((interval.end.getTime() - interval.start.getTime()) / MINUTE_MS)), 0);
const resolveIdleStreak = (session, now, dayStart, exclusionIntervals) => {
    const sortedStats = session.minuteStats
        .filter((stat) => stat.minuteStart >= dayStart && stat.minuteStart <= now && stat.active)
        .sort((a, b) => a.minuteStart.getTime() - b.minuteStart.getTime());
    let idleStart = null;
    for (let index = sortedStats.length - 1; index >= 0; index -= 1) {
        const stat = sortedStats[index];
        if (!stat.idle) {
            break;
        }
        const minuteStart = stat.minuteStart;
        const minuteEnd = new Date(minuteStart.getTime() + MINUTE_MS);
        if (intervalOverlaps(exclusionIntervals, minuteStart, minuteEnd)) {
            break;
        }
        idleStart = minuteStart;
    }
    if (!idleStart) {
        return { minutes: 0, since: null };
    }
    const elapsedMinutes = Math.max(0, Math.ceil((now.getTime() - idleStart.getTime()) / MINUTE_MS));
    return { minutes: elapsedMinutes, since: idleStart };
};
const computeIdleMinutes = (sessions, dayStart, dayEnd, now, exclusionIntervals) => {
    let total = 0;
    for (const session of sessions) {
        for (const stat of session.minuteStats) {
            if (!stat.idle || !stat.active) {
                continue;
            }
            const minuteStart = stat.minuteStart;
            if (minuteStart < dayStart || minuteStart >= dayEnd) {
                continue;
            }
            const minuteEnd = new Date(minuteStart.getTime() + MINUTE_MS);
            if (intervalOverlaps(exclusionIntervals, minuteStart, minuteEnd)) {
                continue;
            }
            total += 1;
        }
    }
    return total;
};
const resolveTimeAwayStatus = (requests, dayStart) => {
    const priority = {
        lunch: 99,
        break: 98,
        active: 97,
        logged_out: 96,
        not_logged_in: 95,
        pto: 0,
        day_off: 1,
        make_up: 2
    };
    const mapped = requests
        .filter((request) => request.status === 'approved')
        .map((request) => {
        if (request.type === 'pto') {
            return { key: 'pto', startDate: request.startDate };
        }
        if (request.type === 'non_pto') {
            return { key: 'day_off', startDate: request.startDate };
        }
        if (request.type === 'make_up') {
            return { key: 'make_up', startDate: request.startDate };
        }
        return null;
    })
        .filter((value) => value !== null);
    if (!mapped.length) {
        return null;
    }
    mapped.sort((a, b) => {
        const rankA = priority[a.key];
        const rankB = priority[b.key];
        if (rankA !== rankB) {
            return rankA - rankB;
        }
        return a.startDate.getTime() - b.startDate.getTime();
    });
    const selection = mapped[0];
    const since = selection.startDate > dayStart ? selection.startDate : dayStart;
    const label = selection.key === 'pto' ? 'PTO' : selection.key === 'day_off' ? 'Day Off' : 'Make up Hours';
    return { key: selection.key, label, since };
};
const buildRosterRow = (user, sessions, requests, badges, dayStart, dayEnd, now) => {
    const sortedSessions = sessions
        .filter((session) => session.userId === user.id)
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    let presenceMisses = 0;
    let firstLogin = null;
    for (const session of sortedSessions) {
        for (const event of session.events) {
            if (event.ts < dayStart || event.ts > dayEnd) {
                continue;
            }
            if (event.type === 'presence_miss') {
                presenceMisses += 1;
            }
            if (event.type === 'login') {
                if (!firstLogin || event.ts < firstLogin) {
                    firstLogin = event.ts;
                }
            }
        }
    }
    if (!firstLogin) {
        const fallback = sortedSessions
            .map((session) => session.startedAt)
            .filter((startedAt) => startedAt >= dayStart && startedAt <= dayEnd)
            .sort((a, b) => a.getTime() - b.getTime())[0];
        if (fallback) {
            firstLogin = fallback;
        }
    }
    const breakIntervals = [];
    const lunchIntervals = [];
    let breakCount = 0;
    let lunchCount = 0;
    for (const session of sortedSessions) {
        for (const pause of session.pauses) {
            if (pause.type !== 'break' && pause.type !== 'lunch') {
                continue;
            }
            if (pause.type === 'break' && pause.startedAt >= dayStart && pause.startedAt <= dayEnd) {
                breakCount += 1;
            }
            if (pause.type === 'lunch' && pause.startedAt >= dayStart && pause.startedAt <= dayEnd) {
                lunchCount += 1;
            }
            const interval = clampIntervalToRange(pause.startedAt, pause.endedAt, now, dayStart, dayEnd);
            if (!interval) {
                continue;
            }
            if (pause.type === 'break') {
                breakIntervals.push(interval);
            }
            else {
                lunchIntervals.push(interval);
            }
        }
    }
    const totalBreakMinutes = sumIntervalsInMinutes(breakIntervals);
    const totalLunchMinutes = sumIntervalsInMinutes(lunchIntervals);
    const pauseIntervals = [...breakIntervals, ...lunchIntervals];
    const totalIdleMinutes = computeIdleMinutes(sortedSessions, dayStart, dayEnd, now, pauseIntervals);
    const activeSession = sortedSessions
        .filter((session) => session.status === 'active')
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .pop() ?? null;
    let statusKey = 'not_logged_in';
    let statusLabel = 'Not Logged In';
    let statusSince = null;
    let idleSince = null;
    let currentIdleMinutes = 0;
    if (activeSession) {
        const activeLunch = activeSession.pauses.find((pause) => pause.type === 'lunch' && !pause.endedAt);
        const activeBreak = activeSession.pauses.find((pause) => pause.type === 'break' && !pause.endedAt);
        if (activeLunch) {
            statusKey = 'lunch';
            const lunchNumber = activeLunch.sequence;
            statusLabel = lunchNumber >= 2 ? `On Lunch (x${lunchNumber})` : 'On Lunch';
            statusSince = activeLunch.startedAt;
        }
        else if (activeBreak) {
            statusKey = 'break';
            statusLabel = `On Break (#${activeBreak.sequence})`;
            statusSince = activeBreak.startedAt;
        }
        else {
            statusKey = 'active';
            statusLabel = 'Active';
            const lastPauseEnd = activeSession.pauses
                .filter((pause) => pause.endedAt && pause.endedAt <= now)
                .reduce((latest, pause) => {
                if (!pause.endedAt) {
                    return latest;
                }
                if (!latest || pause.endedAt > latest) {
                    return pause.endedAt;
                }
                return latest;
            }, null);
            statusSince = lastPauseEnd && lastPauseEnd > activeSession.startedAt ? lastPauseEnd : activeSession.startedAt;
            const idleResult = resolveIdleStreak(activeSession, now, dayStart, pauseIntervals);
            currentIdleMinutes = idleResult.minutes;
            idleSince = idleResult.since;
        }
    }
    else {
        const timeAway = resolveTimeAwayStatus(requests, dayStart);
        if (timeAway) {
            statusKey = timeAway.key;
            statusLabel = timeAway.label;
            statusSince = timeAway.since;
        }
        else {
            const completedSessions = sortedSessions
                .filter((session) => session.endedAt && session.endedAt >= dayStart && session.endedAt <= dayEnd)
                .sort((a, b) => (a.endedAt && b.endedAt ? a.endedAt.getTime() - b.endedAt.getTime() : 0));
            const latestCompleted = completedSessions[completedSessions.length - 1];
            if (latestCompleted && latestCompleted.endedAt) {
                statusKey = 'logged_out';
                statusLabel = 'Logged Out';
                statusSince = latestCompleted.endedAt;
            }
            else {
                statusKey = 'not_logged_in';
                statusLabel = 'Not Logged In';
                statusSince = null;
            }
        }
    }
    return {
        userId: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        statusKey,
        statusLabel,
        statusSince,
        idleSince,
        currentIdleMinutes,
        totalIdleMinutes,
        breakCount,
        totalBreakMinutes,
        lunchCount,
        totalLunchMinutes,
        firstLogin,
        presenceMisses,
        requestBadges: badges
    };
};
const fetchTodayRosterData = async (referenceDate, sessions) => {
    const dayStart = zonedStartOfDay(referenceDate);
    const dayEnd = zonedEndOfDay(referenceDate);
    const now = new Date();
    const users = await prisma_1.prisma.user.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, email: true, role: true }
    });
    if (!users.length) {
        return {
            rows: [],
            totals: {
                totalIdleMinutes: 0,
                breakCount: 0,
                totalBreakMinutes: 0,
                lunchCount: 0,
                totalLunchMinutes: 0,
                presenceMisses: 0
            },
            hasComputedNotice: false
        };
    }
    const userIds = users.map((user) => user.id);
    const userIdSet = new Set(userIds);
    const relevantSessions = sessions.filter((session) => userIdSet.has(session.userId));
    const requests = await prisma_1.prisma.timeRequest.findMany({
        where: {
            userId: { in: userIds },
            status: 'approved',
            startDate: { lte: dayEnd },
            endDate: { gte: dayStart }
        },
        orderBy: { startDate: 'asc' }
    });
    const requestsByUser = new Map();
    for (const request of requests) {
        const bucket = requestsByUser.get(request.userId) ?? [];
        bucket.push(request);
        requestsByUser.set(request.userId, bucket);
    }
    const badgeMap = await collectRequestBadges(userIds, dayStart, dayEnd);
    const rows = users.map((user) => buildRosterRow(user, relevantSessions, requestsByUser.get(user.id) ?? [], badgeMap.get(user.id) ?? [], dayStart, dayEnd, now));
    const totals = rows.reduce((acc, row) => ({
        totalIdleMinutes: acc.totalIdleMinutes + row.totalIdleMinutes,
        breakCount: acc.breakCount + row.breakCount,
        totalBreakMinutes: acc.totalBreakMinutes + row.totalBreakMinutes,
        lunchCount: acc.lunchCount + row.lunchCount,
        totalLunchMinutes: acc.totalLunchMinutes + row.totalLunchMinutes,
        presenceMisses: acc.presenceMisses + row.presenceMisses
    }), {
        totalIdleMinutes: 0,
        breakCount: 0,
        totalBreakMinutes: 0,
        lunchCount: 0,
        totalLunchMinutes: 0,
        presenceMisses: 0
    });
    return {
        rows,
        totals,
        hasComputedNotice: rows.length > 0
    };
};
const renderSinceCell = (since) => {
    if (!since) {
        return '—';
    }
    const iso = formatIsoDateTime(since);
    const label = formatTimeOfDay(since);
    const tooltip = formatDateTime(since);
    return `<span class="since" data-since="${iso}" title="${escapeHtml(tooltip)}"><span class="since__time">${escapeHtml(label)}</span><span class="since__elapsed" data-elapsed></span></span>`;
};
const renderIdleCell = (row) => {
    if (row.statusKey !== 'active') {
        return '—';
    }
    if (!row.idleSince) {
        return String(row.currentIdleMinutes);
    }
    const iso = formatIsoDateTime(row.idleSince);
    return `<span data-idle-since="${iso}" data-idle-minutes="${row.currentIdleMinutes}">${row.currentIdleMinutes}</span>`;
};
const renderTimeCell = (value) => {
    if (!value) {
        return '—';
    }
    const tooltip = formatDateTime(value);
    return `<span title="${escapeHtml(tooltip)}">${escapeHtml(formatTimeOfDay(value))}</span>`;
};
const escapeAttr = (value) => value === null || value === undefined ? '' : escapeHtml(String(value));
const buildTodayRosterRowHtml = (row, dateParam) => {
    const statusClass = `status status--${row.statusKey.replace(/_/g, '-')}`;
    const statusSince = row.statusSince ? formatIsoDateTime(row.statusSince) : '';
    const idleSince = row.idleSince ? formatIsoDateTime(row.idleSince) : '';
    const firstLoginIso = row.firstLogin ? formatIsoDateTime(row.firstLogin) : '';
    const detailHref = `/dashboard/user/${row.userId}?date=${dateParam}`;
    return `<tr
    data-user-id="${row.userId}"
    data-user-name="${escapeAttr(row.name)}"
    data-user-email="${escapeAttr(row.email)}"
    data-user-role="${escapeAttr(row.role)}"
    data-status-key="${escapeAttr(row.statusKey)}"
    data-status-label="${escapeAttr(row.statusLabel)}"
    data-status-detail="${escapeAttr(row.statusDetail ?? '')}"
    data-status-since="${escapeAttr(statusSince)}"
    data-idle-since="${escapeAttr(idleSince)}"
    data-idle-minutes="${row.currentIdleMinutes}"
    data-idle-total="${row.totalIdleMinutes}"
    data-break-count="${row.breakCount}"
    data-break-minutes="${row.totalBreakMinutes}"
    data-lunch-count="${row.lunchCount}"
    data-lunch-minutes="${row.totalLunchMinutes}"
    data-first-login="${escapeAttr(firstLoginIso)}"
    data-presence-misses="${row.presenceMisses}"
    data-detail-url="${escapeAttr(detailHref)}"
  >
    <td>
      ${detailLink(row.userId, dateParam, row.name)}
      ${renderRequestBadges(row.requestBadges)}
    </td>
    <td><span class="${statusClass}">${escapeHtml(row.statusLabel)}</span></td>
    <td>${renderSinceCell(row.statusSince)}</td>
    <td data-idle-cell>${renderIdleCell(row)}</td>
    <td>${row.totalIdleMinutes}</td>
    <td>${row.breakCount}</td>
    <td>${row.totalBreakMinutes}</td>
    <td>${row.lunchCount}</td>
    <td>${row.totalLunchMinutes}</td>
    <td>${renderTimeCell(row.firstLogin)}</td>
    <td>${row.presenceMisses}</td>
  </tr>`;
};
const renderTodayRosterRows = (rows, dateParam) => rows.map((row) => buildTodayRosterRowHtml(row, dateParam)).join('\n');
const renderRosterTotalsRow = (totals) => `
  <tfoot data-roster-totals>
    <tr class="totals">
      <th colspan="4">Totals</th>
      <th>${totals.totalIdleMinutes}</th>
      <th>${totals.breakCount}</th>
      <th>${totals.totalBreakMinutes}</th>
      <th>${totals.lunchCount}</th>
      <th>${totals.totalLunchMinutes}</th>
      <th>—</th>
      <th>${totals.presenceMisses}</th>
    </tr>
  </tfoot>
`;
const fetchDailySummaries = async (referenceDate) => {
    const dayStart = zonedStartOfDay(referenceDate);
    const dayEnd = zonedEndOfDay(referenceDate);
    const now = new Date();
    const sessions = (await prisma_1.prisma.session.findMany({
        where: {
            startedAt: { lte: dayEnd },
            OR: [{ endedAt: null }, { endedAt: { gte: dayStart } }]
        },
        orderBy: { startedAt: 'asc' },
        include: {
            user: true,
            minuteStats: true,
            events: true,
            pauses: true
        }
    }));
    const summaries = sessions
        .filter((session) => session.status === 'active')
        .map((session) => toSummary(session, now))
        .sort((a, b) => b.activeMinutes - a.activeMinutes);
    const requestBadges = await collectRequestBadges(Array.from(new Set(summaries.map((summary) => summary.userId))), dayStart, dayEnd);
    const pauses = collectPauseEntries(sessions, now);
    return {
        dayStart,
        dayEnd,
        dateParam: toDateParam(dayStart),
        label: formatFullDate(dayStart),
        summaries,
        totals: computeTotals(summaries),
        requestBadges,
        pauses,
        sessions
    };
};
exports.fetchDailySummaries = fetchDailySummaries;
const fetchWeeklyAggregates = async (startDate) => {
    const windowStart = zonedStartOfDay(startDate);
    const windowEnd = zonedEndOfDay((0, date_fns_1.addDays)(windowStart, 6));
    const now = new Date();
    const sessions = (await prisma_1.prisma.session.findMany({
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
    }));
    const aggregates = aggregateSessionsByUser(sessions, now);
    const summaries = Array.from(aggregates.values()).sort((a, b) => b.activeMinutes - a.activeMinutes);
    const endDate = (0, date_fns_1.addDays)(windowStart, 6);
    const requestBadges = await collectRequestBadges(Array.from(new Set(summaries.map((summary) => summary.userId))), windowStart, windowEnd);
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
const fetchMonthlyAggregates = async (reference) => {
    const monthStart = zonedStartOfMonth(reference);
    const monthEnd = zonedEndOfMonth(reference);
    const now = new Date();
    const sessions = (await prisma_1.prisma.session.findMany({
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
    }));
    const aggregates = aggregateSessionsByUser(sessions, now);
    const summaries = Array.from(aggregates.values()).sort((a, b) => b.activeMinutes - a.activeMinutes);
    const requestBadges = await collectRequestBadges(Array.from(new Set(summaries.map((summary) => summary.userId))), monthStart, monthEnd);
    return {
        monthStart,
        monthEnd,
        monthParam: (0, date_fns_tz_1.formatInTimeZone)(monthStart, DASHBOARD_TIME_ZONE, 'yyyy-MM'),
        label: (0, date_fns_tz_1.formatInTimeZone)(monthStart, DASHBOARD_TIME_ZONE, 'LLLL yyyy'),
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
  .nav { display: flex; justify-content: space-between; gap: 0.75rem; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .nav__links { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .nav__account { display: flex; align-items: center; gap: 0.75rem; margin-left: auto; }
  .nav__account-label { font-weight: 600; color: #1f2933; }
  .nav__logout-form { margin: 0; }
  .nav__logout-button { background: #ef4444; color: #fff; border: none; border-radius: 999px; padding: 0.45rem 0.9rem; font-weight: 600; cursor: pointer; }
  .nav__logout-button:hover { background: #dc2626; }
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
  .meta--admin { font-size: 0.8rem; color: #2563eb; display: inline-flex; align-items: center; gap: 0.35rem; }
  .meta--admin::before { content: 'ℹ️'; }
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
  .status { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; background: rgba(148,163,184,0.18); color: #334155; }
  .status--active { background: rgba(34,197,94,0.18); color: #047857; }
  .status--break { background: rgba(251,191,36,0.2); color: #b45309; }
  .status--lunch { background: rgba(59,130,246,0.18); color: #1d4ed8; }
  .status--logged-out { background: rgba(148,163,184,0.2); color: #475569; }
  .status--not-logged-in { background: rgba(148,163,184,0.2); color: #475569; }
  .status--pto { background: rgba(251,191,36,0.24); color: #92400e; }
  .status--day-off { background: rgba(203,213,225,0.35); color: #1f2937; }
  .status--make-up { background: rgba(14,165,233,0.18); color: #0369a1; }
  .since { display: inline-flex; align-items: baseline; gap: 0.35rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .since__time { font-weight: 600; color: #0f172a; }
  .since__elapsed { font-size: 0.75rem; color: #64748b; }
  td[data-idle-cell] { font-variant-numeric: tabular-nums; }
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

  /* modern dashboard refresh */
    body.dashboard { font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%); color: #0f172a; }
    body.dashboard main.page-shell { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: clamp(1.25rem, 3vw, 2rem); }
    body.dashboard .nav { background: rgba(255,255,255,0.85); backdrop-filter: blur(12px); padding: 0.6rem 1rem; border-radius: 999px; box-shadow: 0 16px 32px rgba(15,23,42,0.08); position: sticky; top: clamp(0.75rem,2vw,1.25rem); z-index: 20; }
    body.dashboard .nav a { padding: 0.35rem 0.85rem; border-radius: 999px; font-weight: 600; color: #64748b; }
    body.dashboard .nav a.active { background: #2563eb; color: #fff; box-shadow: 0 12px 24px rgba(37,99,235,0.22); border-bottom: none; }
    body.dashboard .nav__account-label { color: #0f172a; }
    body.dashboard .nav__logout-button { background: #dc2626; border-radius: 999px; padding: 0.45rem 1rem; }
    body.dashboard .nav__logout-button:hover { box-shadow: 0 12px 24px rgba(220,38,38,0.25); }
    body.dashboard button,
    body.dashboard .button { border-radius: 999px; padding: 0.55rem 1.3rem; font-weight: 600; }
    body.dashboard button:hover,
    body.dashboard .button:hover { transform: translateY(-1px); box-shadow: 0 12px 24px rgba(37,99,235,0.24); }
    body.dashboard .button-secondary { background: rgba(15,23,42,0.08); color: #0f172a; }
    body.dashboard .button-danger { background: #dc2626; }
    body.dashboard .page-header { background: #fff; border-radius: 22px; box-shadow: 0 24px 45px rgba(15,23,42,0.12); padding: clamp(1.5rem,3vw,2.5rem); display: flex; align-items: flex-start; justify-content: space-between; gap: clamp(1rem,3vw,2rem); flex-wrap: wrap; }
    body.dashboard .page-header__eyebrow { text-transform: uppercase; letter-spacing: 0.12em; color: #64748b; }
    body.dashboard .page-header__content { display: flex; flex-direction: column; gap: 0.65rem; }
    body.dashboard .page-header__title { margin: 0; font-size: clamp(1.75rem, 3.5vw, 2.3rem); color: #0f172a; }
    body.dashboard .page-header__subtitle { margin: 0; color: #475569; max-width: 46ch; font-size: 0.95rem; line-height: 1.5; }
    body.dashboard .page-header__meta { display: grid; gap: 0.35rem; text-align: right; color: #64748b; justify-items: end; }
    body.dashboard .page-header__meta strong { color: #0f172a; }
    body.dashboard .tz-note { font-size: 0.85rem; color: #64748b; display: inline-flex; align-items: center; gap: 0.45rem; margin: 0; }
    body.dashboard .tz-note::before { content: '🕒'; }
    body.dashboard .page-controls { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
    body.dashboard .page-controls .tab-bar { margin: 0; }
    .drilldown-shell { position: fixed; inset: 0; display: flex; justify-content: flex-end; pointer-events: none; z-index: 90; }
    .drilldown-shell[hidden] { display: none; }
    .drilldown-shell[data-open="true"] { pointer-events: auto; }
    .drilldown-backdrop { flex: 1; background: rgba(15,23,42,0.45); opacity: 0; transition: opacity 0.24s ease; }
    .drilldown-shell[data-open="true"] .drilldown-backdrop { opacity: 1; }
    .drilldown-panel { width: min(420px, 92vw); background: #fff; box-shadow: -24px 0 48px rgba(15,23,42,0.18); display: flex; flex-direction: column; max-height: 100vh; transform: translateX(100%); transition: transform 0.28s ease; outline: none; }
    .drilldown-shell[data-open="true"] .drilldown-panel { transform: translateX(0); }
    .drilldown-panel__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; padding: 1.25rem 1.5rem 0.75rem; border-bottom: 1px solid rgba(15,23,42,0.06); }
    .drilldown-panel__heading h2 { margin: 0; font-size: 1.25rem; letter-spacing: -0.01em; color: #0f172a; }
    .drilldown-panel__heading p { margin: 0.35rem 0 0; color: #475569; font-size: 0.9rem; }
    .drilldown-close { background: transparent; border: none; color: #475569; font-size: 1.5rem; line-height: 1; cursor: pointer; padding: 0.25rem; border-radius: 999px; }
    .drilldown-close:hover { color: #dc2626; }
    .drilldown-panel__content { padding: 1.25rem 1.5rem; flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1.25rem; }
    .drilldown-panel__footer { padding: 1rem 1.5rem 1.5rem; border-top: 1px solid rgba(15,23,42,0.08); }
    .drilldown-panel__footer .button { width: 100%; }
    .drilldown-section { background: rgba(37,99,235,0.08); border-radius: 14px; padding: 0.9rem 1rem; }
    .drilldown-section h3 { margin: 0 0 0.6rem; font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; color: #1d4ed8; }
    .drilldown-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.85rem; }
    .drilldown-grid dl { margin: 0; }
    .drilldown-grid dt { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; }
    .drilldown-grid dd { margin: 0.25rem 0 0; font-weight: 600; color: #1f2933; font-size: 0.95rem; }
    .drilldown-pill { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.65rem; border-radius: 999px; background: rgba(148,163,184,0.18); color: #1f2933; font-size: 0.8rem; font-weight: 600; }
    .drilldown-meta { display: block; margin-top: 0.25rem; font-size: 0.75rem; color: #64748b; font-weight: 500; }
    .drilldown-row-active { background: rgba(37,99,235,0.14) !important; }
    .drilldown-locked { overflow: hidden; }
    body.dashboard .tab-bar { display: inline-flex; gap: 0.5rem; background: rgba(37,99,235,0.08); padding: 0.4rem; border-radius: 999px; }
    body.dashboard .tab-bar a { padding: 0.45rem 1rem; border-radius: 999px; font-weight: 600; color: #64748b; background: transparent; }
    body.dashboard .tab-bar a.active { background: #fff; color: #2563eb; box-shadow: 0 10px 20px rgba(37,99,235,0.22); }
    body.dashboard .cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px,1fr)); gap: clamp(1rem,3vw,1.75rem); align-items: stretch; }
    body.dashboard .card { background: #fff; border-radius: 20px; box-shadow: 0 24px 45px rgba(15,23,42,0.12); padding: clamp(1.25rem,2.5vw,1.75rem); display: flex; flex-direction: column; gap: 1.25rem; }
    body.dashboard .card__header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start; justify-content: space-between; }
    body.dashboard .card__title { color: #0f172a; font-size: 1.15rem; margin: 0; }
    body.dashboard .card__subtitle { color: #64748b; font-size: 0.9rem; max-width: 36ch; margin: 0; }
    body.dashboard .card__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; justify-content: flex-end; }
    body.dashboard .card__body { display: flex; flex-direction: column; gap: 1rem; }
    body.dashboard .summary-card { background: rgba(37,99,235,0.1); color: #2563eb; border-radius: 16px; box-shadow: none; }
    body.dashboard .summary-title { letter-spacing: 0.08em; color: rgba(37,99,235,0.75); }
    body.dashboard .summary-meta { color: rgba(37,99,235,0.75); }
    body.dashboard .table-scroll { background: rgba(15,23,42,0.03); padding: 0.5rem; border-radius: 18px; }
    body.dashboard .table-scroll table { background: #fff; border-radius: 16px; }
    body.dashboard .table-scroll table tbody tr:hover { background: rgba(37,99,235,0.08); }
    body.dashboard .alert { border-radius: 14px; }
    body.dashboard .alert.success { background: rgba(22,163,74,0.14); color: #16a34a; }
    body.dashboard .alert.error { background: rgba(220,38,38,0.14); color: #dc2626; }
    body.dashboard .empty { background: rgba(15,23,42,0.03); color: #64748b; border-radius: 16px; }
    @media (max-width: 960px) {
      body.dashboard .page-header { text-align: center; flex-direction: column; align-items: stretch; }
      body.dashboard .page-header__meta { text-align: center; justify-items: center; }
    }
    @media (max-width: 720px) {
      body.dashboard .cards-grid { grid-template-columns: 1fr; }
      body.dashboard .filters { flex-direction: column; align-items: stretch; }
      body.dashboard .filters label { width: 100%; }
      body.dashboard button,
      body.dashboard .button { width: 100%; justify-content: center; }
      body.dashboard .page-controls { flex-direction: column; align-items: stretch; }
      .drilldown-panel__footer .button { width: 100%; }
      body.dashboard .table-scroll table { min-width: 520px; }
    }
`;
const formatRangeLabel = (start, end) => end && end.getTime() !== start.getTime() ? `${formatFullDate(start)} – ${formatFullDate(end)}` : formatFullDate(start);
const renderTimezoneNote = (start, end) => `<p class="tz-note">All times shown in ${escapeHtml(DASHBOARD_TIME_ZONE)} (${escapeHtml(formatRangeLabel(start, end))})</p>`;
const renderNav = (active) => {
    const link = (href, label, key) => `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`;
    const links = [
        link('/dashboard/overview', 'Overview', 'overview'),
        link('/dashboard/today', 'Today', 'today'),
        link('/dashboard/weekly', 'Weekly', 'weekly'),
        link('/dashboard/monthly', 'Monthly', 'monthly'),
        link('/dashboard/timesheets', 'Timesheets', 'timesheets'),
        link('/dashboard/requests', 'Requests', 'requests'),
        link('/dashboard/balances', 'Balances', 'balances'),
        link('/dashboard/settings', 'Settings', 'settings')
    ];
    return `<nav class="nav no-print">
    <div class="nav__links">${links.join('')}</div>
    <div class="nav__account">
      <span class="nav__account-label">My Profile</span>
      <form method="post" action="/dashboard/logout" class="nav__logout-form">
        <button type="submit" class="nav__logout-button">Log Out</button>
      </form>
    </div>
  </nav>`;
};
const setDashboardTokenCookie = (res, token) => {
    res.cookie(auth_1.DASHBOARD_TOKEN_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION,
        maxAge: DASHBOARD_COOKIE_MAX_AGE_MS,
        path: DASHBOARD_COOKIE_PATH
    });
};
const clearDashboardTokenCookie = (res) => {
    res.cookie(auth_1.DASHBOARD_TOKEN_COOKIE_NAME, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION,
        maxAge: 0,
        path: DASHBOARD_COOKIE_PATH
    });
};
const runMiddleware = (req, res, handler) => new Promise((resolve, reject) => {
    handler(req, res, (err) => {
        if (err) {
            reject(err);
        }
        else {
            resolve();
        }
    });
});
const adminRoleMiddleware = (0, auth_1.requireRole)(['admin', 'manager']);
const ensureDashboardAuthenticated = async (req, res, next) => {
    const authReq = req;
    try {
        await runMiddleware(authReq, res, auth_1.authenticate);
        await runMiddleware(authReq, res, adminRoleMiddleware);
        return next();
    }
    catch (error) {
        if (error instanceof errors_1.HttpError && isHtmlRequest(req)) {
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
exports.dashboardRouter = (0, express_1.Router)();
// Dev-only bypass for local debugging. Set DASHBOARD_ALLOW_ANON=true to skip auth.
const allowAnonDashboard = process.env.DASHBOARD_ALLOW_ANON === 'true';
if (!allowAnonDashboard) {
    exports.dashboardRouter.get('/login', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
        const redirectTo = sanitizeRedirect(req.query.redirect);
        const token = (0, auth_1.extractTokenFromRequest)(req);
        if (token) {
            try {
                const { user } = await (0, auth_1.resolveUserFromToken)(token);
                if (isDashboardRole(user.role)) {
                    return res.redirect(redirectTo);
                }
                clearDashboardTokenCookie(res);
            }
            catch {
                clearDashboardTokenCookie(res);
            }
        }
        const errorCode = typeof req.query.error === 'string' ? req.query.error : undefined;
        const messageCode = typeof req.query.message === 'string' ? req.query.message : undefined;
        res.type('text/html').send(renderLoginPage({
            redirectTo,
            errorCode,
            messageCode
        }));
    }));
    exports.dashboardRouter.post('/login', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
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
        const user = await prisma_1.prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (!user || !isDashboardRole(user.role)) {
            return res
                .status(401)
                .type('text/html')
                .send(renderLoginPage({ redirectTo, email: emailInput, errorCode: 'invalid' }));
        }
        const passwordOk = await (0, auth_1.verifyPassword)(parsed.data.password, user.passwordHash);
        if (!passwordOk) {
            return res
                .status(401)
                .type('text/html')
                .send(renderLoginPage({ redirectTo, email: emailInput, errorCode: 'invalid' }));
        }
        const token = (0, auth_1.generateToken)(user);
        setDashboardTokenCookie(res, token);
        return res.redirect(redirectTo);
    }));
    exports.dashboardRouter.post('/logout', (req, res) => {
        clearDashboardTokenCookie(res);
        const redirectTo = sanitizeRedirect(req.body?.redirect ?? req.query.redirect);
        const params = new URLSearchParams({ message: 'logged_out' });
        if (redirectTo && redirectTo !== DEFAULT_DASHBOARD_REDIRECT) {
            params.set('redirect', redirectTo);
        }
        res.redirect(`${DASHBOARD_LOGIN_ROUTE}?${params.toString()}`);
    });
    exports.dashboardRouter.use((req, res, next) => ensureDashboardAuthenticated(req, res, next));
}
else {
    // no-op auth in dev
    exports.dashboardRouter.use((req, _res, next) => next());
}
exports.dashboardRouter.get('/', (_req, res) => {
    res.redirect(DEFAULT_DASHBOARD_REDIRECT);
});
exports.dashboardRouter.get('/today', async (req, res) => {
    const requestedDate = typeof req.query.date === 'string' ? parseDateParam(req.query.date) : zonedStartOfDay(new Date());
    const dailyData = await (0, exports.fetchDailySummaries)(requestedDate);
    const { dayStart, dayEnd, dateParam, label, summaries, totals, requestBadges, pauses } = dailyData;
    const requestedDateParam = typeof req.query.date === 'string' && req.query.date.trim().length > 0 ? req.query.date.trim() : dateParam;
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
        const rows = summaries.map((summary) => [
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
        ].join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="today-${dateParam}.csv"`);
        return res.send(csv);
    }
    const tableRows = summaries
        .map((summary) => buildTodayRow(summary, dateParam, requestBadges.get(summary.userId) ?? []))
        .join('\n');
    const totalsRow = renderTotalsRow(totals, 3);
    const timezoneNote = renderTimezoneNote(dayStart, dayEnd);
    const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
        <title>Attendance Dashboard – ${escapeHtml(label)}</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--today">
        ${renderNav('today')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Attendance</p>
              <h1 class="page-header__title">Daily Sessions</h1>
              <p class="page-header__subtitle">Detailed activity, pauses, and presence checks for ${escapeHtml(label)}.</p>
            </div>
            <div class="page-header__meta">
              ${timezoneNote}
            </div>
          </header>
          <div class="cards-grid">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Session Metrics</h2>
                  <p class="card__subtitle">${escapeHtml(label)} • ${summaries.length} ${summaries.length === 1 ? 'record' : 'records'}</p>
                </div>
                <div class="card__actions no-print">
                  <form method="get" action="/dashboard/today" class="filters">
                    <label>
                      <span>Date</span>
                      <input type="date" name="date" value="${escapeHtml(requestedDateParam)}" />
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
              </div>
              <div class="card__body">
                ${tableRows
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
        : '<div class="empty">No sessions recorded for this date.</div>'}
              </div>
            </section>
            <section class="card card--detail">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Breaks and Lunches</h2>
                  <p class="card__subtitle">Sequence and duration for recorded pauses.</p>
                </div>
              </div>
              <div class="card__body">
                ${renderPauseTable(pauses)}
              </div>
            </section>
          </div>
        </main>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/weekly', async (req, res) => {
    const today = zonedStartOfDay(new Date());
    const baseStart = typeof req.query.start === 'string' ? parseDateParam(req.query.start) : (0, date_fns_1.subDays)(today, 6);
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
        const rows = summaries.map((summary) => [
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
        ].join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="weekly-${startParam}.csv"`);
        return res.send(csv);
    }
    const tableRows = summaries
        .map((summary, index) => buildWeeklyRow(summary, index, startParam, requestBadges.get(summary.userId) ?? []))
        .join('\n');
    const totalsRow = renderTotalsRow(totals, 3);
    const timezoneNote = renderTimezoneNote(windowStart, windowEnd);
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Weekly Attendance Summary</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--weekly">
        ${renderNav('weekly')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Attendance</p>
              <h1 class="page-header__title">Weekly Summary</h1>
              <p class="page-header__subtitle">Activity, pauses, and presence insights for the week of ${escapeHtml(label)}.</p>
            </div>
            <div class="page-header__meta">
              ${timezoneNote}
            </div>
          </header>
          <div class="cards-grid">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Team Overview</h2>
                  <p class="card__subtitle">${summaries.length} ${summaries.length === 1 ? 'teammate' : 'teammates'} recorded during this range.</p>
                </div>
                <div class="card__actions no-print">
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
              </div>
              <div class="card__body">
                ${tableRows
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
        : '<div class="empty">No activity recorded for this range.</div>'}
              </div>
            </section>
          </div>
        </main>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/monthly', async (req, res) => {
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
        const rows = summaries.map((summary) => [
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
        ].join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="monthly-${monthParam}.csv"`);
        return res.send(csv);
    }
    const tableRows = summaries
        .map((summary, index) => buildWeeklyRow(summary, index, formatIsoDate(monthStart), requestBadges.get(summary.userId) ?? []))
        .join('\n');
    const totalsRow = renderTotalsRow(totals, 3);
    const timezoneNote = renderTimezoneNote(monthStart, monthEnd);
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${label} Attendance Summary</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--monthly">
        ${renderNav('monthly')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Attendance</p>
              <h1 class="page-header__title">Monthly Summary</h1>
              <p class="page-header__subtitle">Comprehensive metrics for ${escapeHtml(label)}.</p>
            </div>
            <div class="page-header__meta">
              ${timezoneNote}
            </div>
          </header>
          <div class="cards-grid">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Team Overview</h2>
                  <p class="card__subtitle">${summaries.length} ${summaries.length === 1 ? 'teammate' : 'teammates'} recorded this month.</p>
                </div>
                <div class="card__actions no-print">
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
              </div>
              <div class="card__body">
                ${tableRows
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
        : '<div class="empty">No activity recorded for this month.</div>'}
              </div>
            </section>
          </div>
        </main>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/timesheets', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const rawView = typeof req.query.view === 'string' ? req.query.view : undefined;
    const normalizedView = rawView && types_1.TIMESHEET_VIEWS.includes(rawView)
        ? rawView
        : 'pay_period';
    const rawDate = typeof req.query.date === 'string' ? req.query.date : '';
    const rawMonth = typeof req.query.month === 'string' ? req.query.month : '';
    const message = typeof req.query.message === 'string' ? req.query.message : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    const reference = normalizedView === 'monthly' ? parseMonthParam(rawMonth || rawDate) : parseDateParam(rawDate);
    const range = (0, timesheets_1.computeTimesheetRange)(normalizedView, reference);
    const dateValue = normalizedView === 'monthly' ? rawDate : rawDate || toDateParam(range.start);
    const monthValue = normalizedView === 'monthly'
        ? rawMonth || (0, date_fns_tz_1.formatInTimeZone)(range.start, DASHBOARD_TIME_ZONE, 'yyyy-MM')
        : rawMonth;
    const employees = await prisma_1.prisma.user.findMany({
        where: { role: 'employee' },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, email: true, active: true }
    });
    const summaries = await Promise.all(employees.map(async (employee) => ({
        employee,
        summary: await (0, timesheets_1.getUserTimesheet)(employee.id, normalizedView, reference)
    })));
    const aggregate = summaries.reduce((acc, entry) => ({
        activeMinutes: acc.activeMinutes + entry.summary.totals.activeMinutes,
        idleMinutes: acc.idleMinutes + entry.summary.totals.idleMinutes,
        breaks: acc.breaks + entry.summary.totals.breaks,
        lunches: acc.lunches + entry.summary.totals.lunches,
        presence: acc.presence + entry.summary.totals.presenceMisses
    }), { activeMinutes: 0, idleMinutes: 0, breaks: 0, lunches: 0, presence: 0 });
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
    const editRequests = await prisma_1.prisma.timesheetEditRequest.findMany({
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
                      ${types_1.TIMESHEET_EDIT_STATUSES.map((value) => `<option value="${value}"${request.status === value ? ' selected' : ''}>${formatTimesheetStatus(value)}</option>`).join('')}
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
    const viewOptions = types_1.TIMESHEET_VIEWS
        .map((value) => `<option value="${value}"${value === normalizedView ? ' selected' : ''}>${escapeHtml(timesheetViewLabel(value))}</option>`)
        .join('');
    const timezoneNote = renderTimezoneNote(range.start, range.end);
    const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Timesheet Review</title>
          <style>${baseStyles}</style>
        </head>
        <body class="dashboard dashboard--timesheets">
          ${renderNav('timesheets')}
          <main class="page-shell">
            <header class="page-header">
              <div class="page-header__content">
                <p class="page-header__eyebrow">Attendance</p>
                <h1 class="page-header__title">Timesheet Review</h1>
                <p class="page-header__subtitle">Inspect employee activity and edits for ${escapeHtml(range.label)}.</p>
              </div>
              <div class="page-header__meta">
                ${timezoneNote}
              </div>
            </header>
            ${message ? `<div class="alert success no-print">${escapeHtml(message)}</div>` : ''}
            ${error ? `<div class="alert error no-print">${escapeHtml(error)}</div>` : ''}
            <div class="cards-grid">
              <section class="card card--filters no-print">
                <div class="card__header">
                  <h2 class="card__title">Filters</h2>
                </div>
                <div class="card__body">
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
                </div>
              </section>
              ${aggregateCards
        ? `<section class="card card--summary">
                      <div class="card__header">
                        <h2 class="card__title">Team Summary</h2>
                        <p class="card__subtitle">Aggregate metrics across all employees.</p>
                      </div>
                      <div class="card__body">
                        ${aggregateCards}
                      </div>
                    </section>`
        : ''}
            </div>
            ${employeeSections}
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Edit Requests</h2>
                  <p class="card__subtitle">Submitted changes for this period.</p>
                </div>
              </div>
              <div class="card__body">
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
              </div>
            </section>
          </main>
        </body>
      </html>
    `;
    res.type('html').send(html);
}));
exports.dashboardRouter.post('/timesheets/requests/:id', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
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
    if (typeof status !== 'string' || !types_1.TIMESHEET_EDIT_STATUSES.includes(status)) {
        const redirect = params.size ? `${baseUrl}&error=${encodeURIComponent('Invalid status')}` : `${baseUrl}?error=${encodeURIComponent('Invalid status')}`;
        return res.redirect(redirect);
    }
    const request = await prisma_1.prisma.timesheetEditRequest.findUnique({ where: { id } });
    if (!request) {
        const redirect = params.size ? `${baseUrl}&error=${encodeURIComponent('Request not found')}` : `${baseUrl}?error=${encodeURIComponent('Request not found')}`;
        return res.redirect(redirect);
    }
    const trimmedNote = typeof adminNote === 'string' ? adminNote.trim() : '';
    const updates = {
        status,
        adminNote: trimmedNote.length ? trimmedNote : null
    };
    if (status === 'pending') {
        updates.reviewedAt = null;
        updates.reviewer = { disconnect: true };
    }
    else {
        updates.reviewedAt = new Date();
        updates.reviewer = { connect: { id: req.user.id } };
    }
    await prisma_1.prisma.timesheetEditRequest.update({ where: { id }, data: updates });
    const redirect = params.size ? `${baseUrl}&message=${encodeURIComponent('Request updated.')}` : `${baseUrl}?message=${encodeURIComponent('Request updated.')}`;
    return res.redirect(redirect);
}));
exports.dashboardRouter.get('/requests', async (req, res) => {
    const statusParamRaw = typeof req.query.status === 'string' ? req.query.status.toLowerCase() : '';
    const typeParamRaw = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : '';
    const fromDate = parseDateOnlyParam(req.query.from);
    const toDate = parseDateOnlyParam(req.query.to);
    const selectedStatus = types_1.TIME_REQUEST_STATUSES.find((status) => status === statusParamRaw);
    const selectedType = types_1.TIME_REQUEST_TYPES.find((type) => type === typeParamRaw);
    const filters = {};
    const rangeConditions = [];
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
    const requests = await prisma_1.prisma.timeRequest.findMany({
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
        const rows = requests.map((request) => [
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
        ].join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="time-requests.csv"');
        return res.send(csv);
    }
    const makeUpUserIds = Array.from(new Set(requests.filter((request) => request.type === 'make_up').map((request) => request.userId)));
    const makeupCap = makeUpUserIds.length ? await (0, timeRequestPolicy_1.getMakeupCapHoursPerMonth)() : undefined;
    const makeupUsage = makeUpUserIds.length
        ? await (0, timeRequestPolicy_1.getApprovedMakeupHoursThisMonthByUser)(prisma_1.prisma, makeUpUserIds)
        : new Map();
    const statusValue = selectedStatus ?? '';
    const typeValue = selectedType ?? '';
    const fromValue = fromDate ? toDateParam(fromDate) : '';
    const toValue = toDate ? toDateParam(toDate) : '';
    const statusOptions = [
        { value: '', label: 'All Statuses' },
        ...types_1.TIME_REQUEST_STATUSES.map((value) => ({ value, label: requestStatusLabels[value] }))
    ];
    const typeOptions = [
        { value: '', label: 'All Types' },
        ...types_1.TIME_REQUEST_TYPES.map((value) => ({ value, label: requestTypeLabels[value] }))
    ];
    const tableRows = requests
        .map((request) => {
        const typeLabel = requestTypeLabels[request.type];
        const statusLabel = requestStatusLabels[request.status];
        const typeBadge = `<span class="badge badge-${request.type}">${escapeHtml(typeLabel)}</span>`;
        const statusBadge = `<span class="badge badge-status-${request.status}">${escapeHtml(statusLabel)}</span>`;
        const rangeLabel = `${formatShortDate(request.startDate)} – ${formatShortDate(request.endDate)}`;
        const approverLabel = request.approver
            ? `${escapeHtml(request.approver.name)}<div class="meta">${escapeHtml(request.approver.email)}</div>`
            : '—';
        const hoursMeta = request.type === 'make_up' && makeupCap !== undefined
            ? (() => {
                const usedHours = makeupUsage.get(request.userId) ?? 0;
                const remaining = (0, timeRequestPolicy_1.remainingHoursWithinCap)(usedHours, makeupCap);
                const usedLabel = `${formatHours(usedHours)}h`;
                const remainingLabel = `${formatHours(remaining)}h`;
                return `<div class="meta">Used/Remaining this month: ${escapeHtml(usedLabel)} / ${escapeHtml(remainingLabel)}</div>`;
            })()
            : '';
        const actions = request.status === 'pending'
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
    const timezoneNote = renderTimezoneNote(rangeStartForNote, rangeEndForNote);
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Time Requests</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--requests">
        ${renderNav('requests')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Attendance</p>
              <h1 class="page-header__title">Time Requests</h1>
              <p class="page-header__subtitle">Review submitted PTO, non-PTO, and make-up requests.</p>
            </div>
            <div class="page-header__meta">
              <span>${requests.length} ${requests.length === 1 ? 'request' : 'requests'} listed</span>
              ${timezoneNote}
            </div>
          </header>
          <div class="cards-grid">
            <section class="card card--filters no-print">
              <div class="card__header">
                <h2 class="card__title">Filters</h2>
              </div>
              <div class="card__body">
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
                    <input type="date" name="from" value="${escapeHtml(fromValue)}" />
                  </label>
                  <label>
                    <span>To</span>
                    <input type="date" name="to" value="${escapeHtml(toValue)}" />
                  </label>
                  <div class="filters__actions">
                    <button type="submit">Apply</button>
                  </div>
                </form>
                <form method="get" action="/dashboard/requests" class="filters filters--inline">
                  <input type="hidden" name="status" value="${escapeHtml(statusValue)}" />
                  <input type="hidden" name="type" value="${escapeHtml(typeValue)}" />
                  <input type="hidden" name="from" value="${escapeHtml(fromValue)}" />
                  <input type="hidden" name="to" value="${escapeHtml(toValue)}" />
                  <input type="hidden" name="download" value="csv" />
                  <button type="submit">Download CSV</button>
                  <button type="button" class="print-button" onclick="window.print()">Print</button>
                </form>
              </div>
            </section>
          </div>
          <section class="card card--table">
            <div class="card__header">
              <div>
                <h2 class="card__title">Request Log</h2>
                <p class="card__subtitle">Sorted newest first.</p>
              </div>
            </div>
            <div class="card__body">
              ${tableRows
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
        : '<div class="empty">No requests match the selected filters.</div>'}
            </div>
          </section>
        </main>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/overview', async (req, res) => {
    const viewParam = typeof req.query.view === 'string' ? req.query.view.toLowerCase() : 'today';
    const activeView = viewParam === 'weekly' ? 'weekly' : viewParam === 'monthly' ? 'monthly' : 'today';
    const dateInput = typeof req.query.date === 'string' ? parseDateParam(req.query.date) : zonedStartOfDay(new Date());
    const weekStartInput = typeof req.query.start === 'string' ? parseDateParam(req.query.start) : (0, date_fns_1.subDays)(zonedStartOfDay(new Date()), 6);
    const monthInput = parseMonthParam(req.query.month);
    const [dailyData, weeklyData, monthlyData] = await Promise.all([
        (0, exports.fetchDailySummaries)(dateInput),
        fetchWeeklyAggregates(weekStartInput),
        fetchMonthlyAggregates(monthInput)
    ]);
    const formDateParam = typeof req.query.date === 'string' && req.query.date.trim().length > 0 ? req.query.date.trim() : dailyData.dateParam;
    const formStartParam = typeof req.query.start === 'string' && req.query.start.trim().length > 0 ? req.query.start.trim() : weeklyData.startParam;
    const formMonthParam = typeof req.query.month === 'string' && req.query.month.trim().length > 0 ? req.query.month.trim() : monthlyData.monthParam;
    const rangeStartForNote = activeView === 'today'
        ? dailyData.dayStart
        : activeView === 'weekly'
            ? weeklyData.windowStart
            : monthlyData.monthStart;
    const rangeEndForNote = activeView === 'today'
        ? dailyData.dayEnd
        : activeView === 'weekly'
            ? weeklyData.windowEnd
            : monthlyData.monthEnd;
    const rosterData = await fetchTodayRosterData(dateInput, dailyData.sessions);
    const todayRows = renderTodayRosterRows(rosterData.rows, dailyData.dateParam);
    const todayTotals = rosterData.rows.length ? renderRosterTotalsRow(rosterData.totals) : '';
    const computedNotice = rosterData.hasComputedNotice
        ? '<p class="meta meta--admin">Idle, break, and lunch totals are computed from today\'s activity history.</p>'
        : '';
    const hasRosterRows = rosterData.rows.length > 0;
    const noticeHiddenClass = rosterData.hasComputedNotice ? '' : ' hidden';
    const weeklyRows = weeklyData.summaries
        .map((summary, index) => buildWeeklyRow(summary, index, weeklyData.startParam, weeklyData.requestBadges.get(summary.userId) ?? []))
        .join('\n');
    const weeklyTotals = renderTotalsRow(weeklyData.totals, 3);
    const monthlyRows = monthlyData.summaries
        .map((summary, index) => buildWeeklyRow(summary, index, formatIsoDate(monthlyData.monthStart), monthlyData.requestBadges.get(summary.userId) ?? []))
        .join('\n');
    const monthlyTotals = renderTotalsRow(monthlyData.totals, 3);
    const tabLink = (key, label, href) => `<a href="${href}"${activeView === key ? ' class="active"' : ''}>${label}</a>`;
    const tabBar = `<div class="tab-bar no-print">
      ${tabLink('today', 'Today', `/dashboard/overview?view=today&date=${dailyData.dateParam}`)}
      ${tabLink('weekly', 'Weekly', `/dashboard/overview?view=weekly&start=${weeklyData.startParam}`)}
      ${tabLink('monthly', 'Monthly', `/dashboard/overview?view=monthly&month=${monthlyData.monthParam}`)}
    </div>`;
    const timezoneNote = renderTimezoneNote(rangeStartForNote, rangeEndForNote);
    const todaySection = `
      <section class="tab-content card${activeView === 'today' ? '' : ' hidden'}" id="tab-today">
        <div class="card__header">
          <div>
            <h2 class="card__title">Today</h2>
            <p class="card__subtitle">${dailyData.label}</p>
          </div>
          <div class="card__actions no-print">
            <form method="get" action="/dashboard/overview" class="filters">
              <input type="hidden" name="view" value="today" />
              <label>
                <span>Date</span>
                <input type="date" name="date" value="${escapeHtml(formDateParam)}" />
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
        </div>
        <div class="card__body">
          <div data-roster-notice class="${noticeHiddenClass}">${computedNotice}</div>
          <div class="table-scroll${hasRosterRows ? '' : ' hidden'}" data-roster-container>
            <table data-roster-table data-date-param="${dailyData.dateParam}">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Current Status</th>
                  <th>Since</th>
                  <th>Current Idle (min)</th>
                  <th>Total Idle Today (min)</th>
                  <th>Break # Today</th>
                  <th>Total Break Minutes</th>
                  <th>Lunch Count</th>
                  <th>Total Lunch Minutes</th>
                  <th>First Login</th>
                  <th>Presence Misses</th>
                </tr>
              </thead>
              <tbody data-roster-body>
                ${todayRows}
              </tbody>
              ${todayTotals}
            </table>
          </div>
          <div class="empty${hasRosterRows ? ' hidden' : ''}" data-roster-empty>No users available for this date.</div>
        </div>
      </section>
    `;
    const weeklySection = `
      <section class="tab-content card${activeView === 'weekly' ? '' : ' hidden'}" id="tab-weekly">
        <div class="card__header">
          <div>
            <h2 class="card__title">Weekly</h2>
            <p class="card__subtitle">${weeklyData.label}</p>
          </div>
          <div class="card__actions no-print">
            <form method="get" action="/dashboard/overview" class="filters">
              <input type="hidden" name="view" value="weekly" />
              <label>
                <span>Week starting</span>
                <input type="date" name="start" value="${escapeHtml(formStartParam)}" />
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
        </div>
        <div class="card__body">
          ${weeklyRows
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
        : '<div class="empty">No activity recorded for this range.</div>'}
        </div>
      </section>
    `;
    const monthlySection = `
      <section class="tab-content card${activeView === 'monthly' ? '' : ' hidden'}" id="tab-monthly">
        <div class="card__header">
          <div>
            <h2 class="card__title">Monthly</h2>
            <p class="card__subtitle">${monthlyData.label}</p>
          </div>
          <div class="card__actions no-print">
            <form method="get" action="/dashboard/overview" class="filters">
              <input type="hidden" name="view" value="monthly" />
              <label>
                <span>Month</span>
                <input type="month" name="month" value="${escapeHtml(formMonthParam)}" />
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
        </div>
        <div class="card__body">
          ${monthlyRows
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
        : '<div class="empty">No activity recorded for this month.</div>'}
        </div>
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
        <body class="dashboard dashboard--overview">
          ${renderNav('overview')}
          <main class="page-shell">
            <header class="page-header">
              <div class="page-header__content">
                <p class="page-header__eyebrow">Attendance</p>
                <h1 class="page-header__title">Dashboard Overview</h1>
                <p class="page-header__subtitle">Live roster snapshots and trends across today, this week, and the current month.</p>
              </div>
              <div class="page-header__meta">
                <span><strong>${dailyData.label}</strong> (Today)</span>
                <span>Week of <strong>${weeklyData.label}</strong></span>
                <span>Month of <strong>${monthlyData.label}</strong></span>
                ${timezoneNote}
              </div>
            </header>
            <div class="page-controls">
              ${tabBar}
            </div>
            <div class="cards-grid">
              ${todaySection}
              ${weeklySection}
              ${monthlySection}
            </div>
          </main>
          <div class="drilldown-shell no-print" data-drilldown-shell hidden>
            <div class="drilldown-backdrop" data-drilldown-backdrop></div>
            <aside class="drilldown-panel" role="dialog" aria-modal="true" aria-hidden="true" tabindex="-1" data-drilldown-panel>
              <div class="drilldown-panel__header">
                <div class="drilldown-panel__heading">
                  <h2 data-drilldown-title>Team member</h2>
                  <p data-drilldown-subtitle></p>
                </div>
                <button type="button" class="drilldown-close" aria-label="Close panel" data-drilldown-close>&times;</button>
              </div>
              <div class="drilldown-panel__content" data-drilldown-content></div>
              <div class="drilldown-panel__footer" data-drilldown-footer></div>
            </aside>
          </div>
          <script>
            (() => {
              const table = document.querySelector('[data-roster-table]');
              const shell = document.querySelector('[data-drilldown-shell]');
              const panel = shell ? shell.querySelector('[data-drilldown-panel]') : null;
              const backdrop = shell ? shell.querySelector('[data-drilldown-backdrop]') : null;
              const closeButtons = shell ? Array.from(shell.querySelectorAll('[data-drilldown-close]')) : [];
              const panelContent = panel ? panel.querySelector('[data-drilldown-content]') : null;
              const panelFooter = panel ? panel.querySelector('[data-drilldown-footer]') : null;
              const panelTitle = panel ? panel.querySelector('[data-drilldown-title]') : null;
              const panelSubtitle = panel ? panel.querySelector('[data-drilldown-subtitle]') : null;
              const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1")]';

              const toNumber = (value) => {
                const num = Number(value);
                return Number.isFinite(num) ? num : null;
              };

              const formatDateTimeSafe = (iso) => {
                if (!iso) return '—';
                const date = new Date(iso);
                if (Number.isNaN(date.getTime())) return '—';
                return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
              };

              const formatElapsedIso = (iso) => {
                if (!iso) return '';
                const ts = Date.parse(iso);
                if (Number.isNaN(ts)) return '';
                const diffMs = Date.now() - ts;
                if (diffMs <= 0) return 'Just now';
                const minutes = Math.floor(diffMs / 60000);
                if (minutes < 1) return 'Just now';
                const hours = Math.floor(minutes / 60);
                const remainder = minutes % 60;
                const parts = [];
                if (hours > 0) parts.push(hours + 'h');
                if (hours === 0 || remainder > 0) parts.push(remainder + 'm');
                return parts.join(' ') + ' ago';
              };

              const formatMinutesValue = (value) => {
                if (value === null || value === undefined) return '—';
                return String(value) + ' min';
              };

              const formatCountValue = (value) => {
                if (value === null || value === undefined) return '—';
                return String(value);
              };

              const escapeHtmlClient = (value) =>
                String(value)
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;');

              const buildStat = (label, value, meta) => {
                const safeLabel = escapeHtmlClient(label);
                const safeValue = escapeHtmlClient(value === undefined || value === null || value === '' ? '—' : value);
                const metaHtml = meta ? '<span class="drilldown-meta">' + escapeHtmlClient(meta) + '</span>' : '';
                return '<dl><dt>' + safeLabel + '</dt><dd>' + safeValue + metaHtml + '</dd></dl>';
              };

              const createPanelController = ({ shell, panel, backdrop, closeButtons, content, footer, titleEl, subtitleEl }) => {
                if (!shell || !panel || !backdrop || !content || !footer || !titleEl || !subtitleEl) {
                  return null;
                }

                let open = false;
                let activeRow = null;
                let cleanupTimer = null;
                let lastFocused = null;

                const highlight = (row, state) => {
                  if (!row) return;
                  row.classList.toggle('drilldown-row-active', Boolean(state));
                };

                const getBadgesHtml = (row) => {
                  const firstCell = row.cells[0];
                  const badges = firstCell ? firstCell.querySelector('.badges') : null;
                  return badges ? badges.outerHTML : '';
                };

                const getRowData = (row) => {
                  const ds = row.dataset;
                  const statusCell = row.cells[1];
                  return {
                    name: ds.userName || row.cells[0]?.innerText?.trim() || 'Unknown teammate',
                    email: ds.userEmail || '',
                    role: ds.userRole || '',
                    statusLabel: ds.statusLabel || '',
                    statusDetail: ds.statusDetail || '',
                    statusSince: ds.statusSince || '',
                    idleSince: ds.idleSince || '',
                    idleMinutes: toNumber(ds.idleMinutes),
                    idleTotal: toNumber(ds.idleTotal),
                    breakCount: toNumber(ds.breakCount),
                    breakMinutes: toNumber(ds.breakMinutes),
                    lunchCount: toNumber(ds.lunchCount),
                    lunchMinutes: toNumber(ds.lunchMinutes),
                    firstLogin: ds.firstLogin || '',
                    presenceMisses: toNumber(ds.presenceMisses),
                    detailUrl: ds.detailUrl || '',
                    statusHtml: statusCell ? statusCell.innerHTML : escapeHtmlClient(ds.statusLabel || ''),
                    badgesHtml: getBadgesHtml(row)
                  };
                };

                const renderContent = (row) => {
                  const data = getRowData(row);
                  titleEl.textContent = data.name;
                  const subtitleParts = [];
                  if (data.email) subtitleParts.push(data.email);
                  if (data.role) subtitleParts.push(data.role);
                  subtitleEl.textContent = subtitleParts.join(' • ');

                  const statusSinceLabel = formatDateTimeSafe(data.statusSince);
                  const statusSinceMeta = formatElapsedIso(data.statusSince);
                  const currentIdleMeta = data.idleSince ? formatElapsedIso(data.idleSince) : '';
                  const firstLoginLabel = formatDateTimeSafe(data.firstLogin);
                  const firstLoginMeta = data.firstLogin ? formatElapsedIso(data.firstLogin) : '';
                  const detailStat = data.statusDetail ? buildStat('Notes', data.statusDetail) : '';

                  const statusSection = [
                    '<div class="drilldown-section">',
                    '  <h3>Status</h3>',
                    '  <div class="drilldown-pill">' + data.statusHtml + (data.badgesHtml || '') + '</div>',
                    '  <div class="drilldown-grid">',
                    '    ' + buildStat('Status since', statusSinceLabel, statusSinceMeta),
                    '    ' + buildStat('Current idle', formatMinutesValue(data.idleMinutes), currentIdleMeta),
                    '  </div>',
                    '</div>'
                  ].join('\n');

                  const activitySection = [
                    '<div class="drilldown-section">',
                    '  <h3>Today\'s activity</h3>',
                    '  <div class="drilldown-grid">',
                    '    ' + buildStat('Idle total', formatMinutesValue(data.idleTotal)),
                    '    ' + buildStat('Breaks', formatCountValue(data.breakCount), data.breakMinutes !== null ? formatMinutesValue(data.breakMinutes) : ''),
                    '    ' + buildStat('Lunches', formatCountValue(data.lunchCount), data.lunchMinutes !== null ? formatMinutesValue(data.lunchMinutes) : ''),
                    '    ' + buildStat('Presence misses', formatCountValue(data.presenceMisses)),
                    '  </div>',
                    '</div>'
                  ].join('\n');

                  const timelineParts = [
                    '<div class="drilldown-section">',
                    '  <h3>Session hints</h3>',
                    '  <div class="drilldown-grid">',
                    '    ' + buildStat('First login', firstLoginLabel, firstLoginMeta)
                  ];
                  if (detailStat) {
                    timelineParts.push('    ' + detailStat);
                  }
                  timelineParts.push('  </div>');
                  timelineParts.push('</div>');
                  const timelineSection = timelineParts.join('\n');

                  content.innerHTML = [statusSection, activitySection, timelineSection].join('\n');
                  footer.innerHTML = data.detailUrl
                    ? '<a class="button" href="' + escapeHtmlClient(data.detailUrl) + '" data-drilldown-detail>Open timeline</a>'
                    : '';
                };

                const focusTrap = (event) => {
                  if (!open || event.key !== 'Tab') return;
                  const focusable = panel.querySelectorAll(FOCUSABLE);
                  if (!focusable.length) return;
                  const first = focusable[0];
                  const last = focusable[focusable.length - 1];
                  const active = document.activeElement;
                  if (event.shiftKey) {
                    if (active === first || active === panel) {
                      event.preventDefault();
                      last.focus();
                    }
                  } else if (active === last) {
                    event.preventDefault();
                    first.focus();
                  }
                };

                const closePanel = () => {
                  if (!open) return;
                  open = false;
                  highlight(activeRow, false);
                  shell.dataset.open = 'false';
                  panel.setAttribute('aria-hidden', 'true');
                  document.body.classList.remove('drilldown-locked');
                  if (cleanupTimer) window.clearTimeout(cleanupTimer);
                  cleanupTimer = window.setTimeout(() => {
                    if (!open) shell.hidden = true;
                  }, 280);
                  if (lastFocused && typeof lastFocused.focus === 'function') {
                    lastFocused.focus();
                  }
                };

                const openPanelInternal = (row) => {
                  if (cleanupTimer) {
                    window.clearTimeout(cleanupTimer);
                    cleanupTimer = null;
                  }
                  activeRow = row;
                  highlight(activeRow, true);
                  renderContent(row);
                  shell.hidden = false;
                  requestAnimationFrame(() => {
                    shell.dataset.open = 'true';
                    panel.setAttribute('aria-hidden', 'false');
                    document.body.classList.add('drilldown-locked');
                    const target = closeButtons[0] || panel;
                    if (target && typeof target.focus === 'function') {
                      target.focus({ preventScroll: true });
                    }
                  });
                  open = true;
                };

                const onBackdropClick = (event) => {
                  event.preventDefault();
                  closePanel();
                };

                const onKeydown = (event) => {
                  if (!open) return;
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closePanel();
                    return;
                  }
                  focusTrap(event);
                };

                const onCloseClick = () => closePanel();

                closeButtons.forEach((btn) => btn.addEventListener('click', onCloseClick));
                backdrop.addEventListener('click', onBackdropClick);
                document.addEventListener('keydown', onKeydown);

                return {
                  openFromRow(row) {
                    if (!row) return;
                    if (open && row === activeRow) {
                      closePanel();
                      return;
                    }
                    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    openPanelInternal(row);
                  },
                  destroy() {
                    closeButtons.forEach((btn) => btn.removeEventListener('click', onCloseClick));
                    backdrop.removeEventListener('click', onBackdropClick);
                    document.removeEventListener('keydown', onKeydown);
                    closePanel();
                  }
                };
              };

              let panelController = null;
              const ensurePanelController = () => {
                if (panelController) {
                  return panelController;
                }
                panelController = createPanelController({
                  shell,
                  panel,
                  backdrop,
                  closeButtons,
                  content: panelContent,
                  footer: panelFooter,
                  titleEl: panelTitle,
                  subtitleEl: panelSubtitle
                });
                return panelController;
              };

              if (table) {
                table.addEventListener('click', (event) => {
                  if (!(event.target instanceof Element)) {
                    return;
                  }
                  const row = event.target.closest('tr[data-user-id]');
                  if (!row) return;
                  const controller = ensurePanelController();
                  if (!controller) return;
                  const anchor = event.target.closest('a');
                  if (anchor && anchor.href) {
                    event.preventDefault();
                  }
                  controller.openFromRow(row);
                });
              }

              if (!table) {
                return;
              }
              const body = table.querySelector('[data-roster-body]');
              const notice = document.querySelector('[data-roster-notice]');
              const scroll = document.querySelector('[data-roster-container]');
              const empty = document.querySelector('[data-roster-empty]');

              const formatElapsedSeconds = (seconds) => {
                if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
                const minutes = Math.floor(seconds / 60);
                if (minutes <= 0) return '0m';
                const hours = Math.floor(minutes / 60);
                const remaining = Math.max(0, minutes % 60);
                const parts = [];
                if (hours > 0) parts.push(hours + 'h');
                parts.push(remaining + 'm');
                return parts.join(' ');
              };

              const updateTimers = () => {
                const now = Date.now();
                document.querySelectorAll('[data-since]').forEach((el) => {
                  const iso = el.getAttribute('data-since');
                  if (!iso) return;
                  const since = Date.parse(iso);
                  if (Number.isNaN(since)) return;
                  const elapsedSeconds = Math.max(0, Math.floor((now - since) / 1000));
                  const elapsedEl = el.querySelector('.since__elapsed');
                  if (elapsedEl) {
                    elapsedEl.textContent = '· ' + formatElapsedSeconds(elapsedSeconds);
                  }
                });
                document.querySelectorAll('[data-idle-since]').forEach((el) => {
                  const iso = el.getAttribute('data-idle-since');
                  if (!iso) return;
                  const since = Date.parse(iso);
                  if (Number.isNaN(since)) return;
                  const minutes = Math.max(0, Math.ceil((now - since) / 60000));
                  el.textContent = String(minutes);
                });
              };

              const applyPayload = (payload) => {
                if (payload && typeof payload.dateParam === 'string') {
                  table.setAttribute('data-date-param', payload.dateParam);
                }
                if (body && payload) {
                  body.innerHTML = payload.rowsHtml || '';
                }
                const totalsHtml = payload ? payload.totalsHtml || '' : '';
                const existingTotals = table.querySelector('[data-roster-totals]');
                if (totalsHtml) {
                  if (existingTotals) {
                    existingTotals.outerHTML = totalsHtml;
                  } else {
                    table.insertAdjacentHTML('beforeend', totalsHtml);
                  }
                } else if (existingTotals) {
                  existingTotals.remove();
                }
                if (notice && payload) {
                  const html = payload.noticeHtml || '';
                  notice.innerHTML = html;
                  notice.classList.toggle('hidden', !html.trim().length);
                }
                const hasRows = Boolean(payload && payload.rowsHtml && payload.rowsHtml.trim().length);
                if (scroll) {
                  scroll.classList.toggle('hidden', !hasRows);
                }
                if (empty) {
                  empty.classList.toggle('hidden', hasRows);
                }
                updateTimers();
              };

              const refresh = async () => {
                try {
                  const dateParam = table.getAttribute('data-date-param') || '';
                  const url = new URL('/dashboard/overview/today.json', window.location.origin);
                  if (dateParam) {
                    url.searchParams.set('date', dateParam);
                  }
                  const response = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
                  if (!response.ok) return;
                  const data = await response.json();
                  applyPayload(data);
                } catch (error) {
                  console.error('dashboard.roster.refresh_failed', error);
                }
              };

              updateTimers();
              setInterval(updateTimers, 1000);
              refresh();
              setInterval(refresh, 30000);
            })();
          </script>
        </body>
      </html>
    `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/overview/today.json', async (req, res) => {
    const dateInput = typeof req.query.date === 'string' ? parseDateParam(req.query.date) : zonedStartOfDay(new Date());
    const dailyData = await (0, exports.fetchDailySummaries)(dateInput);
    const rosterData = await fetchTodayRosterData(dateInput, dailyData.sessions);
    const rowsHtml = renderTodayRosterRows(rosterData.rows, dailyData.dateParam);
    const totalsHtml = rosterData.rows.length ? renderRosterTotalsRow(rosterData.totals) : '';
    const noticeHtml = rosterData.hasComputedNotice
        ? '<p class="meta meta--admin">Idle, break, and lunch totals are computed from today\'s activity history.</p>'
        : '';
    res.json({
        dateParam: dailyData.dateParam,
        label: dailyData.label,
        rowsHtml,
        totalsHtml,
        noticeHtml,
        generatedAt: new Date().toISOString()
    });
});
exports.dashboardRouter.get('/balances', async (req, res) => {
    const users = await prisma_1.prisma.user.findMany({
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
        const csvRows = rows.map((row) => [
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
        ].join(','));
        const csv = [header.join(','), ...csvRows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="balances.csv"');
        return res.send(csv);
    }
    const requestedUserId = typeof req.query.userId === 'string' ? Number.parseInt(req.query.userId, 10) : Number.NaN;
    const selectedUser = Number.isFinite(requestedUserId) && requestedUserId > 0
        ? users.find((user) => user.id === requestedUserId) ?? null
        : users[0] ?? null;
    const totals = rows.reduce((acc, row) => {
        acc.pto += row.pto;
        acc.nonPto += row.nonPto;
        acc.makeUp += row.makeUp;
        return acc;
    }, { pto: 0, nonPto: 0, makeUp: 0 });
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
    const updatedDates = rows.map((row) => row.updatedAt).filter((value) => Boolean(value));
    const balancesRangeStart = updatedDates.length
        ? zonedStartOfDay(updatedDates.reduce((min, current) => (current < min ? current : min)))
        : zonedStartOfDay(new Date());
    const balancesRangeEnd = updatedDates.length
        ? zonedEndOfDay(updatedDates.reduce((max, current) => (current > max ? current : max)))
        : zonedEndOfDay(new Date());
    let detailSection = `
      <section class="card balances-detail">
        <div class="card__body"><div class="empty">No users available.</div></div>
      </section>
    `;
    if (selectedUser) {
        const overview = await (0, balances_1.getBalanceOverview)(selectedUser.id, { limit: 200 });
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
      <section class="card balances-detail" id="balance-detail" data-user-id="${selectedUser.id}">
        <div class="card__header">
          <div>
            <h2 class="card__title">${escapeHtml(selectedUser.name)}</h2>
            <p class="card__subtitle">${escapeHtml(selectedUser.email)}</p>
          </div>
          <div class="card__actions no-print balances-detail-actions">
            <button type="button" class="button" data-open-adjust>Adjust Balance</button>
            <a href="/dashboard/requests?type=pto" class="button button-secondary">Review PTO Requests</a>
          </div>
        </div>
        <div class="card__body">
          ${summaryCards}
          ${dialogHtml}
          <h3>PTO Ledger</h3>
          <p class="meta">Entries are sorted newest first.</p>
          ${ledgerTable}
          ${ledgerEmpty}
        </div>
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
    const timezoneNote = renderTimezoneNote(balancesRangeStart, balancesRangeEnd);
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Balances</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--balances">
        ${renderNav('balances')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Attendance</p>
              <h1 class="page-header__title">Balances</h1>
              <p class="page-header__subtitle">Track remaining hours and review ledger adjustments.</p>
            </div>
            <div class="page-header__meta">
              <span>${rows.length} ${rows.length === 1 ? 'user' : 'users'} monitored</span>
              ${timezoneNote}
            </div>
          </header>
          <div class="cards-grid">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Roster Balances</h2>
                  <p class="card__subtitle">Select an employee to inspect ledger history.</p>
                </div>
                <div class="card__actions no-print">
                  <form method="get" action="/dashboard/balances">
                    <input type="hidden" name="download" value="csv" />
                    <button type="submit">Download CSV</button>
                  </form>
                  <button type="button" class="print-button" onclick="window.print()">Print</button>
                </div>
              </div>
              <div class="card__body">
                ${rows.length
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
        : '<div class="empty">No balances recorded yet.</div>'}
              </div>
            </section>
            ${detailSection}
          </div>
        </main>
        ${script}
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/user/:userId/balances', async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).type('html').send('<h1>Invalid user id</h1>');
    }
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: userId },
        include: { balance: true }
    });
    if (!user) {
        return res.status(404).type('html').send('<h1>User not found</h1>');
    }
    const requests = await prisma_1.prisma.timeRequest.findMany({
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
        const rowsCsv = requests.map((request) => [
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
        ].join(','));
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
        const typeLabel = requestTypeLabels[request.type];
        const statusLabel = requestStatusLabels[request.status];
        const typeBadge = `<span class="badge badge-${request.type}">${escapeHtml(typeLabel)}</span>`;
        const statusBadge = `<span class="badge badge-status-${request.status}">${escapeHtml(statusLabel)}</span>`;
        const rangeLabel = `${formatShortDate(request.startDate)} – ${formatShortDate(request.endDate)}`;
        const approverLabel = request.approver
            ? `${escapeHtml(request.approver.name)}<div class="meta">${escapeHtml(request.approver.email)}</div>`
            : '—';
        const actions = request.status === 'pending'
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
        ${requests.length
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
        : '<div class="empty">No requests recorded for this user.</div>'}
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/user/:userId', async (req, res) => {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) {
        return res.status(400).type('html').send('<h1>Invalid user id</h1>');
    }
    const requestedDate = typeof req.query.date === 'string' ? parseDateParam(req.query.date) : zonedStartOfDay(new Date());
    const dayStart = zonedStartOfDay(requestedDate);
    const dayEnd = zonedEndOfDay(requestedDate);
    const dateParam = toDateParam(dayStart);
    const sessions = await prisma_1.prisma.session.findMany({
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
    const user = sessions[0]?.user ?? (await prisma_1.prisma.user.findUnique({ where: { id: userId } }));
    if (!user) {
        return res.status(404).type('html').send('<h1>User not found</h1>');
    }
    const now = new Date();
    const sessionRecords = sessions;
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
        const rows = details.map((detail) => [
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
        ].join(','));
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
        ${detailRows
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
        : '<div class="empty">No sessions recorded for this date.</div>'}
        <section class="card">
          <h2>Breaks and Lunches</h2>
          ${renderPauseTable(pauseEntries)}
        </section>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
const addEmployeeSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    email: zod_1.z.string().email()
});
const renderSettingsPage = ({ enabled, employees, logs, message, error }) => {
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
      <body class="dashboard dashboard--settings">
        ${renderNav('settings')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Administration</p>
              <h1 class="page-header__title">Email Sign-In Settings</h1>
              <p class="page-header__subtitle">Enable, manage, and audit employee access via email-only authentication.</p>
            </div>
          </header>
          ${renderAlert()}
          <div class="cards-grid">
            <section class="card card--feature">
              <div class="card__header">
                <h2 class="card__title">Feature Flag</h2>
                <p class="card__subtitle">Current status: <strong>${enabled ? 'Enabled' : 'Disabled'}</strong></p>
              </div>
              <div class="card__body">
                <p>Allow employees to request session access with email only.</p>
                <form method="post" action="/dashboard/settings/toggle-email-signin">
                  <input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}" />
                  <button type="submit">${enabled ? 'Disable' : 'Enable'} Email Sign-In</button>
                </form>
              </div>
            </section>
            <section class="card card--form no-print">
              <div class="card__header">
                <h2 class="card__title">Add Employee</h2>
                <p class="card__subtitle">New entries default to active status.</p>
              </div>
              <div class="card__body">
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
              </div>
            </section>
          </div>
          <section class="card card--table">
            <div class="card__header">
              <h2 class="card__title">Employee Roster</h2>
              <p class="card__subtitle">Activate or deactivate email-only access.</p>
            </div>
            <div class="card__body">
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
            </div>
          </section>
          <section class="card card--table">
            <div class="card__header">
              <h2 class="card__title">Sign-In Audit Trail</h2>
              <p class="card__subtitle">Last 50 attempts, newest first.</p>
            </div>
            <div class="card__body">
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
            </div>
          </section>
        </main>
      </body>
    </html>
  `;
};
exports.dashboardRouter.get('/settings', async (req, res) => {
    const toOptionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const message = toOptionalString(req.query.message);
    const error = toOptionalString(req.query.error);
    const [enabled, employees, logs] = await Promise.all([
        (0, featureFlags_1.isEmailSessionEnabled)(),
        prisma_1.prisma.user.findMany({
            where: { role: 'employee' },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, email: true, active: true, createdAt: true }
        }),
        prisma_1.prisma.authAuditLog.findMany({
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
exports.dashboardRouter.post('/settings/toggle-email-signin', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const raw = String((req.body?.enabled ?? '').toString()).toLowerCase();
    const nextEnabled = ['1', 'true', 'on', 'yes'].includes(raw);
    await (0, featureFlags_1.setEmailSessionEnabled)(nextEnabled);
    res.redirect('/dashboard/settings');
}));
exports.dashboardRouter.post('/settings/employees', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = addEmployeeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Provide a name and valid email.'));
    }
    const name = parsed.data.name.trim();
    const normalizedEmail = parsed.data.email.trim().toLowerCase();
    if (!name) {
        return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Name is required.'));
    }
    const existing = await prisma_1.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
        return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Employee already exists.'));
    }
    const passwordHash = await (0, auth_1.hashPassword)((0, crypto_1.randomUUID)());
    await prisma_1.prisma.user.create({
        data: {
            name,
            email: normalizedEmail,
            role: 'employee',
            passwordHash,
            active: true
        }
    });
    res.redirect('/dashboard/settings?message=' + encodeURIComponent('Employee added.'));
}));
exports.dashboardRouter.post('/settings/employees/:id/active', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw errors_1.HttpError.badRequest('Invalid employee id');
    }
    const raw = String((req.body?.active ?? '').toString()).toLowerCase();
    const nextActive = ['1', 'true', 'on', 'yes'].includes(raw);
    const employee = await prisma_1.prisma.user.findUnique({ where: { id } });
    if (!employee || employee.role !== 'employee') {
        throw errors_1.HttpError.notFound('Employee not found');
    }
    await prisma_1.prisma.user.update({ where: { id }, data: { active: nextActive } });
    res.redirect('/dashboard/settings');
}));

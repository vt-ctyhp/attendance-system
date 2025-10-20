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
const config_1 = require("../services/payroll/config");
const constants_1 = require("../services/payroll/constants");
const payroll_1 = require("../services/payroll/payroll");
const attendance_1 = require("../services/payroll/attendance");
const bonuses_1 = require("../services/payroll/bonuses");
const timeRequestPolicy_1 = require("../services/timeRequestPolicy");
const DASHBOARD_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';
const ISO_DATE_TIME = "yyyy-MM-dd'T'HH:mm:ssXXX";
const ISO_DATE = 'yyyy-MM-dd';
const CSV_DATE_TIME = 'MMM d, yyyy h:mm a';
const CSV_DATE = 'MMM d, yyyy';
const DASHBOARD_COOKIE_PATH = '/';
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
const formatCsvDateTime = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, CSV_DATE_TIME);
const formatCsvDate = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, CSV_DATE);
const formatCsvDateList = (values) => values.length ? values.map((value) => formatCsvDateTime(value)).join('; ') : '';
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
const relevantRequestTypes = ['pto', 'uto'];
const visibleRequestStatuses = ['pending', 'approved'];
const requestTypeLabels = {
    pto: 'PTO',
    uto: 'UTO',
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
const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const formatCurrency = (value) => currencyFormatter.format(Number.isFinite(value) ? value : 0);
const toNumber = (value, fallback = 0) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
};
const payrollStatusLabels = {
    draft: 'Draft',
    approved: 'Approved',
    paid: 'Paid'
};
const payrollStatusClasses = {
    draft: 'status-chip status-chip--draft',
    approved: 'status-chip status-chip--approved',
    paid: 'status-chip status-chip--paid'
};
const normalizePayrollStatus = (status) => types_1.PAYROLL_STATUSES.includes(status)
    ? status
    : 'draft';
const bonusTypeLabels = {
    [constants_1.BONUS_TYPE_MONTHLY]: 'Monthly Attendance',
    [constants_1.BONUS_TYPE_QUARTERLY]: 'Quarterly Attendance',
    [constants_1.BONUS_TYPE_KPI]: 'KPI Bonus'
};
const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatDayRange = (start, end) => start === end ? weekdayLabels[start] : `${weekdayLabels[start]}–${weekdayLabels[end]}`;
const formatDayList = (days) => {
    if (!days.length) {
        return '—';
    }
    const sorted = days.slice().sort((a, b) => a - b);
    const ranges = [];
    let rangeStart = sorted[0];
    let prev = sorted[0];
    for (let index = 1; index < sorted.length; index += 1) {
        const current = sorted[index];
        if (current === prev + 1) {
            prev = current;
            continue;
        }
        ranges.push([rangeStart, prev]);
        rangeStart = current;
        prev = current;
    }
    ranges.push([rangeStart, prev]);
    return ranges.map(([start, end]) => formatDayRange(start, end)).join(', ');
};
const summarizeSchedule = (schedule) => {
    const normalized = (0, config_1.ensureSchedule)(schedule);
    const groups = new Map();
    for (const [dayKey, entry] of Object.entries(normalized.days)) {
        const day = Number.parseInt(dayKey, 10);
        if (!Number.isFinite(day))
            continue;
        if (!entry.enabled)
            continue;
        const groupKey = `${entry.start}-${entry.end}-${entry.expectedHours}-${entry.breakMinutes}`;
        const existing = groups.get(groupKey);
        if (existing) {
            existing.days.push(day);
        }
        else {
            groups.set(groupKey, {
                start: entry.start,
                end: entry.end,
                hours: entry.expectedHours,
                breakMinutes: entry.breakMinutes,
                days: [day]
            });
        }
    }
    if (!groups.size) {
        return 'No scheduled days';
    }
    const lines = [];
    for (const group of groups.values()) {
        const hoursLabel = Number.isInteger(group.hours)
            ? `${group.hours}`
            : group.hours.toFixed(2);
        const breakLabel = group.breakMinutes ? ` · Break ${group.breakMinutes}m` : '';
        lines.push(`${formatDayList(group.days)} · ${group.start} – ${group.end} · ${hoursLabel}h${breakLabel}`);
    }
    return `${lines.join('<br />')}<div class="meta">Timezone: ${escapeHtml(normalized.timeZone)}</div>`;
};
const computeNextPayrollPayDate = () => {
    const nowZoned = zoned(new Date());
    const currentDay = nowZoned.getDate();
    const endOfMonthDate = (0, date_fns_1.endOfMonth)(nowZoned);
    const fifteenth = new Date(nowZoned);
    fifteenth.setDate(15);
    fifteenth.setHours(0, 0, 0, 0);
    const nextZoned = currentDay <= 15 ? fifteenth : endOfMonthDate;
    nextZoned.setHours(0, 0, 0, 0);
    return formatIsoDate((0, date_fns_tz_1.zonedTimeToUtc)(nextZoned, DASHBOARD_TIME_ZONE));
};
const toPayDateParam = (value) => formatIsoDate((0, date_fns_tz_1.zonedTimeToUtc)(value, DASHBOARD_TIME_ZONE));
const parsePeriodTotals = (value) => {
    const record = (value && typeof value === 'object') ? value : {};
    return {
        base: Math.round(toNumber(record.base) * 100) / 100,
        monthlyAttendance: Math.round(toNumber(record.monthlyAttendance) * 100) / 100,
        monthlyDeferred: Math.round(toNumber(record.monthlyDeferred) * 100) / 100,
        quarterlyAttendance: Math.round(toNumber(record.quarterlyAttendance) * 100) / 100,
        kpiBonus: Math.round(toNumber(record.kpiBonus) * 100) / 100,
        finalAmount: Math.round(toNumber(record.finalAmount) * 100) / 100
    };
};
const normalizePayDateForDashboard = (payDate) => {
    const zonedPay = zoned(payDate);
    const endOfMonthZoned = (0, date_fns_1.endOfMonth)(zonedPay);
    const normalized = new Date(zonedPay);
    normalized.setHours(0, 0, 0, 0);
    if (zonedPay.getDate() === 15 || zonedPay.getDate() === endOfMonthZoned.getDate()) {
        return (0, date_fns_tz_1.zonedTimeToUtc)(normalized, DASHBOARD_TIME_ZONE);
    }
    if (zonedPay.getDate() < 15) {
        normalized.setDate(15);
    }
    else {
        normalized.setTime(endOfMonthZoned.getTime());
    }
    normalized.setHours(0, 0, 0, 0);
    return (0, date_fns_tz_1.zonedTimeToUtc)(normalized, DASHBOARD_TIME_ZONE);
};
const computePayPeriodWindow = (payDate) => {
    const normalizedPayDate = normalizePayDateForDashboard(payDate);
    const payZoned = zoned(normalizedPayDate);
    const isFifteenth = payZoned.getDate() === 15;
    let startZoned;
    let endZoned;
    if (isFifteenth) {
        const prevMonth = (0, date_fns_1.addMonths)(payZoned, -1);
        startZoned = new Date(prevMonth);
        startZoned.setDate(16);
        endZoned = (0, date_fns_1.endOfMonth)(prevMonth);
    }
    else {
        startZoned = new Date(payZoned);
        startZoned.setDate(1);
        endZoned = new Date(payZoned);
        endZoned.setDate(15);
    }
    const periodStart = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfDay)(startZoned), DASHBOARD_TIME_ZONE);
    const periodEnd = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfDay)(endZoned), DASHBOARD_TIME_ZONE);
    return { payDate: normalizedPayDate, periodStart, periodEnd };
};
const computePreviousPayDate = (payDate) => {
    const normalizedPayDate = normalizePayDateForDashboard(payDate);
    const payZoned = zoned(normalizedPayDate);
    if (payZoned.getDate() === 15) {
        const prevMonth = (0, date_fns_1.addMonths)(payZoned, -1);
        const prevEnd = (0, date_fns_1.endOfMonth)(prevMonth);
        prevEnd.setHours(0, 0, 0, 0);
        return (0, date_fns_tz_1.zonedTimeToUtc)(prevEnd, DASHBOARD_TIME_ZONE);
    }
    const prev = new Date(payZoned);
    prev.setDate(15);
    prev.setHours(0, 0, 0, 0);
    return (0, date_fns_tz_1.zonedTimeToUtc)(prev, DASHBOARD_TIME_ZONE);
};
const formatAttendanceDayLabel = (value) => (0, date_fns_tz_1.formatInTimeZone)(value, DASHBOARD_TIME_ZONE, 'EEE, MMM d');
const collectAttendanceSummary = async (userId, periodStart, periodEnd) => {
    const summary = {
        details: [],
        makeUpRequests: [],
        totals: {
            workedHours: 0,
            ptoHours: 0,
            utoHours: 0,
            makeUpHours: 0,
            tardyMinutes: 0,
            tardyEvents: 0,
            scheduledDays: 0,
            onTimeDays: 0,
            absenceDays: 0
        }
    };
    const detailMap = new Map();
    const monthKeys = new Set();
    for (let cursor = periodStart; cursor <= periodEnd; cursor = (0, date_fns_1.addDays)(cursor, 1)) {
        monthKeys.add((0, date_fns_tz_1.formatInTimeZone)(cursor, DASHBOARD_TIME_ZONE, 'yyyy-MM'));
    }
    for (const monthKey of monthKeys) {
        const fact = await prisma_1.prisma.attendanceMonthFact.findUnique({
            where: { userId_monthKey: { userId, monthKey } }
        });
        if (!fact)
            continue;
        const snapshot = (fact.snapshot ?? {});
        const days = Array.isArray(snapshot.days) ? snapshot.days : [];
        let usedSnapshot = false;
        if (days.length) {
            usedSnapshot = true;
            for (const raw of days) {
                if (!raw || typeof raw !== 'object')
                    continue;
                const isoDate = typeof raw.date === 'string' ? raw.date : '';
                if (!isoDate)
                    continue;
                const parsed = parseDateInput(isoDate);
                if (!parsed)
                    continue;
                if (parsed < periodStart || parsed > periodEnd)
                    continue;
                const expectedHours = Math.round(toNumber(raw.expectedHours) * 100) / 100;
                const workedHours = Math.round(toNumber(raw.workedHours) * 100) / 100;
                const ptoHours = Math.round(toNumber(raw.ptoHours) * 100) / 100;
                const utoHours = Math.round(toNumber(raw.utoHours) * 100) / 100;
                const makeUpHours = Math.round(toNumber(raw.makeUpHours) * 100) / 100;
                const tardyMinutes = Math.max(0, Math.round(toNumber(raw.tardyMinutes)));
                const notes = Array.isArray(raw.notes)
                    ? raw.notes.map((note) => String(note)).filter((note) => note.trim().length)
                    : [];
                const breakCount = Math.max(0, Math.round(toNumber(raw.breakCount)));
                const breakMinutes = Math.max(0, Math.round(toNumber(raw.breakMinutes)));
                const lunchCount = Math.max(0, Math.round(toNumber(raw.lunchCount)));
                const lunchMinutes = Math.max(0, Math.round(toNumber(raw.lunchMinutes)));
                const idleMinutes = Math.max(0, Math.round(toNumber(raw.idleMinutes)));
                const clockIn = typeof raw.clockIn === 'string' && raw.clockIn.trim().length ? raw.clockIn : null;
                const clockOut = typeof raw.clockOut === 'string' && raw.clockOut.trim().length ? raw.clockOut : null;
                let detail = detailMap.get(isoDate);
                if (!detail) {
                    detail = {
                        isoDate,
                        label: formatAttendanceDayLabel(parsed),
                        expectedHours,
                        workedHours,
                        ptoHours,
                        utoHours,
                        makeUpHours,
                        tardyMinutes,
                        breakCount,
                        breakMinutes,
                        lunchCount,
                        lunchMinutes,
                        idleMinutes,
                        clockIn,
                        clockOut,
                        notes
                    };
                    summary.details.push(detail);
                    detailMap.set(isoDate, detail);
                }
                else {
                    detail.label = formatAttendanceDayLabel(parsed);
                    detail.expectedHours = expectedHours;
                    detail.workedHours = workedHours;
                    detail.ptoHours = ptoHours;
                    detail.utoHours = utoHours;
                    detail.makeUpHours = makeUpHours;
                    detail.tardyMinutes = tardyMinutes;
                    detail.breakCount = breakCount;
                    detail.breakMinutes = breakMinutes;
                    detail.lunchCount = lunchCount;
                    detail.lunchMinutes = lunchMinutes;
                    detail.idleMinutes = idleMinutes;
                    detail.clockIn = clockIn;
                    detail.clockOut = clockOut;
                    detail.notes = notes;
                }
                summary.totals.workedHours += workedHours;
                summary.totals.ptoHours += ptoHours;
                summary.totals.utoHours += utoHours;
                summary.totals.makeUpHours += makeUpHours;
                if (expectedHours > 0) {
                    summary.totals.scheduledDays += 1;
                    if (tardyMinutes === 0) {
                        summary.totals.onTimeDays += 1;
                    }
                }
                if (tardyMinutes > 0) {
                    summary.totals.tardyMinutes += tardyMinutes;
                    summary.totals.tardyEvents += 1;
                }
                if (notes.includes('Absence')) {
                    summary.totals.absenceDays += 1;
                }
            }
            if (Array.isArray(snapshot.makeUpRequests)) {
                for (const rawRequest of snapshot.makeUpRequests) {
                    if (!rawRequest || typeof rawRequest !== 'object')
                        continue;
                    const startIso = typeof rawRequest.start === 'string' ? rawRequest.start : '';
                    const endIso = typeof rawRequest.end === 'string' ? rawRequest.end : '';
                    if (!startIso || !endIso)
                        continue;
                    const start = parseDateInput(startIso);
                    const end = parseDateInput(endIso);
                    if (!start || !end)
                        continue;
                    if (end < periodStart || start > periodEnd)
                        continue;
                    const idValue = typeof rawRequest.id === 'string' && rawRequest.id.trim().length
                        ? rawRequest.id
                        : `${startIso}-${endIso}`;
                    const hours = Math.round(toNumber(rawRequest.hours) * 100) / 100;
                    summary.makeUpRequests.push({
                        id: idValue,
                        start: formatFullDate(start),
                        end: formatFullDate(end),
                        hours
                    });
                }
            }
        }
        if (!usedSnapshot) {
            const totalDays = Math.max(1, (0, date_fns_1.differenceInCalendarDays)(fact.rangeEnd, fact.rangeStart) + 1);
            const overlapStart = fact.rangeStart > periodStart ? fact.rangeStart : periodStart;
            const overlapEnd = fact.rangeEnd < periodEnd ? fact.rangeEnd : periodEnd;
            if (overlapEnd < overlapStart)
                continue;
            const overlapDays = Math.max(1, (0, date_fns_1.differenceInCalendarDays)(overlapEnd, overlapStart) + 1);
            const ratio = Math.min(1, overlapDays / totalDays);
            summary.totals.workedHours += Number(fact.workedHours) * ratio;
            summary.totals.ptoHours += Number(fact.ptoHours) * ratio;
            summary.totals.utoHours += Number(fact.utoAbsenceHours) * ratio;
            summary.totals.makeUpHours += Number(fact.matchedMakeUpHours) * ratio;
            const tardyMinutes = Math.round(Number(fact.tardyMinutes) * ratio);
            summary.totals.tardyMinutes += tardyMinutes;
            if (tardyMinutes > 0) {
                summary.totals.tardyEvents += 1;
            }
            const estimatedDays = Math.round(overlapDays);
            summary.totals.scheduledDays += estimatedDays;
            if (tardyMinutes === 0) {
                summary.totals.onTimeDays += estimatedDays;
            }
        }
    }
    const ensureDetailForDate = (date) => {
        const iso = formatIsoDate(date);
        let detail = detailMap.get(iso);
        if (!detail) {
            const parsedForLabel = parseDateInput(iso) ?? date;
            detail = {
                isoDate: iso,
                label: formatAttendanceDayLabel(parsedForLabel),
                expectedHours: 0,
                workedHours: 0,
                ptoHours: 0,
                utoHours: 0,
                makeUpHours: 0,
                tardyMinutes: 0,
                breakCount: 0,
                breakMinutes: 0,
                lunchCount: 0,
                lunchMinutes: 0,
                idleMinutes: 0,
                clockIn: null,
                clockOut: null,
                notes: []
            };
            summary.details.push(detail);
            detailMap.set(iso, detail);
        }
        return detail;
    };
    const [sessions, idleStats] = await Promise.all([
        prisma_1.prisma.session.findMany({
            where: {
                userId,
                startedAt: { lte: periodEnd },
                OR: [{ endedAt: null }, { endedAt: { gte: periodStart } }]
            },
            select: {
                startedAt: true,
                endedAt: true,
                pauses: {
                    where: { type: { in: ['break', 'lunch'] } },
                    select: { type: true, startedAt: true, endedAt: true, durationMinutes: true }
                }
            }
        }),
        prisma_1.prisma.minuteStat.findMany({
            where: {
                session: { userId },
                minuteStart: { gte: periodStart, lte: periodEnd },
                idle: true
            },
            select: { minuteStart: true }
        })
    ]);
    const now = new Date();
    for (const session of sessions) {
        const sessionStart = session.startedAt < periodStart ? periodStart : session.startedAt;
        const rawSessionEnd = session.endedAt ?? now;
        const sessionEnd = rawSessionEnd > periodEnd ? periodEnd : rawSessionEnd;
        if (sessionEnd < periodStart || sessionStart > periodEnd) {
            continue;
        }
        const dayDetail = ensureDetailForDate(sessionStart);
        if (!dayDetail.clockIn || new Date(dayDetail.clockIn).getTime() > session.startedAt.getTime()) {
            dayDetail.clockIn = session.startedAt.toISOString();
        }
        if (session.endedAt) {
            if (!dayDetail.clockOut || new Date(dayDetail.clockOut).getTime() < session.endedAt.getTime()) {
                dayDetail.clockOut = session.endedAt.toISOString();
            }
        }
        for (const pause of session.pauses) {
            if (pause.type !== 'break' && pause.type !== 'lunch') {
                continue;
            }
            const pauseStart = pause.startedAt < periodStart ? periodStart : pause.startedAt;
            const pauseEndSource = pause.endedAt ?? now;
            const pauseEnd = pauseEndSource > periodEnd ? periodEnd : pauseEndSource;
            if (pauseEnd <= pauseStart) {
                continue;
            }
            let duration = typeof pause.durationMinutes === 'number'
                ? pause.durationMinutes
                : Math.round((pauseEndSource.getTime() - pause.startedAt.getTime()) / 60000);
            if (pause.startedAt < periodStart ||
                pauseEndSource > periodEnd ||
                !Number.isFinite(duration)) {
                duration = Math.round((pauseEnd.getTime() - pauseStart.getTime()) / 60000);
            }
            if (!Number.isFinite(duration) || duration < 0) {
                duration = 0;
            }
            const pauseDetail = ensureDetailForDate(pauseStart);
            if (pause.type === 'break') {
                pauseDetail.breakCount += 1;
                pauseDetail.breakMinutes += duration;
            }
            else {
                pauseDetail.lunchCount += 1;
                pauseDetail.lunchMinutes += duration;
            }
        }
    }
    for (const stat of idleStats) {
        const detail = ensureDetailForDate(stat.minuteStart);
        detail.idleMinutes += 1;
    }
    for (const detail of summary.details) {
        detail.breakMinutes = Math.round(detail.breakMinutes);
        detail.lunchMinutes = Math.round(detail.lunchMinutes);
        detail.idleMinutes = Math.round(detail.idleMinutes);
    }
    summary.details.sort((a, b) => {
        const parsedA = parseDateInput(a.isoDate);
        const parsedB = parseDateInput(b.isoDate);
        const timeA = parsedA ? parsedA.getTime() : 0;
        const timeB = parsedB ? parsedB.getTime() : 0;
        return timeA - timeB;
    });
    summary.totals.workedHours = Math.round(summary.totals.workedHours * 100) / 100;
    summary.totals.ptoHours = Math.round(summary.totals.ptoHours * 100) / 100;
    summary.totals.utoHours = Math.round(summary.totals.utoHours * 100) / 100;
    summary.totals.makeUpHours = Math.round(summary.totals.makeUpHours * 100) / 100;
    return summary;
};
const toMonthKey = (monthKey) => {
    if (/^\d{4}-\d{2}$/.test(monthKey)) {
        return monthKey;
    }
    return (0, date_fns_tz_1.formatInTimeZone)(zonedStartOfMonth(new Date()), DASHBOARD_TIME_ZONE, 'yyyy-MM');
};
const computeMonthRange = (monthKey) => {
    const monthDate = parseMonthParam(monthKey);
    const rangeStart = monthDate;
    const rangeEnd = zonedEndOfMonth(monthDate);
    return { rangeStart, rangeEnd };
};
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
    const breakPauses = session.pauses
        .filter((pause) => pause.type === 'break')
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const lunchPauses = session.pauses
        .filter((pause) => pause.type === 'lunch')
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const breakStartTimes = breakPauses.map((pause) => pause.startedAt);
    const breakEndTimes = breakPauses.flatMap((pause) => (pause.endedAt ? [pause.endedAt] : []));
    const lunchStartTimes = lunchPauses.map((pause) => pause.startedAt);
    const lunchEndTimes = lunchPauses.flatMap((pause) => (pause.endedAt ? [pause.endedAt] : []));
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
        presenceMisses,
        breakStartTimes,
        breakEndTimes,
        lunchStartTimes,
        lunchEndTimes
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
        .filter((stat) => stat.minuteStart >= dayStart && stat.minuteStart <= now)
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
            if (!stat.idle) {
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
        uto: 1,
        make_up: 2
    };
    const mapped = requests
        .filter((request) => request.status === 'approved')
        .map((request) => {
        if (request.type === 'pto') {
            return { key: 'pto', startDate: request.startDate };
        }
        if (request.type === 'uto') {
            return { key: 'uto', startDate: request.startDate };
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
    const label = selection.key === 'pto' ? 'PTO' : selection.key === 'uto' ? 'UTO' : 'Make up Hours';
    return { key: selection.key, label, since };
};
const buildRosterRow = (user, sessions, requests, badges, dayStart, dayEnd, now, scheduleInfo) => {
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
    const scheduleStart = scheduleInfo && scheduleInfo.enabled ? scheduleInfo.start : null;
    let tardyMinutes = 0;
    if (scheduleStart && firstLogin) {
        tardyMinutes = computeRosterTardyMinutes(scheduleStart, firstLogin);
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
        tardyMinutes,
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
        const emptyTotals = {
            totalIdleMinutes: 0,
            breakCount: 0,
            totalBreakMinutes: 0,
            lunchCount: 0,
            totalLunchMinutes: 0,
            presenceMisses: 0,
            tardyMinutes: 0
        };
        return {
            rows: [],
            totals: emptyTotals,
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
    const scheduleByUser = new Map();
    if (userIds.length) {
        const configs = await prisma_1.prisma.employeeCompConfig.findMany({
            where: {
                userId: { in: userIds },
                effectiveOn: { lte: dayStart }
            },
            orderBy: [{ userId: 'asc' }, { effectiveOn: 'desc' }]
        });
        const weekday = (0, date_fns_tz_1.utcToZonedTime)(dayStart, constants_1.PAYROLL_TIME_ZONE).getDay();
        for (const config of configs) {
            if (scheduleByUser.has(config.userId)) {
                continue;
            }
            const normalized = (0, config_1.ensureSchedule)(config.schedule);
            const daySchedule = normalized.days[String(weekday)];
            if (daySchedule) {
                scheduleByUser.set(config.userId, { start: daySchedule.start, enabled: daySchedule.enabled });
            }
            else {
                scheduleByUser.set(config.userId, null);
            }
        }
    }
    const rows = users.map((user) => buildRosterRow(user, relevantSessions, requestsByUser.get(user.id) ?? [], badgeMap.get(user.id) ?? [], dayStart, dayEnd, now, scheduleByUser.get(user.id) ?? null));
    const totals = rows.reduce((acc, row) => ({
        totalIdleMinutes: acc.totalIdleMinutes + row.totalIdleMinutes,
        breakCount: acc.breakCount + row.breakCount,
        totalBreakMinutes: acc.totalBreakMinutes + row.totalBreakMinutes,
        lunchCount: acc.lunchCount + row.lunchCount,
        totalLunchMinutes: acc.totalLunchMinutes + row.totalLunchMinutes,
        presenceMisses: acc.presenceMisses + row.presenceMisses,
        tardyMinutes: acc.tardyMinutes + row.tardyMinutes
    }), {
        totalIdleMinutes: 0,
        breakCount: 0,
        totalBreakMinutes: 0,
        lunchCount: 0,
        totalLunchMinutes: 0,
        presenceMisses: 0,
        tardyMinutes: 0
    });
    return {
        rows,
        totals,
        hasComputedNotice: rows.length > 0
    };
};
const renderTimeCell = (value) => {
    if (!value) {
        return '—';
    }
    const tooltip = formatDateTime(value);
    return `<span title="${escapeHtml(tooltip)}">${escapeHtml(formatTimeOfDay(value))}</span>`;
};
const escapeAttr = (value) => value === null || value === undefined ? '' : escapeHtml(String(value));
const toRosterLegendKey = (status) => {
    switch (status) {
        case 'active':
            return 'working';
        case 'break':
            return 'break';
        case 'lunch':
            return 'lunch';
        default:
            return 'offline';
    }
};
const computeRosterLegendCounts = (rows) => rows.reduce((acc, row) => {
    const key = toRosterLegendKey(row.statusKey);
    acc[key] += 1;
    return acc;
}, { working: 0, break: 0, lunch: 0, offline: 0 });
const renderRosterLegend = (counts) => {
    const entries = [
        { key: 'working', label: 'Working' },
        { key: 'break', label: 'Break' },
        { key: 'lunch', label: 'Lunch' },
        { key: 'offline', label: 'Offline' }
    ];
    return `
    <ul class="live-roster-legend" data-roster-legend>
      ${entries
        .map(({ key, label }) => `
            <li class="live-roster-legend__item" data-legend-item="${key}">
              <span class="live-roster-legend__dot live-roster-legend__dot--${key}" aria-hidden="true"></span>
              <span class="live-roster-legend__label">${label}</span>
              <span class="live-roster-legend__value" data-legend-count>${counts[key]}</span>
            </li>
          `)
        .join('')}
    </ul>
  `;
};
const formatRosterMinutes = (value) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return '—';
    }
    const rounded = Math.max(0, Math.round(value));
    return `${rounded}m`;
};
const formatRosterCount = (value) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return '—';
    }
    return String(Math.max(0, Math.round(value)));
};
const computeRosterTardyMinutes = (scheduledStart, actualStart) => {
    const [hours, minutes] = scheduledStart.split(':').map((value) => Number.parseInt(value, 10));
    if (!Number.isFinite(hours) || !Number.isFinite(minutes))
        return 0;
    const zoned = (0, date_fns_tz_1.utcToZonedTime)(actualStart, constants_1.PAYROLL_TIME_ZONE);
    const scheduled = new Date(zoned);
    scheduled.setHours(hours, minutes, 0, 0);
    if ((0, date_fns_1.differenceInCalendarDays)(zoned, scheduled) !== 0) {
        return 0;
    }
    return Math.max(0, Math.round((zoned.getTime() - scheduled.getTime()) / 60000));
};
const buildRosterInitials = (value) => {
    const trimmed = value.trim();
    if (!trimmed) {
        return '?';
    }
    const parts = trimmed.split(/\s+/).slice(0, 2);
    const initials = parts.map((part) => part[0]?.toUpperCase()).filter(Boolean).join('');
    return initials || trimmed[0]?.toUpperCase() || '?';
};
const buildTodayRosterRowHtml = (row, dateParam) => {
    const statusClass = `status status--${row.statusKey.replace(/_/g, '-')}`;
    const statusSince = row.statusSince ? formatIsoDateTime(row.statusSince) : '';
    const idleSince = row.idleSince ? formatIsoDateTime(row.idleSince) : '';
    const firstLoginIso = row.firstLogin ? formatIsoDateTime(row.firstLogin) : '';
    const detailHref = `/dashboard/user/${row.userId}?date=${dateParam}`;
    const initials = buildRosterInitials(row.name);
    const roleLabel = row.role?.trim().length ? row.role : '—';
    const statusDetail = row.statusDetail ? `<span class="roster-status__meta">${escapeHtml(row.statusDetail)}</span>` : '';
    const statusSinceMeta = row.statusSince
        ? `<span class="roster-status__meta since" data-since="${escapeAttr(statusSince)}" title="${escapeHtml(formatDateTime(row.statusSince))}"><span class="since__time">Since ${escapeHtml(formatTimeOfDay(row.statusSince))}</span><span class="since__elapsed" data-elapsed></span></span>`
        : '';
    const currentIdleContent = row.statusKey === 'active'
        ? `<span class="roster-cell__metric" data-idle-since="${escapeAttr(idleSince)}" data-idle-minutes="${row.currentIdleMinutes}">${formatRosterMinutes(row.currentIdleMinutes)}</span>`
        : '—';
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
    data-status-category="${toRosterLegendKey(row.statusKey)}"
  >
    <td class="roster-cell roster-cell--user">
      <div class="roster-user">
        <span class="roster-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
        <div class="roster-user__content">
          <a class="roster-user__name" href="${escapeAttr(detailHref)}">${escapeHtml(row.name)}</a>
          <span class="roster-user__role">${escapeHtml(roleLabel)}</span>
          ${row.requestBadges.length ? `<div class="roster-user__badges">${renderRequestBadges(row.requestBadges)}</div>` : ''}
        </div>
      </div>
    </td>
    <td class="roster-cell">
      <div class="roster-status">
        <span class="${statusClass}">${escapeHtml(row.statusLabel)}</span>
        ${statusDetail}
        ${statusSinceMeta}
      </div>
    </td>
    <td class="roster-cell roster-cell--numeric" data-idle-cell>${currentIdleContent}</td>
    <td class="roster-cell roster-cell--numeric">${formatRosterMinutes(row.totalIdleMinutes)}</td>
    <td class="roster-cell roster-cell--numeric">${formatRosterCount(row.breakCount)}</td>
    <td class="roster-cell roster-cell--numeric">${formatRosterMinutes(row.totalBreakMinutes)}</td>
    <td class="roster-cell roster-cell--numeric">${formatRosterCount(row.lunchCount)}</td>
    <td class="roster-cell roster-cell--numeric">${formatRosterMinutes(row.totalLunchMinutes)}</td>
    <td class="roster-cell roster-cell--numeric">${renderTimeCell(row.firstLogin)}</td>
    <td class="roster-cell roster-cell--numeric">${formatRosterMinutes(row.tardyMinutes)}</td>
    <td class="roster-cell roster-cell--numeric">${formatRosterCount(row.presenceMisses)}</td>
  </tr>`;
};
const renderTodayRosterRows = (rows, dateParam) => rows.map((row) => buildTodayRosterRowHtml(row, dateParam)).join('\n');
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
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  
  :root { 
    color-scheme: light;
    --primary: #1d4ed8;
    --primary-hover: #153e9f;
    --primary-light: #60a5fa;
    --primary-strong: #0b3cc1;
    --primary-soft: #e0e7ff;
    --success: #047857;
    --success-soft: #dcfce7;
    --warning: #b45309;
    --warning-soft: #fef3c7;
    --danger: #b91c1c;
    --danger-soft: #fee2e2;
    --bg-page: #f6f7fb;
    --bg-card: #ffffff;
    --bg-elevated: #eef2ff;
    --bg-tertiary: #f3f4ff;
    --border: #cbd5e1;
    --border-strong: #94a3b8;
    --border-light: #d8def0;
    --text-primary: #0f172a;
    --text-secondary: #1f2937;
    --text-muted: #475569;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 14px;
    --radius-xl: 18px;
    --radius-full: 999px;
    --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.08);
    --shadow-md: 0 6px 12px rgba(15, 23, 42, 0.08);
    --shadow-lg: 0 12px 24px rgba(15, 23, 42, 0.10);
    --shadow-xl: 0 20px 40px rgba(15, 23, 42, 0.12);
  }
  
  * { box-sizing: border-box; }
  
  body { 
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
    margin: 0; 
    padding: 0;
    background: var(--bg-page);
    color: var(--text-primary); 
    min-height: 100vh; 
    line-height: 1.5;
    font-size: 14px;
  }
  
  h1, h2, h3, h4, h5, h6 { margin: 0; line-height: 1.3; font-weight: 600; }
  h1 { font-size: 24px; }
  h2 { font-size: 18px; }
  h3 { font-size: 16px; }
  
  table { 
    width: 100%; 
    border-collapse: collapse;
    background: var(--bg-card); 
    margin: 0;
    font-size: 13px;
  }
  th, td { 
    padding: 12px 16px; 
    text-align: left; 
    border-bottom: 1px solid var(--border); 
  }
  th { 
    background: var(--bg-elevated);
    font-weight: 600;
    font-size: 12px;
    color: var(--text-secondary);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  tbody tr:hover { background: var(--bg-elevated); }
  tbody tr:last-child td { border-bottom: none; }
  .totals th, .totals td { 
    font-weight: 600; 
    background: var(--bg-elevated); 
    color: var(--text-primary);
    border-top: 2px solid var(--border);
  }
  
  .empty { 
    padding: 48px 24px; 
    text-align: center; 
    color: var(--text-secondary); 
    background: var(--bg-card); 
    font-size: 14px;
    border: 1px solid var(--border-light);
  }
  
  .nav { 
    display: flex; 
    justify-content: space-between; 
    align-items: center; 
    padding: 0 32px;
    height: 64px;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 50;
  }
  .nav__links { display: flex; gap: 0; align-items: center; position: relative; }
  .nav__item { position: relative; display: flex; align-items: center; }
  .nav__item--dropdown { position: relative; }
  .nav__item--dropdown::after { content: ''; position: absolute; left: -0.6rem; right: -0.6rem; top: 100%; height: 0.75rem; }
  .nav__account { display: flex; align-items: center; gap: 16px; margin-left: auto; }
  .nav__account-label { font-weight: 500; color: var(--text-secondary); font-size: 13px; }
  .nav__logout-form { margin: 0; }
  .nav__logout-button { 
    background: transparent;
    color: var(--text-secondary); 
    border: 1px solid var(--border); 
    border-radius: 6px; 
    padding: 6px 12px; 
    font-weight: 500; 
    cursor: pointer;
    transition: all 0.15s;
    font-size: 13px;
  }
  .nav__logout-button:hover { 
    background: #F9FAFB;
    color: var(--text-primary);
  }
  .nav a { 
    color: var(--text-secondary); 
    text-decoration: none; 
    font-weight: 500; 
    padding: 20px 16px;
    transition: color 0.15s;
    font-size: 14px;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .nav a.active { 
    color: var(--primary);
    border-bottom-color: var(--primary);
  }
  .nav a:hover:not(.active) { 
    color: var(--text-primary);
  }
  .nav__link--parent { display: inline-flex; align-items: center; gap: 0.35rem; }
  .nav__link--parent::after { content: ''; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 4px solid currentColor; opacity: 0.5; transform: translateY(1px); }
  .nav__item--dropdown .nav__link--parent.active::after { opacity: 1; }
  .nav__dropdown { 
    display: none; 
    position: absolute; 
    top: 100%; 
    left: 0; 
    background: var(--bg-card); 
    box-shadow: 0 4px 12px rgba(0,0,0,0.1); 
    padding: 4px; 
    list-style: none; 
    margin: 0; 
    min-width: 200px; 
    flex-direction: column; 
    z-index: 20;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .nav__item--dropdown:hover .nav__dropdown,
  .nav__item--dropdown:focus-within .nav__dropdown { display: flex; }
  .nav__dropdown-item { width: 100%; }
  .nav__link--child { 
    display: block; 
    padding: 8px 12px; 
    color: var(--text-primary); 
    font-weight: 500; 
    font-size: 13px; 
    border-radius: 4px;
    transition: background 0.15s;
  }
  .nav__link--child:hover,
  .nav__link--child:focus { background: #F3F4F6; text-decoration: none; }
  .nav__link--child.active { background: var(--primary); color: white; }
  
  .card { 
    background: var(--bg-card); 
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .stack-form { display: grid; gap: 16px; max-width: 420px; }
  .stack-form label { 
    display: grid; 
    gap: 6px; 
    font-weight: 500; 
    color: var(--text-primary);
    font-size: 13px;
  }
  .stack-form input { 
    padding: 8px 12px; 
    border-radius: 6px; 
    border: 1px solid var(--border); 
    font-size: 14px;
    transition: border-color 0.15s;
  }
  .stack-form input:focus {
    outline: none;
    border-color: var(--primary);
  }
  .stack-form button { width: fit-content; }
  .inline-form { display: inline; }
  
  .alert { 
    margin: 16px 0; 
    padding: 12px 16px; 
    border-radius: 6px; 
    font-weight: 500;
    border: 1px solid;
    font-size: 13px;
  }
  .alert.success { 
    background: #F0FDF4; 
    color: #166534;
    border-color: #BBF7D0;
  }
  .alert.error { 
    background: #FEF2F2; 
    color: #991B1B;
    border-color: #FECACA;
  }
  
  .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin: 16px 0; }
  .filters { 
    display: flex; 
    gap: 12px; 
    align-items: flex-end; 
    flex-wrap: wrap;
  }
  .filters label { 
    font-size: 13px; 
    color: var(--text-primary); 
    display: flex; 
    flex-direction: column; 
    gap: 6px; 
    min-width: 160px;
    font-weight: 500;
  }
  .form-error { 
    margin: 0; 
    min-height: 20px; 
    font-size: 13px; 
    color: #DC2626; 
    font-weight: 500; 
  }
  
  input[type="date"], input[type="month"], input[type="text"], input[type="number"], select, textarea { 
    padding: 8px 12px; 
    border: 1px solid var(--border); 
    border-radius: 6px; 
    font-size: 14px; 
    background: var(--bg-card); 
    color: var(--text-primary);
    transition: border-color 0.15s;
    font-family: inherit;
  }
  input[type="date"]:focus, input[type="month"]:focus, input[type="text"]:focus, input[type="number"]:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--primary);
  }
  
  button, .button { 
    padding: 8px 16px; 
    border: none; 
    background: var(--primary); 
    color: white; 
    border-radius: var(--radius-sm); 
    cursor: pointer; 
    font-size: 13px; 
    font-weight: 500;
    display: inline-flex; 
    align-items: center; 
    justify-content: center; 
    text-decoration: none;
    transition: background 0.15s;
  }
  button:hover, .button:hover { 
    background: var(--primary-hover);
    text-decoration: none; 
  }
  .button:visited { color: white; text-decoration: none; }
  
  .print-button { 
    background: var(--bg-card); 
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
  .print-button:hover { 
    background: var(--bg-elevated);
  }
  
  .button-secondary { 
    background: var(--bg-card);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }
  .button-secondary:hover { 
    background: var(--bg-elevated);
  }
  
  .button-danger { 
    background: var(--danger); 
    color: white;
  }
  .button-danger:hover { 
    background: #991b1b;
  }
  
  .meta { color: var(--text-secondary); margin-bottom: 12px; font-size: 13px; }
  .meta--admin { 
    font-size: 13px; 
    color: var(--primary-strong); 
    display: inline-flex; 
    align-items: center; 
    gap: 8px;
    background: var(--primary-soft);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    border-left: 3px solid var(--primary);
  }
  .meta--admin::before { content: 'ℹ️'; }
  
  .tz-note { 
    margin: 12px 0; 
    font-size: 13px; 
    color: var(--text-secondary);
    background: var(--bg-elevated);
    padding: 12px 16px;
    border-radius: var(--radius-sm);
    border-left: 3px solid var(--primary);
  }
  
  a { color: var(--primary); transition: color 0.15s; }
  a:hover { color: var(--primary-hover); text-decoration: underline; }
  
  .no-print { }
  
  .tab-bar { 
    display: inline-flex; 
    gap: 4px; 
    margin: 0;
    background: var(--bg-elevated);
    padding: 4px;
    border-radius: var(--radius-sm);
  }
  .tab-bar a { 
    padding: 6px 16px; 
    border-radius: 4px; 
    background: transparent; 
    color: var(--text-muted); 
    text-decoration: none; 
    font-weight: 500;
    transition: all 0.15s;
    font-size: 13px;
  }
  .tab-bar a:hover:not(.active) {
    background: var(--border-light);
    color: var(--text-primary);
  }
  .tab-bar a.active { 
    background: white; 
    color: var(--text-primary);
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  
  .tab-content { margin-top: 0; }
  .tab-content.hidden { display: none; }
  
  .badges { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
  .badge { 
    display: inline-flex; 
    align-items: center; 
    padding: 0.375rem 0.75rem; 
    border-radius: var(--radius-full); 
    font-size: 0.75rem; 
    font-weight: 700; 
    letter-spacing: 0.025em; 
    text-transform: uppercase; 
    background: linear-gradient(135deg, var(--bg-tertiary), var(--border-light)); 
    color: var(--text-primary); 
    border: 1px solid var(--border-light);
    box-shadow: var(--shadow-sm);
  }
  .badge-pto { 
    background: linear-gradient(135deg, #FEF3C7, #FDE68A); 
    color: #92400E;
    border-color: #FCD34D;
  }
  .badge-uto { 
    background: linear-gradient(135deg, #DBEAFE, #BFDBFE); 
    color: #1E3A8A;
    border-color: #93C5FD;
  }
  .badge-status-pending { border-style: dashed; border-width: 2px; }
  .badge-status-approved { border-color: rgba(34, 197, 94, 0.3); }
  .badge-status-denied { opacity: 0.6; text-decoration: line-through; }
  
  .status { 
    display: inline-flex; 
    align-items: center; 
    gap: 0.5rem; 
    padding: 0.5rem 1rem; 
    border-radius: var(--radius-full); 
    font-size: 0.8125rem; 
    text-transform: uppercase; 
    letter-spacing: 0.05em; 
    font-weight: 700; 
    background: var(--bg-elevated); 
    color: var(--text-secondary);
    border: 1px solid var(--border-light);
  }
  .status--active { 
    background: var(--success-soft); 
    color: var(--success);
    border-color: rgba(4, 120, 87, 0.35);
  }
  .status--break { 
    background: var(--warning-soft); 
    color: var(--warning);
    border-color: rgba(180, 83, 9, 0.35);
  }
  .status--lunch { 
    background: var(--primary-soft); 
    color: var(--primary-strong);
    border-color: rgba(29, 78, 216, 0.35);
  }
  .status--logged-out, 
  .status--not-logged-in { 
    background: var(--bg-tertiary); 
    color: var(--text-secondary);
    border-color: var(--border-light);
  }
  .status--pto { 
    background: #fef3c7; 
    color: #92400e;
    border-color: rgba(251, 191, 36, 0.35);
  }
  .status--day-off { 
    background: #e2e8f0; 
    color: var(--text-primary);
    border-color: #cbd5e1;
  }
  .status--make-up { 
    background: #e0f2fe; 
    color: #0369a1;
    border-color: rgba(14, 165, 233, 0.35);
  }
  .since { 
    display: inline-flex; 
    align-items: baseline; 
    gap: 0.5rem; 
    font-variant-numeric: tabular-nums; 
    white-space: nowrap; 
  }
  .since__time { font-weight: 700; color: var(--text-primary); }
  .since__elapsed { font-size: 0.75rem; color: var(--text-secondary); font-weight: 500; }
  td[data-idle-cell] { font-variant-numeric: tabular-nums; }
  
  .action-buttons { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .action-buttons form { margin: 0; }
  .inline-form { display: inline; }
  
  .summary-cards { 
    display: grid; 
    gap: 1.25rem; 
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
    margin: 1.5rem 0; 
  }
  .summary-card { 
    background: linear-gradient(135deg, var(--bg-card), var(--bg-elevated)); 
    padding: 1.5rem; 
    border-radius: var(--radius-xl); 
    box-shadow: var(--shadow-lg);
    border: 1px solid var(--border-light);
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .summary-card:hover {
    transform: translateY(-4px);
    box-shadow: var(--shadow-xl);
  }
  .summary-title { 
    font-size: 0.75rem; 
    text-transform: uppercase; 
    letter-spacing: 0.075em; 
    color: var(--text-secondary); 
    margin-bottom: 0.5rem;
    font-weight: 700;
  }
  .summary-value { 
    font-size: 2rem; 
    font-weight: 800; 
    color: var(--primary-strong);
    line-height: 1.2;
  }
  .summary-meta { 
    font-size: 0.8125rem; 
    color: var(--text-secondary); 
    margin-top: 0.5rem;
    font-weight: 500;
  }
  .timesheet-request-form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .timesheet-request-form select,
  .timesheet-request-form input[type="text"] { padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 0.85rem; }
  .timesheet-request-form button { padding: 0.4rem 0.9rem; }
  .muted { color: var(--text-muted); font-size: 0.8rem; }
  .table-scroll { overflow-x: auto; max-width: 100%; }
  .table-scroll table { min-width: 720px; }
  .table-scroll .live-roster-table { min-width: 960px; }
  .live-roster-card { position: relative; background: var(--bg-card); border-radius: 0; border: none; overflow: hidden; }
  .live-roster-card__header { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; background: var(--bg-elevated); border-bottom: 1px solid var(--border); z-index: 1; }
  .live-roster-card__heading { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .live-roster-card__title { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .live-roster-card__body { padding: 0; display: flex; flex-direction: column; gap: 0; }
  .live-roster-card__notice .meta { margin: 16px 24px; }
  .live-roster-card__table-scroll { border-radius: 0; }
  .live-roster-legend { list-style: none; display: flex; align-items: center; gap: 16px; margin: 0; padding: 0; flex-wrap: wrap; }
  .live-roster-legend__item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--text-secondary); }
  .live-roster-legend__label { white-space: nowrap; }
  .live-roster-legend__dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .live-roster-legend__dot--working { background: #10B981; }
  .live-roster-legend__dot--break { background: #F59E0B; }
  .live-roster-legend__dot--lunch { background: #3B82F6; }
  .live-roster-legend__dot--offline { background: #D1D5DB; }
  .live-roster-legend__value { font-variant-numeric: tabular-nums; color: var(--text-primary); font-weight: 500; }
  .live-roster-refresh { border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); border-radius: var(--radius-sm); width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; cursor: pointer; transition: background 0.15s; }
  .live-roster-refresh:hover:not(:disabled) { background: var(--bg-elevated); }
  .live-roster-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
  .live-roster-refresh.is-refreshing span { animation: live-roster-spin 0.6s linear infinite; }
  @keyframes live-roster-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .live-roster-table { width: 100%; min-width: 960px; border-collapse: collapse; margin: 0; background: transparent; }
  .live-roster-table thead th { position: sticky; top: 0; background: var(--bg-elevated); color: var(--text-secondary); font-size: 12px; font-weight: 600; padding: 12px 16px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .live-roster-table tbody td { padding: 12px 16px; border-bottom: 1px solid var(--border); background: white; }
  .live-roster-table tbody tr:last-child td { border-bottom: none; }
  .live-roster-table tbody tr { transition: background 0.15s; }
  .live-roster-table tbody tr:hover td { background: var(--bg-elevated); }
  .roster-cell { font-size: 13px; color: var(--text-primary); }
  .roster-cell--numeric { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .roster-cell--user { min-width: 200px; }
  .roster-cell__metric { display: inline-block; min-width: 3ch; }
  .roster-user { display: flex; align-items: center; gap: 12px; }
  .roster-avatar { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--radius-sm); background: var(--primary-soft); color: var(--primary-strong); font-weight: 600; font-size: 13px; text-transform: uppercase; }
  .roster-user__content { display: flex; flex-direction: column; gap: 2px; }
  .roster-user__name { font-weight: 500; color: var(--text-primary); text-decoration: none; }
  .roster-user__name:hover { text-decoration: underline; }
  .roster-user__role { font-size: 12px; color: var(--text-secondary); }
  .roster-user__badges { margin-top: 4px; }
  .roster-status { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .roster-status__meta { font-size: 11px; color: var(--text-muted); }
  .live-roster-card__body .empty { margin: 24px; padding: 48px 24px; border: 1px dashed var(--border); background: var(--bg-elevated); color: var(--text-secondary); font-size: 13px; border-radius: var(--radius-sm); }
  @media (max-width: 768px) {
    .live-roster-card__header { align-items: flex-start; }
    .live-roster-card__heading { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .live-roster-card__title { font-size: 1rem; }
    .live-roster-refresh { width: 2.25rem; height: 2.25rem; font-size: 1rem; }
  }
  .balances-detail { margin-top: 2rem; background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(15,23,42,0.05); }
  .balances-detail h2 { margin-top: 0; }
  .balances-detail-actions { gap: 0.5rem; flex-wrap: wrap; }
  dialog { border: none; border-radius: 8px; padding: 1.5rem; max-width: 420px; width: min(420px, 100%); }
  dialog:not([open]) { display: none; }
  dialog::backdrop { background: rgba(15, 23, 42, 0.4); }
  #edit-balances-form label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem; font-weight: 500; color: #374151; }
  #edit-balances-form input[type="number"], #edit-balances-form textarea { padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.95rem; }
  #edit-balances-form textarea { resize: vertical; min-height: 120px; }
  #edit-balances-form .dialog-section { margin-top: 1rem; display: grid; gap: 0.6rem; }
  #edit-balances-form .dialog-section:first-of-type { margin-top: 0.5rem; }
  #edit-balances-form .dialog-section h4 { margin: 0; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: #475569; }
  #edit-balances-form .dialog-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .dialog-meta { font-size: 0.85rem; color: #4b5563; margin-top: 0.5rem; }
  .dialog-note { font-size: 0.82rem; color: #475569; margin-top: 1rem; }
  .dialog-error { color: #b91c1c; font-size: 0.85rem; min-height: 1.25rem; margin-top: 0.75rem; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.5rem; }
  .ledger-table td:nth-child(2),
  .ledger-table th:nth-child(2),
  .ledger-table td:nth-child(3),
  .ledger-table th:nth-child(3) { text-align: right; white-space: nowrap; }
  .hidden { display: none !important; }
  .highlight-row { background: #f0f9ff; }
  @media (max-width: 1024px) {
    body.dashboard .cards-grid { padding: 16px; }
    body.dashboard .page-header { padding: 20px 16px; }
    body.dashboard .page-controls { padding: 12px 16px; }
    .summary-cards { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .table-scroll table { min-width: 600px; }
  }
  
  @media (max-width: 768px) {
    body { font-size: 13px; }
    
    .nav { 
      height: auto;
      padding: 12px 16px;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }
    .nav__links { 
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .nav__account { 
      width: 100%;
      margin-left: 0;
      justify-content: space-between;
    }
    
    body.dashboard .page-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 16px;
    }
    body.dashboard .page-header__meta {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    
    body.dashboard .page-controls {
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }
    
    body.dashboard .card__header {
      flex-direction: column;
      align-items: flex-start;
      padding: 16px;
    }
    body.dashboard .card__actions {
      width: 100%;
    }
    
    .actions { 
      flex-direction: column; 
      align-items: stretch;
      gap: 8px;
    }
    .filters { 
      flex-direction: column; 
      align-items: stretch;
      gap: 12px;
    }
    .filters label { 
      width: 100%;
      min-width: 100%;
    }
    button, .button { width: 100%; }
    .print-button { width: 100%; }
    
    .tab-bar {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .tab-bar a {
      white-space: nowrap;
    }
    
    .table-scroll table { min-width: 520px; }
    .balances-detail { padding: 16px; }
    
    .live-roster-card__header {
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }
    .live-roster-card__heading {
      width: 100%;
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
    }
    .live-roster-legend {
      flex-wrap: wrap;
      gap: 12px;
    }
    .live-roster-refresh {
      align-self: flex-start;
    }
  }
  
  @media (max-width: 640px) {
    body { padding: 0; }
    
    .nav {
      padding: 12px;
      border-radius: 0;
    }
    .nav a {
      padding: 16px 12px;
      font-size: 13px;
    }
    
    body.dashboard .page-header { 
      padding: 16px 12px;
      border-radius: 0;
    }
    body.dashboard .page-header__title {
      font-size: 18px;
    }
    
    body.dashboard .page-controls {
      padding: 12px;
    }
    
    body.dashboard .cards-grid {
      padding: 12px;
    }
    
    body.dashboard .card {
      border-radius: 0;
      border-left: none;
      border-right: none;
    }
    body.dashboard .card__header {
      padding: 12px;
    }
    
    table { margin-top: 0; }
    th, td { 
      padding: 8px 12px;
      font-size: 12px;
    }
    th {
      font-size: 11px;
    }
    .table-scroll table { min-width: 480px; }
    
    .live-roster-card__header {
      padding: 12px;
    }
    .live-roster-table thead th {
      padding: 8px 12px;
      font-size: 11px;
    }
    .live-roster-table tbody td {
      padding: 8px 12px;
    }
    .roster-cell {
      font-size: 12px;
    }
    .roster-avatar {
      width: 28px;
      height: 28px;
      font-size: 12px;
    }
    
    .summary-cards {
      grid-template-columns: 1fr;
      gap: 8px;
    }
    
    input[type="date"], 
    input[type="month"], 
    input[type="text"], 
    input[type="number"], 
    select, 
    textarea {
      font-size: 16px; /* Prevents iOS zoom */
    }
  }
  
  @media (max-width: 480px) {
    .nav__links {
      flex-wrap: nowrap;
    }
    .nav a {
      font-size: 12px;
      padding: 16px 10px;
    }
    
    body.dashboard .page-header__title {
      font-size: 16px;
    }
    body.dashboard .page-header__subtitle {
      font-size: 12px;
    }
    
    .live-roster-legend__item {
      font-size: 11px;
    }
    .live-roster-legend__dot {
      width: 6px;
      height: 6px;
    }
  }
  
  @media print {
    body { margin: 0.5in; background: #fff; color: #111827; padding: 0; }
    .nav { position: static; }
    table { box-shadow: none; }
    .no-print { display: none !important; }
    body.dashboard .card { 
      border: 1px solid var(--border);
      page-break-inside: avoid;
    }
  }

  /* Dashboard overview page layout */
    body.dashboard main.page-shell { 
      max-width: 100%;
      margin: 0;
      min-height: calc(100vh - 64px);
    }
    
    body.dashboard .page-header { 
      background: var(--bg-card); 
      border-bottom: 1px solid var(--border);
      padding: 24px 32px;
      display: flex; 
      align-items: center; 
      justify-content: space-between; 
      gap: 24px; 
      flex-wrap: wrap;
    }
    body.dashboard .page-header__eyebrow { 
      text-transform: uppercase; 
      letter-spacing: 0.05em; 
      color: var(--text-muted); 
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    body.dashboard .page-header__content { 
      display: flex; 
      flex-direction: column; 
      gap: 4px; 
    }
    body.dashboard .page-header__title { 
      margin: 0; 
      font-size: 20px; 
      color: var(--text-primary);
      font-weight: 600;
    }
    body.dashboard .page-header__subtitle { 
      margin: 0; 
      color: var(--text-secondary); 
      max-width: 60ch; 
      font-size: 13px; 
      line-height: 1.5; 
    }
    body.dashboard .page-header__meta { 
      display: flex; 
      gap: 24px; 
      align-items: center;
      color: var(--text-secondary); 
      font-size: 13px;
    }
    body.dashboard .page-header__meta strong { color: var(--text-primary); font-weight: 500; }
    
    body.dashboard .page-controls { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      gap: 16px; 
      flex-wrap: wrap;
      padding: 16px 32px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
    }
    body.dashboard .page-controls .tab-bar { margin: 0; }
    
    body.dashboard .cards-grid {
      padding: 24px 32px;
    }
    
    body.dashboard .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    
    body.dashboard .card__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    
    body.dashboard .card__title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }
    
    body.dashboard .card__subtitle {
      font-size: 13px;
      color: var(--text-secondary);
      margin: 4px 0 0 0;
    }
    
    body.dashboard .card__actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    
    body.dashboard .card__body {
      padding: 0;
    }
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
    body.dashboard--payroll .cards-grid--payroll { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
    @media (min-width: 1024px) {
      body.dashboard--payroll .cards-grid--payroll.cards-grid--payroll-split { grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-flow: dense; }
      body.dashboard--payroll .cards-grid--payroll.cards-grid--payroll-split > .card--span-quarter { grid-column: span 1; }
      body.dashboard--payroll .cards-grid--payroll.cards-grid--payroll-split > .card--span-three-quarter { grid-column: span 3; }
    }
    body.dashboard--payroll .cards-grid--summary { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    body.dashboard--payroll-summary .cards-grid--summary { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    body.dashboard--payroll-summary .totals-table { width: 100%; border-collapse: collapse; margin: 0; background: transparent; box-shadow: none; }
    body.dashboard--payroll-summary .totals-table th { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; color: #64748b; padding: 0.5rem 0; background: transparent; }
    body.dashboard--payroll-summary .totals-table td { text-align: right; font-weight: 700; color: #0f172a; font-variant-numeric: tabular-nums; padding: 0.5rem 0; border-bottom: 1px solid rgba(148,163,184,0.2); }
    body.dashboard--payroll-summary .totals-table tbody tr:first-child th, body.dashboard--payroll-summary .totals-table tbody tr:first-child td { padding-top: 0; }
    body.dashboard--payroll-summary .totals-table tbody tr:last-child td { border-bottom: none; padding-bottom: 0; }
    body.dashboard--payroll-summary .summary-cards { margin: 0; }
    body.dashboard--payroll .summary-card--neutral {
      background: #fff;
      color: #0f172a;
      border: 1px solid rgba(148,163,184,0.18);
      box-shadow: 0 18px 32px rgba(15,23,42,0.1);
    }
    body.dashboard--payroll .summary-card--neutral .summary-title { color: #64748b; }
    body.dashboard--payroll .summary-card__value {
      margin: 0;
      font-size: clamp(1.6rem, 4vw, 2.1rem);
      font-weight: 700;
      color: #0f172a;
    }
    body.dashboard--payroll .summary-card__status {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.9rem;
      color: #475569;
    }
    body.dashboard--payroll .summary-card__status span { margin: 0; }
    body.dashboard--payroll .summary-card__meta {
      margin: 0;
      font-size: 0.85rem;
      color: #475569;
    }
    body.dashboard--payroll .summary-card__action { margin-top: auto; }
    body.dashboard--payroll .step-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 1rem;
    }
    body.dashboard--payroll .step-list li {
      background: rgba(37,99,235,0.08);
      border-radius: 16px;
      padding: 1rem;
      display: grid;
      gap: 0.6rem;
    }
    body.dashboard--payroll .step-list strong {
      margin: 0;
      font-size: 1rem;
      letter-spacing: -0.01em;
      color: #0f172a;
    }
    body.dashboard--payroll .step-list span { font-size: 0.9rem; color: #475569; }
    body.dashboard--payroll .step-list form { margin: 0; }
    body.dashboard--payroll .step-list .stack-form { max-width: none; }
    body.dashboard--payroll #run-payroll .stack-form { gap: 0.25rem; }
    body.dashboard--payroll #run-payroll .stack-form .meta { margin: 0 0 0.15rem; }
    body.dashboard--payroll .step-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    body.dashboard--payroll .status-chip { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; background: rgba(148,163,184,0.18); color: #334155; }
    body.dashboard--payroll .status-chip--draft { background: rgba(148,163,184,0.3); color: #334155; }
    body.dashboard--payroll .status-chip--approved { background: rgba(34,197,94,0.2); color: #047857; }
    body.dashboard--payroll .status-chip--paid { background: rgba(37,99,235,0.18); color: #1d4ed8; }
    body.dashboard--payroll .status-chip--pending { background: rgba(251,191,36,0.24); color: #b45309; }
    body.dashboard--payroll .status-chip--earned { background: rgba(22,163,74,0.18); color: #15803d; }
    body.dashboard--payroll .status-chip--denied { background: rgba(220,38,38,0.18); color: #991b1b; }
    body.dashboard--payroll .status-chip--warn { background: rgba(251,191,36,0.24); color: #b45309; }
    body.dashboard--payroll .totals-grid { display: flex; flex-direction: column; gap: 0.5rem; }
    body.dashboard--payroll .totals-grid > div { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
    body.dashboard--payroll .totals-grid dt { margin: 0; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; }
    body.dashboard--payroll .totals-grid dd { margin: 0; font-weight: 600; color: #0f172a; font-size: 0.95rem; text-align: right; }
    body.dashboard--payroll .divider { height: 1px; background: rgba(15,23,42,0.08); margin: 1.5rem 0; }
    body.dashboard--payroll-detail .detail-header { display: flex; align-items: center; justify-content: space-between; gap: clamp(1rem, 3vw, 2rem); margin-bottom: clamp(1.25rem, 3vw, 1.75rem); flex-wrap: wrap; }
    body.dashboard--payroll-detail .detail-identity { display: flex; align-items: center; gap: clamp(0.75rem, 2vw, 1.5rem); flex-wrap: wrap; }
    body.dashboard--payroll-detail .detail-back { order: -1; }
    body.dashboard--payroll-detail .detail-avatar { width: 64px; height: 64px; border-radius: 999px; background: rgba(37,99,235,0.12); color: #1d4ed8; display: grid; place-items: center; font-weight: 700; font-size: 1.6rem; }
    body.dashboard--payroll-detail .detail-identity-text h1 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.2rem); color: #0f172a; }
    body.dashboard--payroll-detail .detail-identity-text p { margin: 0.25rem 0 0; font-size: 0.95rem; color: #64748b; }
    body.dashboard--payroll-detail .detail-meta { display: grid; gap: 0.4rem; justify-items: flex-end; text-align: right; }
    body.dashboard--payroll-detail .detail-meta span { font-size: 0.9rem; color: #475569; }
    body.dashboard--payroll-detail .detail-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: clamp(1rem, 3vw, 1.6rem); margin-bottom: clamp(1.25rem, 3vw, 1.75rem); }
    body.dashboard--payroll-detail .detail-kpi-card { background: #fff; border-radius: 18px; box-shadow: 0 20px 36px rgba(15,23,42,0.08); padding: 1.1rem 1.25rem; display: grid; gap: 0.35rem; }
    body.dashboard--payroll-detail .detail-kpi-card h3 { margin: 0; font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; color: #64748b; }
    body.dashboard--payroll-detail .detail-kpi-card strong { font-size: clamp(1.4rem, 3vw, 1.85rem); color: #0f172a; font-weight: 700; }
    body.dashboard--payroll-detail .detail-kpi-card span { font-size: 0.82rem; color: #475569; }
    body.dashboard--payroll-detail .detail-kpi-card .detail-kpi-placeholder { color: #94a3b8; font-style: italic; }
    body.dashboard--payroll-detail .detail-hours-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
    body.dashboard--payroll-detail .detail-makeup-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; font-size: 0.85rem; color: #475569; }
    body.dashboard--payroll-detail .detail-pay-meta { font-size: 0.85rem; color: #475569; }
    body.dashboard--payroll-detail .detail-mini-table { width: 100%; border-collapse: collapse; }
    body.dashboard--payroll-detail .detail-mini-table thead th { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; color: #64748b; padding-bottom: 0.4rem; }
    body.dashboard--payroll-detail .detail-mini-table tbody td { font-size: 0.95rem; font-weight: 600; color: #0f172a; padding: 0.45rem 0; }
    body.dashboard--payroll-detail .detail-mini-table tbody tr + tr td { border-top: 1px solid rgba(15,23,42,0.08); }
    body.dashboard--payroll-detail .detail-timeline table { width: 100%; border-collapse: collapse; }
    body.dashboard--payroll-detail .detail-timeline th { text-align: left; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; padding: 0.5rem 0.5rem 0.45rem; }
    body.dashboard--payroll-detail .detail-timeline td { font-size: 0.9rem; color: #0f172a; padding: 0.5rem; border-top: 1px solid rgba(15,23,42,0.08); }
    body.dashboard--payroll-detail .detail-timeline tbody tr:hover { background: rgba(37,99,235,0.05); }
    body.dashboard--payroll-detail .detail-exceptions { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
    body.dashboard--payroll-detail .detail-exceptions li { border-radius: 14px; border: 1px solid rgba(148,163,184,0.18); background: rgba(15,23,42,0.03); padding: 0.85rem 1rem; display: grid; gap: 0.35rem; }
    body.dashboard--payroll-detail .detail-exceptions strong { font-size: 0.95rem; color: #0f172a; }
    body.dashboard--payroll-detail .detail-exceptions span { font-size: 0.8rem; color: #475569; }
    body.dashboard--payroll-detail .detail-trends { width: 100%; border-collapse: collapse; }
    body.dashboard--payroll-detail .detail-trends th, body.dashboard--payroll-detail .detail-trends td { text-align: left; padding: 0.55rem 0.5rem; }
    body.dashboard--payroll-detail .detail-trends thead th { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; color: #64748b; }
    body.dashboard--payroll-detail .detail-trends tbody tr + tr td { border-top: 1px solid rgba(15,23,42,0.08); }
    body.dashboard--payroll-detail .trend-up { color: #16a34a; font-weight: 600; }
    body.dashboard--payroll-detail .trend-down { color: #dc2626; font-weight: 600; }
    body.dashboard--payroll-detail .trend-neutral { color: #475569; font-weight: 600; }
    body.dashboard--payroll-detail .detail-utilities { display: grid; gap: 1rem; }
    body.dashboard--payroll-detail .detail-utility-row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
    body.dashboard--payroll-detail .detail-utility-row label { display: grid; gap: 0.35rem; font-size: 0.85rem; color: #475569; }
    body.dashboard--payroll-detail .detail-utility-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    body.dashboard--payroll-detail .detail-notes { display: grid; gap: 0.5rem; }
    body.dashboard--payroll-detail .detail-notes textarea { width: 100%; min-height: 120px; border-radius: 12px; border: 1px dashed rgba(148,163,184,0.4); padding: 0.75rem; resize: vertical; font-family: inherit; font-size: 0.95rem; background: rgba(15,23,42,0.02); color: #475569; }
    body.dashboard--payroll-detail .detail-notes textarea:focus { outline: none; border-color: rgba(37,99,235,0.45); }
    body.dashboard--payroll-detail .detail-notes textarea[readonly] { opacity: 0.9; }
    body.dashboard--payroll .secondary-form { display: flex; flex-direction: column; gap: 0.75rem; }
    body.dashboard--payroll .secondary-form__title { margin: 0; font-size: 1rem; font-weight: 600; }
    body.dashboard--payroll .checkbox-field { display: inline-flex; gap: 0.4rem; align-items: center; font-weight: 600; }
    body.dashboard--payroll .compensation-form { display: flex; flex-direction: column; gap: 1.5rem; }
    body.dashboard--payroll .compensation-form__columns { display: grid; gap: 1.25rem; }
    @media (min-width: 960px) {
      body.dashboard--payroll .compensation-form__columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    body.dashboard--payroll .compensation-form__column { display: grid; gap: 1.25rem; align-content: start; }
    body.dashboard--payroll .compensation-group { background: rgba(248,250,252,0.9); border: 1px solid rgba(148,163,184,0.22); border-radius: 18px; padding: 1rem 1.25rem; display: grid; gap: 0.75rem; box-shadow: inset 0 1px 0 rgba(255,255,255,0.6); }
    body.dashboard--payroll .compensation-group__header { display: grid; gap: 0.35rem; }
    body.dashboard--payroll .compensation-group__title { margin: 0; font-size: 0.95rem; font-weight: 700; color: #0f172a; }
    body.dashboard--payroll .compensation-group__hint { margin: 0; font-size: 0.85rem; color: #64748b; }
    body.dashboard--payroll .compensation-group__body { display: grid; gap: 0.85rem; }
    body.dashboard--payroll .compensation-group__body--balances { gap: 1rem; }
    body.dashboard--payroll .compensation-group__fields { display: grid; gap: 0.75rem; }
    body.dashboard--payroll .compensation-group__fields--two { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    body.dashboard--payroll .compensation-group__fields--three { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    body.dashboard--payroll .compensation-group__fields--stack { grid-template-columns: minmax(0, 1fr); }
    body.dashboard--payroll .compensation-group__full { grid-column: 1 / -1; }
    body.dashboard--payroll .compensation-group__fields label { display: grid; gap: 0.35rem; }
    body.dashboard--payroll .compensation-group .checkbox-field { padding: 0; background: none; border: none; justify-content: flex-start; font-weight: 600; }
    body.dashboard--payroll .compensation-group .checkbox-field input[type='checkbox'] { width: 16px; height: 16px; }
    body.dashboard--payroll .compensation-subgroup { display: grid; gap: 0.6rem; }
    body.dashboard--payroll .compensation-subgroup__title { margin: 0; font-size: 0.82rem; letter-spacing: 0.08em; text-transform: uppercase; color: #475569; }
    body.dashboard--payroll .compensation-subgroup__fields { display: grid; gap: 0.75rem; }
    body.dashboard--payroll .schedule-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; }
    body.dashboard--payroll .schedule-days { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    body.dashboard--payroll .schedule-option { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.7rem; border-radius: 999px; background: rgba(15,23,42,0.05); font-size: 0.85rem; border: 1px solid rgba(148,163,184,0.18); }
    body.dashboard--payroll .compensation-row--missing td { background: rgba(254,243,199,0.35); }
    body.dashboard--payroll .compensation-row--missing td:first-child { font-weight: 600; }
    body.dashboard--payroll .compensation-row--missing td .meta a { font-weight: 600; }
    body.dashboard--shifts .schedule-row--pto td { background: rgba(191, 219, 254, 0.55); }
    body.dashboard--shifts .schedule-row--uto td { background: rgba(254, 215, 170, 0.55); }
    body.dashboard--shifts .schedule-row--make_up td { background: rgba(187, 247, 208, 0.6); }
    body.dashboard--shifts .schedule-row--pto td:first-child,
    body.dashboard--shifts .schedule-row--uto td:first-child,
    body.dashboard--shifts .schedule-row--make_up td:first-child { font-weight: 600; }
    body.dashboard--payroll .actions-cell { text-align: right; }
    body.dashboard--payroll .actions-cell .button { white-space: nowrap; }
    body.dashboard--payroll .compensation-form__footer { display: flex; flex-direction: column; gap: 0.75rem; }
    body.dashboard--payroll .compensation-form__footer .form-error { margin: 0; min-height: 1rem; }
    @media (min-width: 640px) {
      body.dashboard--payroll .compensation-form__footer { flex-direction: row; align-items: center; justify-content: space-between; }
      body.dashboard--payroll .compensation-form__footer .form-error { flex: 1; }
      body.dashboard--payroll .compensation-form__footer button { margin-left: auto; }
    }
    body.dashboard--payroll .timeoff-fields { border: 1px dashed rgba(148,163,184,0.25); border-radius: 14px; padding: 1rem 1.1rem; background: rgba(248,250,252,0.7); display: grid; gap: 0.75rem; transition: opacity 0.2s ease; }
    body.dashboard--payroll .timeoff-fields--disabled { opacity: 0.55; }
    body.dashboard--payroll .timeoff-fields--disabled input { cursor: not-allowed; }
    body.dashboard--payroll .holiday-form { margin-top: 1.25rem; }
    body.dashboard--payroll .kpi-card { background: rgba(37,99,235,0.08); border-radius: 16px; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
    body.dashboard--payroll .kpi-card__header { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
    body.dashboard--payroll .kpi-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
    body.dashboard--payroll .kpi-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    body.dashboard--payroll .kpi-card h3 { margin: 0; font-size: 1rem; }
    body.dashboard--payroll .kpi-card .meta { margin: 0; }
    @media (max-width: 960px) {
      body.dashboard .page-header { text-align: center; flex-direction: column; align-items: stretch; }
      body.dashboard .page-header__meta { text-align: center; justify-items: center; }
      body.dashboard--payroll-detail .detail-header { flex-direction: column; align-items: flex-start; }
      body.dashboard--payroll-detail .detail-meta { justify-items: flex-start; text-align: left; width: 100%; }
      body.dashboard--payroll-detail .detail-meta span { justify-self: flex-start; }
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
      body.dashboard--payroll-detail .detail-utility-row { flex-direction: column; align-items: stretch; }
      body.dashboard--payroll-detail .detail-utility-actions { justify-content: stretch; width: 100%; }
      body.dashboard--payroll-detail .detail-utility-actions .button { width: 100%; }
      body.dashboard--payroll-detail .detail-kpis { grid-template-columns: 1fr; }
    }
`;
const formatRangeLabel = (start, end) => end && end.getTime() !== start.getTime() ? `${formatFullDate(start)} – ${formatFullDate(end)}` : formatFullDate(start);
const renderTimezoneNote = (start, end) => `<p class="tz-note">All times shown in ${escapeHtml(DASHBOARD_TIME_ZONE)} (${escapeHtml(formatRangeLabel(start, end))})</p>`;
const renderNav = (active) => {
    const isPayrollContext = active === 'payroll' || active === 'payroll-holidays' || active === 'payroll-employees';
    const isTimeOffContext = active === 'balances' || active === 'requests';
    const link = (href, label, key, options) => {
        const classes = ['nav__link'];
        const isActive = key === 'payroll' ? isPayrollContext : key === 'time-off' ? isTimeOffContext : active === key;
        if (options?.child) {
            classes.push('nav__link--child');
        }
        if (options?.className) {
            classes.push(options.className);
        }
        if (isActive) {
            classes.push('active');
        }
        const classAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
        const ariaCurrent = isActive ? ' aria-current="page"' : '';
        const extraAttrs = [];
        if (typeof options?.ariaExpanded === 'boolean') {
            extraAttrs.push(`aria-expanded="${options.ariaExpanded}"`);
        }
        if (options?.ariaHaspopup) {
            extraAttrs.push('aria-haspopup="true"');
        }
        const attrSuffix = extraAttrs.length ? ` ${extraAttrs.join(' ')}` : '';
        return `<a href="${href}"${classAttr}${ariaCurrent}${attrSuffix}>${label}</a>`;
    };
    const wrapItem = (markup) => `<div class="nav__item">${markup}</div>`;
    const dropdown = (href, label, key, items) => {
        const isParentActive = key === 'payroll' ? isPayrollContext : key === 'time-off' ? isTimeOffContext : active === key;
        const dropdownMarkup = items
            .map((item) => `<li class="nav__dropdown-item">${link(item.href, item.label, item.key, { child: true })}</li>`)
            .join('');
        const parentLink = link(href, label, key, {
            className: 'nav__link--parent',
            ariaExpanded: isParentActive,
            ariaHaspopup: true
        });
        const classes = ['nav__item', 'nav__item--dropdown'];
        if (isParentActive) {
            classes.push('nav__item--active');
        }
        return `<div class="${classes.join(' ')}">${parentLink}<ul class="nav__dropdown">${dropdownMarkup}</ul></div>`;
    };
    const links = [
        wrapItem(link('/dashboard/overview', 'Overview', 'overview')),
        wrapItem(link('/dashboard/today', 'Today', 'today')),
        wrapItem(link('/dashboard/timesheets', 'Timesheets', 'timesheets')),
        dropdown('/dashboard/balances', 'Time Off', 'time-off', [
            { href: '/dashboard/balances', label: 'Balances', key: 'balances' },
            { href: '/dashboard/requests', label: 'Requests', key: 'requests' }
        ]),
        wrapItem(link('/dashboard/shifts', 'Shifts', 'shifts')),
        dropdown('/dashboard/payroll', 'Payroll', 'payroll', [
            { href: '/dashboard/payroll/employees', label: 'Employee Profiles', key: 'payroll-employees' },
            { href: '/dashboard/payroll/holidays', label: 'Holiday Settings', key: 'payroll-holidays' }
        ]),
        wrapItem(link('/dashboard/settings', 'Settings', 'settings'))
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
    const expireOptions = {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION,
        maxAge: 0
    };
    res.cookie(auth_1.DASHBOARD_TOKEN_COOKIE_NAME, '', {
        ...expireOptions,
        path: DASHBOARD_COOKIE_PATH
    });
    if (DASHBOARD_COOKIE_PATH !== '/dashboard') {
        // Clear any legacy cookie that was previously scoped to /dashboard.
        res.cookie(auth_1.DASHBOARD_TOKEN_COOKIE_NAME, '', {
            ...expireOptions,
            path: '/dashboard'
        });
    }
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
            'Started At',
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
            escapeCsv(formatCsvDateTime(summary.startedAt)),
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
exports.dashboardRouter.get('/shifts', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parseLookahead = (value) => {
        if (typeof value !== 'string')
            return NaN;
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : NaN;
    };
    const requestedDays = parseLookahead(req.query.days);
    const lookaheadDays = Number.isFinite(requestedDays)
        ? Math.min(Math.max(requestedDays, 1), 60)
        : 14;
    const generationSummary = {
        usersProcessed: 0,
        created: 0,
        skipped: 0,
        triggered: false
    };
    const now = new Date();
    const windowStart = (0, timesheets_1.timesheetDayStart)(now);
    const windowEnd = (0, timesheets_1.timesheetDayEnd)((0, date_fns_1.addDays)(now, lookaheadDays));
    const assignments = await prisma_1.prisma.shiftAssignment.findMany({
        where: {
            startsAt: { gte: windowStart },
            endsAt: { lte: windowEnd }
        },
        include: {
            user: { select: { id: true, name: true, email: true } }
        },
        orderBy: [{ startsAt: 'asc' }]
    });
    const requests = await prisma_1.prisma.timeRequest.findMany({
        where: {
            status: 'approved',
            startDate: { lte: windowEnd },
            endDate: { gte: windowStart }
        },
        include: {
            user: { select: { id: true, name: true, email: true } }
        },
        orderBy: [{ startDate: 'asc' }]
    });
    const formatDuration = (start, end) => {
        const minutes = Math.max(0, (0, date_fns_1.differenceInMinutes)(end, start));
        if (minutes < 60) {
            return `${minutes} min`;
        }
        const hours = Math.floor(minutes / 60);
        const remaining = minutes % 60;
        return remaining === 0 ? `${hours} hr${hours === 1 ? '' : 's'}` : `${hours} hr ${remaining} min`;
    };
    const TYPE_LABELS = {
        shift: 'Scheduled Shift',
        pto: 'Paid Time Off',
        uto: 'Unpaid Time Off',
        make_up: 'Make-up Hours'
    };
    const mapRequestKind = (type) => {
        switch (type) {
            case 'pto':
                return 'pto';
            case 'uto':
            case 'non_pto':
                return 'uto';
            case 'make_up':
            default:
                return 'make_up';
        }
    };
    const combinedEntries = [];
    const totals = {
        shift: 0,
        pto: 0,
        uto: 0,
        make_up: 0
    };
    const shiftEntries = assignments.map((assignment) => ({
        kind: 'shift',
        start: assignment.startsAt,
        end: assignment.endsAt,
        employeeName: assignment.user?.name ?? `User ${assignment.userId}`,
        email: assignment.user?.email ?? '',
        label: assignment.label ?? TYPE_LABELS.shift,
        source: 'shift',
        overlap: false
    }));
    for (const entry of shiftEntries) {
        combinedEntries.push(entry);
        totals.shift += 1;
    }
    for (const request of requests) {
        const kind = mapRequestKind(request.type);
        let start = request.startDate;
        let end = request.endDate;
        if (end.getTime() <= start.getTime() && typeof request.hours === 'number' && request.hours > 0) {
            const minutes = Math.round(request.hours * 60);
            end = new Date(start.getTime() + minutes * 60000);
        }
        combinedEntries.push({
            kind,
            start,
            end,
            employeeName: request.user?.name ?? `User ${request.userId}`,
            email: request.user?.email ?? '',
            label: TYPE_LABELS[kind],
            reason: request.reason ?? null,
            source: 'request',
            overlap: false
        });
        totals[kind] += 1;
    }
    combinedEntries.sort((a, b) => a.start.getTime() - b.start.getTime());
    const entriesByUser = new Map();
    combinedEntries.forEach((entry) => {
        const key = entry.email + entry.employeeName;
    });
    const entriesByUserId = new Map();
    for (const entry of combinedEntries) {
        const key = `${entry.employeeName}|${entry.email}`;
        const bucket = entriesByUserId.get(key);
        if (bucket) {
            bucket.push(entry);
        }
        else {
            entriesByUserId.set(key, [entry]);
        }
    }
    for (const bucket of entriesByUserId.values()) {
        bucket.sort((a, b) => a.start.getTime() - b.start.getTime());
        for (let i = 0; i < bucket.length; i += 1) {
            const current = bucket[i];
            for (let j = i + 1; j < bucket.length; j += 1) {
                const compare = bucket[j];
                if (compare.start.getTime() >= current.end.getTime()) {
                    break;
                }
                if (compare.end.getTime() > current.start.getTime()) {
                    current.overlap = true;
                    compare.overlap = true;
                }
            }
        }
    }
    const shiftRows = combinedEntries.length
        ? combinedEntries
            .map((entry) => {
            const typeLabel = TYPE_LABELS[entry.kind];
            const dateLabel = formatFullDate(entry.start);
            const startTime = formatTimeOfDay(entry.start);
            const endTime = formatTimeOfDay(entry.end);
            const duration = formatDuration(entry.start, entry.end);
            const displayLabel = entry.reason && entry.reason.trim().length ? entry.reason.trim() : entry.label;
            const rowClass = entry.overlap
                ? `schedule-row schedule-row--${entry.kind} schedule-row--overlap`
                : `schedule-row schedule-row--${entry.kind}`;
            const overlapChip = entry.overlap
                ? '<span class="status-chip status-chip--warn">Overlap</span>'
                : '';
            return `
              <tr class="${rowClass}">
                <td>
                  ${escapeHtml(entry.employeeName)}
                  <div class="meta">${escapeHtml(entry.email)}</div>
                </td>
                <td>${escapeHtml(dateLabel)}</td>
                <td>${escapeHtml(startTime)}</td>
                <td>${escapeHtml(endTime)}</td>
                <td>${escapeHtml(duration)}</td>
                <td>${escapeHtml(typeLabel)}${overlapChip}</td>
                <td>${escapeHtml(displayLabel || '—')}</td>
              </tr>
            `;
        })
            .join('\n')
        : `<tr><td colspan="7" class="empty">No shifts scheduled for the next ${lookaheadDays} day${lookaheadDays === 1 ? '' : 's'}.</td></tr>`;
    const summaryCard = `
      <section class="card card--summary">
        <div class="card__header">
          <div>
            <h2 class="card__title">Latest Shift Generation</h2>
            <p class="card__subtitle">Window: next ${lookaheadDays} day${lookaheadDays === 1 ? '' : 's'}.</p>
          </div>
        </div>
        <div class="card__body">
          <dl class="summary-grid">
            <div>
              <dt>Employees Processed</dt>
              <dd>${generationSummary.usersProcessed}</dd>
            </div>
            <div>
              <dt>Shifts Created</dt>
              <dd>${generationSummary.created}</dd>
            </div>
            <div>
              <dt>Shifts Skipped</dt>
              <dd>${generationSummary.skipped}</dd>
            </div>
            <div>
              <dt>PTO Blocks</dt>
              <dd>${totals.pto}</dd>
            </div>
            <div>
              <dt>UTO Blocks</dt>
              <dd>${totals.uto}</dd>
            </div>
            <div>
              <dt>Make-up Blocks</dt>
              <dd>${totals.make_up}</dd>
            </div>
          </dl>
        </div>
      </section>
    `;
    const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Upcoming Shifts</title>
          <style>${baseStyles}</style>
        </head>
        <body class="dashboard dashboard--shifts">
          ${renderNav('shifts')}
          <main class="page-shell">
            <header class="page-header">
              <div class="page-header__content">
                <p class="page-header__eyebrow">Scheduling</p>
                <h1 class="page-header__title">Upcoming Shifts</h1>
                <p class="page-header__subtitle">Review and regenerate shift assignments derived from employee schedule templates.</p>
              </div>
              <div class="page-header__meta">
                <form method="get" action="/dashboard/shifts" class="filters">
                  <label>
                    <span>Look ahead (days)</span>
                    <input type="number" name="days" value="${lookaheadDays}" min="1" max="60" />
                  </label>
                  <button type="submit" class="button-secondary">Update</button>
                </form>
              </div>
            </header>
            ${summaryCard}
            <section class="card">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Generate Upcoming Shifts</h2>
                  <p class="card__subtitle">Run the generator to populate the next two weeks of shift assignments immediately.</p>
                </div>
              </div>
              <div class="card__body">
                <form data-async="true" data-kind="shift-rebuild" data-success-message="Upcoming shifts refreshed." class="stack-form">
                  <p class="meta">The generator respects each employee&apos;s saved schedule pattern and skips existing shifts.</p>
                  <p class="form-error" data-error></p>
                  <button type="submit" class="button-secondary">Generate Upcoming Shifts</button>
                </form>
              </div>
            </section>
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Upcoming Shift Schedule</h2>
                  <p class="card__subtitle">Showing assignments between ${escapeHtml(formatFullDate(windowStart))} and ${escapeHtml(formatFullDate(windowEnd))} (${escapeHtml(DASHBOARD_TIME_ZONE)}).</p>
                </div>
              </div>
              <div class="card__body">
                <div class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Date</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Duration</th>
                        <th>Type</th>
                        <th>Label / Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${shiftRows}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </main>
          <script>
            (() => {
              const reloadWithBanner = (message, error) => {
                const url = new URL(window.location.href);
                if (message) {
                  url.searchParams.set('message', message);
                  url.searchParams.delete('error');
                } else if (error) {
                  url.searchParams.set('error', error);
                  url.searchParams.delete('message');
                } else {
                  url.searchParams.delete('message');
                  url.searchParams.delete('error');
                }
                window.location.href = url.toString();
              };

              const setError = (target, text) => {
                const el = typeof target === 'string' ? document.getElementById(target) : target;
                if (el) {
                  el.textContent = text;
                }
              };

              const form = document.querySelector('form[data-kind="shift-rebuild"]');
              if (form) {
                form.addEventListener('submit', async (event) => {
                  event.preventDefault();
                  const errorEl = form.querySelector('[data-error]');
                  if (errorEl) errorEl.textContent = '';
                  const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
                  if (submitter) submitter.disabled = true;
                  try {
                    const response = await fetch('/api/payroll/shifts/rebuild', {
                      method: 'POST',
                      credentials: 'same-origin'
                    });
                    if (!response.ok) {
                      let message = 'Unable to generate shifts.';
                      try {
                        const data = await response.json();
                        if (data && typeof data.error === 'string') message = data.error;
                        else if (data && typeof data.message === 'string') message = data.message;
                      } catch (err) {}
                      throw new Error(message);
                    }
                    let message = form.getAttribute('data-success-message') || 'Upcoming shifts refreshed.';
                    try {
                      const data = await response.json();
                      if (data?.summary && typeof data.summary.created === 'number') {
                        const created = data.summary.created;
                        const skipped = typeof data.summary.skipped === 'number' ? data.summary.skipped : 0;
                        const plural = created === 1 ? '' : 's';
                        message = 'Generated ' + created + ' shift' + plural + ' (' + skipped + ' skipped).';
                      }
                    } catch (err) {}
                    reloadWithBanner(message);
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unable to generate shifts.';
                    setError(errorEl, message);
                    if (submitter) submitter.disabled = false;
                  }
                });
              }
            })();
          </script>
        </body>
      </html>
    `;
    res.type('html').send(html);
}));
exports.dashboardRouter.get('/weekly', async (req, res) => {
    const today = zonedStartOfDay(new Date());
    const baseStart = typeof req.query.start === 'string' ? parseDateParam(req.query.start) : (0, date_fns_1.subDays)(today, 6);
    const weeklyData = await fetchWeeklyAggregates(baseStart);
    const { windowStart, windowEnd, startParam, summaries } = weeklyData;
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
            'Range Start',
            'Range End',
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
            escapeCsv(formatCsvDate(windowStart)),
            escapeCsv(formatCsvDate(windowEnd)),
            escapeCsv(DASHBOARD_TIME_ZONE)
        ].join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="weekly-${startParam}.csv"`);
        return res.send(csv);
    }
    res.redirect(`/dashboard/overview?view=weekly&start=${encodeURIComponent(startParam)}`);
});
exports.dashboardRouter.get('/monthly', async (req, res) => {
    const reference = parseMonthParam(req.query.month);
    const monthlyData = await fetchMonthlyAggregates(reference);
    const { monthStart, monthEnd, monthParam, summaries } = monthlyData;
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
            'Range Start',
            'Range End',
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
            escapeCsv(formatCsvDate(monthStart)),
            escapeCsv(formatCsvDate(monthEnd)),
            escapeCsv(DASHBOARD_TIME_ZONE)
        ].join(','));
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="monthly-${monthParam}.csv"`);
        return res.send(csv);
    }
    res.redirect(`/dashboard/overview?view=monthly&month=${encodeURIComponent(monthParam)}`);
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
        presence: acc.presence + entry.summary.totals.presenceMisses,
        tardyMinutes: acc.tardyMinutes + entry.summary.totals.tardyMinutes
    }), { activeMinutes: 0, idleMinutes: 0, breaks: 0, lunches: 0, presence: 0, tardyMinutes: 0 });
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
            <div class="summary-card">
              <div class="summary-title">Tardy Minutes</div>
              <div class="summary-value">${aggregate.tardyMinutes}</div>
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
                        <td>${day.tardyMinutes}</td>
                        <td>${escapeHtml(requestsText)}</td>
                      </tr>
                    `;
                })
                    .join('\n')
                : '<tr><td colspan="8" class="empty">No activity recorded for this range.</td></tr>';
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
                <div class="summary-card">
                  <div class="summary-title">Tardy Minutes</div>
                  <div class="summary-value">${summary.totals.tardyMinutes}</div>
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
                      <th>Tardy (min)</th>
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
            'Created At',
            'Name',
            'Email',
            'Type',
            'Status',
            'Start Date',
            'End Date',
            'Hours',
            'Reason',
            'Approver Name',
            'Approver Email',
            'Timezone'
        ];
        const rows = requests.map((request) => [
            escapeCsv(formatCsvDateTime(request.createdAt)),
            escapeCsv(request.user.name),
            escapeCsv(request.user.email),
            escapeCsv(request.type),
            escapeCsv(request.status),
            escapeCsv(formatCsvDate(request.startDate)),
            escapeCsv(formatCsvDate(request.endDate)),
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
    const rosterLegend = renderRosterLegend(computeRosterLegendCounts(rosterData.rows));
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
          <div class="live-roster-card">
            <div class="live-roster-card__header">
              <div class="live-roster-card__heading">
                <h3 class="live-roster-card__title">Live Roster</h3>
                ${rosterLegend}
              </div>
              <button type="button" class="live-roster-refresh" data-roster-refresh aria-label="Refresh roster">
                <span aria-hidden="true">⟳</span>
              </button>
            </div>
            <div class="live-roster-card__body">
              <div class="live-roster-card__notice${noticeHiddenClass ? ' hidden' : ''}" data-roster-notice>${computedNotice}</div>
              <div class="live-roster-card__table-scroll table-scroll${hasRosterRows ? '' : ' hidden'}" data-roster-container>
                <table class="live-roster-table" data-roster-table data-date-param="${dailyData.dateParam}">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Current Status</th>
                      <th>Current Idle (min)</th>
                      <th>Total Idle Today (min)</th>
                      <th>Break # Today</th>
                      <th>Total Break Minutes</th>
                      <th>Lunch Count</th>
                      <th>Total Lunch Minutes</th>
                      <th>Log In Time (h:mm AM/PM)</th>
                      <th>Tardy Minutes</th>
                      <th>Presence Misses</th>
                    </tr>
                  </thead>
                  <tbody data-roster-body>
                    ${todayRows}
                  </tbody>
                </table>
              </div>
              <div class="empty${hasRosterRows ? ' hidden' : ''}" data-roster-empty>No users available for this date.</div>
            </div>
          </div>
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
              const legend = document.querySelector('[data-roster-legend]');
              const refreshButton = document.querySelector('[data-roster-refresh]');
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
                return String(value) + 'm';
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
                  ].join('\\n');

                  const activitySection = [
                    '<div class="drilldown-section">',
                    '  <h3>Today&#39;s activity</h3>',
                    '  <div class="drilldown-grid">',
                    '    ' + buildStat('Idle total', formatMinutesValue(data.idleTotal)),
                    '    ' + buildStat('Breaks', formatCountValue(data.breakCount), data.breakMinutes !== null ? formatMinutesValue(data.breakMinutes) : ''),
                    '    ' + buildStat('Lunches', formatCountValue(data.lunchCount), data.lunchMinutes !== null ? formatMinutesValue(data.lunchMinutes) : ''),
                    '    ' + buildStat('Presence misses', formatCountValue(data.presenceMisses)),
                    '  </div>',
                    '</div>'
                  ].join('\\n');

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
                  const timelineSection = timelineParts.join('\\n');

                  content.innerHTML = [statusSection, activitySection, timelineSection].join('\\n');
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
              const legendCounts = { working: 0, break: 0, lunch: 0, offline: 0 };
              const statusToLegend = {
                active: 'working',
                break: 'break',
                lunch: 'lunch',
                logged_out: 'offline',
                not_logged_in: 'offline',
                pto: 'offline',
                uto: 'offline',
                make_up: 'offline'
              };

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
                table.querySelectorAll('[data-idle-cell] [data-idle-since]').forEach((el) => {
                  const iso = el.getAttribute('data-idle-since');
                  if (!iso) return;
                  const since = Date.parse(iso);
                  if (Number.isNaN(since)) return;
                  const minutes = Math.max(0, Math.ceil((now - since) / 60000));
                  el.textContent = String(minutes) + 'm';
                });
              };

              const applyLegendCounts = (counts) => {
                if (!legend) return;
                Object.keys(counts).forEach((key) => {
                  const selector = '[data-legend-item="' + key + '"]';
                  const item = legend.querySelector(selector);
                  const valueEl = item ? item.querySelector('[data-legend-count]') : null;
                  if (valueEl) {
                    valueEl.textContent = String(counts[key]);
                  }
                });
              };

              const updateLegendFromRows = () => {
                const nextCounts = { working: 0, break: 0, lunch: 0, offline: 0 };
                if (body) {
                  Array.from(body.querySelectorAll('tr[data-status-key]')).forEach((row) => {
                    const status = row.getAttribute('data-status-key') || 'offline';
                    const legendKey = statusToLegend[status] || 'offline';
                    nextCounts[legendKey] += 1;
                  });
                }
                Object.assign(legendCounts, nextCounts);
                applyLegendCounts(legendCounts);
              };

              const applyPayload = (payload) => {
                if (payload && typeof payload.dateParam === 'string') {
                  table.setAttribute('data-date-param', payload.dateParam);
                }
                if (body && payload) {
                  body.innerHTML = payload.rowsHtml || '';
                }
                updateLegendFromRows();
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

              let refreshInFlight = false;

              const setRefreshing = (state) => {
                if (!refreshButton) return;
                refreshButton.classList.toggle('is-refreshing', state);
                refreshButton.disabled = state;
                refreshButton.setAttribute('aria-busy', state ? 'true' : 'false');
              };

              const refresh = async () => {
                if (refreshInFlight) {
                  return;
                }
                refreshInFlight = true;
                setRefreshing(true);
                try {
                  const dateParam = table.getAttribute('data-date-param') || '';
                  const url = new URL('/dashboard/overview/today.json', window.location.origin);
                  if (dateParam) {
                    url.searchParams.set('date', dateParam);
                  }
                  const response = await fetch(url.toString(), {
                    headers: { 'Accept': 'application/json' },
                    credentials: 'same-origin'
                  });
                  if (!response.ok) return;
                  const data = await response.json();
                  applyPayload(data);
                } catch (error) {
                  console.error('dashboard.roster.refresh_failed', error);
                } finally {
                  refreshInFlight = false;
                  setRefreshing(false);
                }
              };

              if (refreshButton) {
                refreshButton.addEventListener('click', () => {
                  refresh();
                });
              }

              updateTimers();
              setInterval(updateTimers, 1000);
              updateLegendFromRows();
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
    const noticeHtml = rosterData.hasComputedNotice
        ? '<p class="meta meta--admin">Idle, break, and lunch totals are computed from today\'s activity history.</p>'
        : '';
    res.json({
        dateParam: dailyData.dateParam,
        label: dailyData.label,
        rowsHtml,
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
        uto: user.balance?.utoHours ?? 0,
        makeUp: user.balance?.makeUpHours ?? 0,
        basePto: user.balance?.basePtoHours ?? 0,
        baseUto: user.balance?.baseUtoHours ?? 0,
        baseMakeUp: user.balance?.baseMakeUpHours ?? 0,
        updatedAt: user.balance?.updatedAt ?? null
    }));
    const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
    if (wantsCsv) {
        const header = [
            'Name',
            'Email',
            'PTO Hours',
            'UTO Hours',
            'Make-Up Hours',
            'Base PTO',
            'Base UTO',
            'Base Make-Up',
            'Updated At',
            'Timezone'
        ];
        const csvRows = rows.map((row) => [
            escapeCsv(row.name),
            escapeCsv(row.email),
            escapeCsv(formatHours(row.pto)),
            escapeCsv(formatHours(row.uto)),
            escapeCsv(formatHours(row.makeUp)),
            escapeCsv(formatHours(row.basePto)),
            escapeCsv(formatHours(row.baseUto)),
            escapeCsv(formatHours(row.baseMakeUp)),
            escapeCsv(row.updatedAt ? formatCsvDateTime(row.updatedAt) : ''),
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
        acc.uto += row.uto;
        acc.makeUp += row.makeUp;
        return acc;
    }, { pto: 0, uto: 0, makeUp: 0 });
    const tableRows = rows
        .map((row) => {
        const updatedLabel = row.updatedAt ? formatDateTime(row.updatedAt) : '—';
        const isSelected = selectedUser?.id === row.id;
        return `<tr${isSelected ? ' class="highlight-row"' : ''}>
        <td><a href="/dashboard/balances?userId=${row.id}">${escapeHtml(row.name)}</a></td>
        <td>${escapeHtml(formatHours(row.pto))} h<div class="meta">Base ${escapeHtml(formatHours(row.basePto))} h</div></td>
        <td>${escapeHtml(formatHours(row.uto))} h<div class="meta">Base ${escapeHtml(formatHours(row.baseUto))} h</div></td>
        <td>${escapeHtml(formatHours(row.makeUp))} h<div class="meta">Base ${escapeHtml(formatHours(row.baseMakeUp))} h</div></td>
        <td>${escapeHtml(updatedLabel)}</td>
      </tr>`;
    })
        .join('\n');
    const totalsRow = rows.length
        ? `<tfoot>
        <tr class="totals">
          <th>Totals</th>
          <th>${escapeHtml(formatHours(totals.pto))} h</th>
          <th>${escapeHtml(formatHours(totals.uto))} h</th>
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
        const makeUpCap = await (0, timeRequestPolicy_1.getMakeupCapHoursPerMonth)();
        const latestConfig = await prisma_1.prisma.employeeCompConfig.findFirst({
            where: { userId: selectedUser.id },
            orderBy: { effectiveOn: 'desc' }
        });
        const userRule = await prisma_1.prisma.accrualRule.findUnique({ where: { userId: selectedUser.id } });
        const defaultRule = await prisma_1.prisma.accrualRule.findFirst({ where: { isDefault: true } });
        const resolveAccrual = (selector) => {
            if (userRule) {
                const value = selector(userRule);
                if (value !== undefined && value !== null) {
                    return Number(value);
                }
            }
            if (defaultRule) {
                const value = selector(defaultRule);
                if (value !== undefined && value !== null) {
                    return Number(value);
                }
            }
            return 0;
        };
        const basePto = Number(balance.basePtoHours);
        const baseUto = Number(balance.baseUtoHours);
        const baseMakeUp = Number(balance.baseMakeUpHours ?? 0);
        const currentPto = Number(balance.ptoHours);
        const currentUto = Number(balance.utoHours);
        const currentMakeUp = Number(balance.makeUpHours);
        const ptoAccrual = resolveAccrual((rule) => rule?.ptoHoursPerMonth ?? rule?.hoursPerMonth ?? 0);
        const utoAccrual = resolveAccrual((rule) => rule?.utoHoursPerMonth ?? 0);
        const makeUpAccrual = 0;
        const accrualSource = userRule ? 'user' : defaultRule ? 'default' : 'none';
        const accrualStatusLabel = accrualSource === 'user' ? 'User override' : accrualSource === 'default' ? 'Default rule' : 'No rule set';
        const summaryCards = `
      <div class="summary-cards">
        <div class="summary-card">
          <div class="summary-title">PTO Remaining</div>
          <div class="summary-value"><span data-balance-current>${escapeHtml(formatHours(currentPto))}</span> h</div>
          <div class="summary-meta">Baseline ${escapeHtml(formatHours(basePto))} h${ptoAccrual > 0 ? ` • Accrues ${escapeHtml(formatHours(ptoAccrual))} h/mo` : ''}</div>
        </div>
        <div class="summary-card">
          <div class="summary-title">UTO Remaining</div>
          <div class="summary-value">${escapeHtml(formatHours(currentUto))} h</div>
          <div class="summary-meta">Baseline ${escapeHtml(formatHours(baseUto))} h${utoAccrual > 0 ? ` • Accrues ${escapeHtml(formatHours(utoAccrual))} h/mo` : ''}</div>
        </div>
        <div class="summary-card">
          <div class="summary-title">Make-Up Hours</div>
          <div class="summary-value">${escapeHtml(formatHours(currentMakeUp))} h</div>
          <div class="summary-meta">Monthly cap ${escapeHtml(formatHours(makeUpCap))} h</div>
        </div>
        <div class="summary-card">
          <div class="summary-title">Monthly Accrual</div>
          <div class="summary-value">${escapeHtml([`PTO ${formatHours(ptoAccrual)} h/mo`, `UTO ${formatHours(utoAccrual)} h/mo`].join(' • '))}</div>
          <div class="summary-meta">${accrualStatusLabel} · Accrual enabled (set monthly rate to 0 to pause)</div>
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
      <dialog id="edit-balances-dialog">
        <form id="edit-balances-form">
          <h3>Edit Time Off Balances</h3>
          <p class="dialog-meta">Set new totals below; adjustments are logged automatically.</p>
          <div class="dialog-section">
            <h4>PTO</h4>
            <div class="dialog-grid">
              <label>
                <span>Base Allowance (hours)</span>
                <input type="number" name="ptoBaseHours" step="0.25" min="0" />
              </label>
              <label>
                <span>Remaining (hours)</span>
                <input type="number" name="ptoHours" step="0.25" min="0" />
              </label>
            </div>
          </div>
          <div class="dialog-section">
            <h4>UTO</h4>
            <div class="dialog-grid">
              <label>
                <span>Base Allowance (hours)</span>
                <input type="number" name="utoBaseHours" step="0.25" min="0" />
              </label>
              <label>
                <span>Remaining (hours)</span>
                <input type="number" name="utoHours" step="0.25" min="0" />
              </label>
            </div>
          </div>
          <div class="dialog-section">
            <h4>Make-Up</h4>
            <div class="dialog-grid">
              <label>
                <span>Remaining (hours)</span>
                <input type="number" name="makeUpHours" step="0.25" min="0" />
              </label>
              <label>
                <span>Monthly Cap (hours)</span>
                <input type="number" name="makeUpCapHours" step="0.25" min="0" />
              </label>
            </div>
          </div>
          <p class="dialog-note">Accrual runs each month (${accrualStatusLabel}). Set monthly rates to 0 hours if an employee should not accrue. Make-up balances are capped monthly and do not accrue automatically.</p>
          <div class="dialog-grid">
            <label>
              <span>PTO Accrual (hours/mo)</span>
              <input type="number" name="ptoAccrualHours" step="0.25" min="0" />
            </label>
            <label>
              <span>UTO Accrual (hours/mo)</span>
              <input type="number" name="utoAccrualHours" step="0.25" min="0" />
            </label>
          </div>
          <label>
            <span>Reason</span>
            <textarea name="reason" rows="3" maxlength="500" placeholder="Explain this update"></textarea>
          </label>
          <p class="dialog-error" data-balance-error></p>
          <div class="dialog-actions">
            <button type="submit">Save Changes</button>
            <button type="button" class="button-secondary" data-close-edit>Cancel</button>
          </div>
        </form>
      </dialog>
    `;
        detailSection = `
      <section
        class="card balances-detail"
        id="balance-detail"
        data-user-id="${selectedUser.id}"
        data-pto-base="${basePto}"
        data-pto-remaining="${currentPto}"
        data-uto-base="${baseUto}"
        data-uto-remaining="${currentUto}"
        data-makeup-base="${baseMakeUp}"
        data-makeup-remaining="${currentMakeUp}"
        data-pto-accrual="${ptoAccrual}"
        data-uto-accrual="${utoAccrual}"
        data-makeup-cap="${makeUpCap}"
        data-accrual-enabled="true"
        data-accrual-source="${accrualSource}"
      >
        <div class="card__header">
          <div>
            <h2 class="card__title">${escapeHtml(selectedUser.name)}</h2>
            <p class="card__subtitle">${escapeHtml(selectedUser.email)}</p>
          </div>
          <div class="card__actions no-print balances-detail-actions">
            <button type="button" class="button" data-open-edit>Edit Balances</button>
            <a href="/dashboard/requests?type=pto" class="button button-secondary">Review PTO Requests</a>
          </div>
        </div>
        <div class="card__body">
          ${summaryCards}
          ${dialogHtml}
          <h3>Balance Ledger</h3>
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
            const dialog = detail.querySelector('#edit-balances-dialog');
            const form = detail.querySelector('#edit-balances-form');
            const errorEl = detail.querySelector('[data-balance-error]');
            const openBtn = detail.querySelector('[data-open-edit]');
            const closeBtn = detail.querySelector('[data-close-edit]');

            const datasetValue = (key) => {
              const raw = detail.dataset[key];
              if (raw === undefined || raw === '') return '';
              const parsed = Number(raw);
              return Number.isFinite(parsed) ? String(parsed) : '';
            };

            const toggleDialog = (open) => {
              if (!dialog) return;
              if (typeof dialog.showModal === 'function') {
                open ? dialog.showModal() : dialog.close();
              } else {
                dialog.classList.toggle('hidden', !open);
              }
            };

            const prefillForm = () => {
              if (!form) return;
              const ptoBaseInput = form.querySelector('input[name="ptoBaseHours"]');
              if (ptoBaseInput instanceof HTMLInputElement) {
                ptoBaseInput.value = datasetValue('ptoBase');
              }
              const ptoInput = form.querySelector('input[name="ptoHours"]');
              if (ptoInput instanceof HTMLInputElement) {
                ptoInput.value = datasetValue('ptoRemaining');
              }
              const utoBaseInput = form.querySelector('input[name="utoBaseHours"]');
              if (utoBaseInput instanceof HTMLInputElement) {
                utoBaseInput.value = datasetValue('utoBase');
              }
              const utoInput = form.querySelector('input[name="utoHours"]');
              if (utoInput instanceof HTMLInputElement) {
                utoInput.value = datasetValue('utoRemaining');
              }
              const makeUpInput = form.querySelector('input[name="makeUpHours"]');
              if (makeUpInput instanceof HTMLInputElement) {
                makeUpInput.value = datasetValue('makeupRemaining');
              }
              const ptoAccrualInput = form.querySelector('input[name="ptoAccrualHours"]');
              if (ptoAccrualInput instanceof HTMLInputElement) {
                ptoAccrualInput.value = datasetValue('ptoAccrual');
              }
              const utoAccrualInput = form.querySelector('input[name="utoAccrualHours"]');
              if (utoAccrualInput instanceof HTMLInputElement) {
                utoAccrualInput.value = datasetValue('utoAccrual');
              }
              const makeUpCapInput = form.querySelector('input[name="makeUpCapHours"]');
              if (makeUpCapInput instanceof HTMLInputElement) {
                makeUpCapInput.value = datasetValue('makeupCap');
              }
              const reasonInput = form.querySelector('textarea[name="reason"]');
              if (reasonInput instanceof HTMLTextAreaElement) {
                reasonInput.value = '';
              }
            };

            openBtn?.addEventListener('click', () => {
              if (errorEl) errorEl.textContent = '';
              prefillForm();
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

              const payload = {};
              const parseNumeric = (input, label) => {
                if (!(input instanceof HTMLInputElement) || input.disabled) return undefined;
                const raw = input.value.trim();
                if (!raw) return undefined;
                const value = Number(raw);
                if (!Number.isFinite(value)) {
                  throw new Error(label + ' must be a valid number.');
                }
                return Math.round(value * 100) / 100;
              };

              try {
                const ptoBaseInput = form.querySelector('input[name="ptoBaseHours"]');
                const ptoInput = form.querySelector('input[name="ptoHours"]');
                const utoBaseInput = form.querySelector('input[name="utoBaseHours"]');
                const utoInput = form.querySelector('input[name="utoHours"]');
                const makeUpInput = form.querySelector('input[name="makeUpHours"]');
                const ptoAccrualInput = form.querySelector('input[name="ptoAccrualHours"]');
                const utoAccrualInput = form.querySelector('input[name="utoAccrualHours"]');
                const makeUpCapInput = form.querySelector('input[name="makeUpCapHours"]');
                const reasonInput = form.querySelector('textarea[name="reason"]');

                const ptoBaseValue = parseNumeric(ptoBaseInput, 'PTO base');
                if (ptoBaseValue !== undefined) payload.ptoBaseHours = ptoBaseValue;
                const ptoValue = parseNumeric(ptoInput, 'PTO balance');
                if (ptoValue !== undefined) payload.ptoHours = ptoValue;
                const utoBaseValue = parseNumeric(utoBaseInput, 'UTO base');
                if (utoBaseValue !== undefined) payload.utoBaseHours = utoBaseValue;
                const utoValue = parseNumeric(utoInput, 'UTO balance');
                if (utoValue !== undefined) payload.utoHours = utoValue;
                const makeUpValue = parseNumeric(makeUpInput, 'Make-Up balance');
                if (makeUpValue !== undefined) payload.makeUpHours = makeUpValue;
                const ptoAccrualValue = parseNumeric(ptoAccrualInput, 'PTO accrual');
                if (ptoAccrualValue !== undefined) payload.ptoAccrualHours = ptoAccrualValue;
                const utoAccrualValue = parseNumeric(utoAccrualInput, 'UTO accrual');
                if (utoAccrualValue !== undefined) payload.utoAccrualHours = utoAccrualValue;
                const makeUpCapValue = parseNumeric(makeUpCapInput, 'Make-Up monthly cap');
                if (makeUpCapValue !== undefined) payload.makeUpCapHours = makeUpCapValue;
                const reason = reasonInput instanceof HTMLTextAreaElement ? reasonInput.value.trim() : '';
                if (reason) {
                  payload.reason = reason;
                }

                if (
                  !('ptoHours' in payload) &&
                  !('utoHours' in payload) &&
                  !('makeUpHours' in payload) &&
                  !('ptoAccrualHours' in payload) &&
                  !('utoAccrualHours' in payload) &&
                  !('makeUpCapHours' in payload)
                ) {
                  throw new Error('Enter at least one value to update.');
                }

                if (errorEl) errorEl.textContent = '';
                const submitButton = form.querySelector('button[type="submit"]');
                if (submitButton) submitButton.disabled = true;

                const response = await fetch('/api/balances/' + userId + '/set', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                  credentials: 'same-origin'
                });

                if (response.ok) {
                  toggleDialog(false);
                  window.location.reload();
                  return;
                }

                let message = 'Unable to update balances.';
                try {
                  const data = await response.json();
                  if (data && data.message) {
                    message = data.message;
                  }
                } catch (_err) {}
                if (errorEl) errorEl.textContent = message;
                if (submitButton) submitButton.disabled = false;
              } catch (error) {
                if (errorEl) {
                  errorEl.textContent = error instanceof Error ? error.message : 'Unable to update balances.';
                }
                const submitButton = form.querySelector('button[type="submit"]');
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
                              <th>PTO</th>
                              <th>UTO</th>
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
            'Created At',
            'Type',
            'Status',
            'Start Date',
            'End Date',
            'Hours',
            'Reason',
            'Approver Name',
            'Approver Email',
            'Timezone'
        ];
        const rowsCsv = requests.map((request) => [
            escapeCsv(formatCsvDateTime(request.createdAt)),
            escapeCsv(request.type),
            escapeCsv(request.status),
            escapeCsv(formatCsvDate(request.startDate)),
            escapeCsv(formatCsvDate(request.endDate)),
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
        uto: balance?.utoHours ?? 0,
        makeUp: balance?.makeUpHours ?? 0,
        basePto: balance?.basePtoHours ?? 0,
        baseUto: balance?.baseUtoHours ?? 0,
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
        <div class="summary-title">UTO Remaining</div>
        <div class="summary-value">${escapeHtml(formatHours(summary.uto))} h</div>
        <div class="summary-meta">Base ${escapeHtml(formatHours(summary.baseUto))} h</div>
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
            'Clock In',
            'Clock Out',
            'Break Starts',
            'Break Ends',
            'Lunch Starts',
            'Lunch Ends',
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
            escapeCsv(formatCsvDateTime(detail.startedAt)),
            escapeCsv(detail.endedAt ? formatCsvDateTime(detail.endedAt) : ''),
            escapeCsv(formatCsvDateList(detail.breakStartTimes)),
            escapeCsv(formatCsvDateList(detail.breakEndTimes)),
            escapeCsv(formatCsvDateList(detail.lunchStartTimes)),
            escapeCsv(formatCsvDateList(detail.lunchEndTimes)),
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
    const timezoneNote = renderTimezoneNote(dayStart, dayEnd);
    const subtitleParts = [user.email ? escapeHtml(user.email) : null, escapeHtml(dateLabel)]
        .filter((value) => Boolean(value))
        .join(' • ');
    const sessionSubtitle = details.length
        ? `${escapeHtml(dateLabel)} • ${details.length} ${details.length === 1 ? 'session' : 'sessions'} recorded`
        : `${escapeHtml(dateLabel)} • No sessions recorded`;
    const pauseSubtitle = pauseEntries.length
        ? `${pauseEntries.length} ${pauseEntries.length === 1 ? 'pause' : 'pauses'} captured`
        : 'No pauses captured for this date.';
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(user.name)} – ${dateLabel}</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--user-detail">
        ${renderNav('user')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">User timeline</p>
              <h1 class="page-header__title">${escapeHtml(user.name)}</h1>
              <p class="page-header__subtitle">${subtitleParts}</p>
            </div>
            <div class="page-header__meta">
              <a href="/dashboard/today" class="button button-secondary no-print">Back to Today</a>
              ${timezoneNote}
            </div>
          </header>
          <section class="card card--table">
            <div class="card__header">
              <div>
                <h2 class="card__title">Session timeline</h2>
                <p class="card__subtitle">${sessionSubtitle}</p>
              </div>
              <div class="card__actions no-print">
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
            </div>
            <div class="card__body">
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
            </div>
          </section>
          <section class="card card--detail">
            <div class="card__header">
              <div>
                <h2 class="card__title">Breaks and Lunches</h2>
                <p class="card__subtitle">${pauseSubtitle}</p>
              </div>
            </div>
            <div class="card__body">
              ${renderPauseTable(pauseEntries)}
            </div>
          </section>
        </main>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/payroll', async (req, res) => {
    const toOptionalString = (value) => typeof value === 'string' && value.trim().length ? value.trim() : undefined;
    const message = toOptionalString(req.query.message);
    const error = toOptionalString(req.query.error);
    const factsMonthRaw = toOptionalString(req.query.factsMonth);
    const bonusDateRaw = toOptionalString(req.query.bonusDate);
    const employeePrefRaw = toOptionalString(req.query.employeeId);
    const factsMonthKey = factsMonthRaw && /^\d{4}-\d{2}$/.test(factsMonthRaw) ? factsMonthRaw : undefined;
    const now = new Date();
    const defaultMonthParam = (0, date_fns_tz_1.formatInTimeZone)(zonedStartOfMonth(now), DASHBOARD_TIME_ZONE, 'yyyy-MM');
    const selectedFactsMonth = factsMonthKey ?? defaultMonthParam;
    const wizardDefaultPayDate = computeNextPayrollPayDate();
    const parsedWizardPayDate = parseDateInput(wizardDefaultPayDate) ?? zonedStartOfDay(now);
    const bonusDateCandidate = bonusDateRaw ? parseDateInput(bonusDateRaw) : undefined;
    const bonusDateValue = bonusDateCandidate ?? parsedWizardPayDate;
    const bonusDateParam = formatIsoDate(bonusDateValue);
    const employeeIdCandidate = employeePrefRaw && /^\d+$/.test(employeePrefRaw)
        ? Number.parseInt(employeePrefRaw, 10)
        : undefined;
    const baseDataPromise = Promise.all([
        prisma_1.prisma.payrollPeriod.findMany({
            orderBy: { payDate: 'desc' },
            take: 12,
            include: {
                approvedBy: { select: { id: true, name: true } },
                paidBy: { select: { id: true, name: true } },
                _count: { select: { lines: true } }
            }
        }),
        prisma_1.prisma.user.findMany({
            where: { role: 'employee' },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, email: true, active: true }
        }),
        (0, config_1.listEmployeeConfigs)()
    ]);
    const baseData = await baseDataPromise;
    const attendanceData = await (0, attendance_1.listAttendanceFactsForMonth)(selectedFactsMonth);
    const bonusCandidates = await (0, bonuses_1.listBonusesForPayDate)(bonusDateValue);
    const [periods, employees, configSnapshots] = baseData;
    const employeeLookup = new Map(employees.map((employee) => [employee.id, employee]));
    const normalizedEmployeeId = employeeIdCandidate && employeeLookup.has(employeeIdCandidate)
        ? employeeIdCandidate
        : undefined;
    const latestConfigByUser = new Map();
    for (const snapshot of configSnapshots) {
        if (!latestConfigByUser.has(snapshot.userId)) {
            latestConfigByUser.set(snapshot.userId, snapshot);
        }
    }
    const employeesNeedingConfig = employees.filter((employee) => !latestConfigByUser.has(employee.id));
    const selectedConfig = normalizedEmployeeId ? latestConfigByUser.get(normalizedEmployeeId) : undefined;
    const buildStatusMeta = (period) => {
        const parts = [];
        if (period.approvedBy && period.approvedAt) {
            parts.push(`Approved by ${escapeHtml(period.approvedBy.name)} on ${escapeHtml(formatDateTime(period.approvedAt))}`);
        }
        if (period.paidBy && period.paidAt) {
            parts.push(`Paid by ${escapeHtml(period.paidBy.name)} on ${escapeHtml(formatDateTime(period.paidAt))}`);
        }
        return parts.length ? `<div class="meta">${parts.join(' • ')}</div>` : '';
    };
    const periodRows = periods
        .map((period) => {
        const totals = parsePeriodTotals(period.totals);
        const status = normalizePayrollStatus(period.status);
        const payDateIso = formatIsoDate(period.payDate);
        const totalsEntries = [
            { key: 'base', label: 'Base' },
            { key: 'monthlyAttendance', label: 'Monthly' },
            { key: 'monthlyDeferred', label: 'Deferred' },
            { key: 'quarterlyAttendance', label: 'Quarterly' },
            { key: 'kpiBonus', label: 'KPI' },
            { key: 'finalAmount', label: 'Total' }
        ];
        const totalsGrid = totalsEntries
            .map(({ key, label }) => `<div><dt>${escapeHtml(label)}</dt><dd>${formatCurrency(totals[key])}</dd></div>`)
            .join('');
        const linesCount = period._count.lines;
        const linesMeta = `${linesCount} ${linesCount === 1 ? 'line' : 'lines'}`;
        const computedMeta = period.computedAt
            ? `<div class="meta">Computed ${escapeHtml(formatDateTime(period.computedAt))}</div>`
            : '';
        const statusChip = `<span class="${payrollStatusClasses[status]}">${escapeHtml(payrollStatusLabels[status])}</span>`;
        const disableRecalc = status === 'paid' ? ' disabled' : '';
        const disableApprove = status !== 'draft' ? ' disabled' : '';
        const disablePay = status !== 'approved' ? ' disabled' : '';
        const errorTargetId = `period-error-${period.id}`;
        const rowId = `period-row-${period.id}`;
        return `
        <tr id="${rowId}" data-period-row="${payDateIso}">
          <td>
            <strong>${escapeHtml(formatFullDate(period.payDate))}</strong>
            <div class="meta">${escapeHtml(linesMeta)}</div>
            ${computedMeta}
          </td>
          <td>
            ${statusChip}
            ${buildStatusMeta(period)}
          </td>
          <td>
            <dl class="totals-grid">${totalsGrid}</dl>
          </td>
          <td>
            <div class="action-buttons">
              <button
                type="button"
                class="button"
                data-payroll-action
                data-method="POST"
                data-url="/api/payroll/payruns/${payDateIso}/recalc"
                data-success-message="Payroll recalculated."
                data-error-target="${errorTargetId}"
                ${disableRecalc}
              >Recalculate</button>
              <button
                type="button"
                class="button"
                data-payroll-action
                data-method="POST"
                data-url="/api/payroll/payruns/${payDateIso}/approve"
                data-success-message="Payroll approved."
                data-confirm="Approve this payroll period?"
                data-error-target="${errorTargetId}"
                ${disableApprove}
              >Approve</button>
              <button
                type="button"
                class="button button-danger"
                data-payroll-action
                data-method="POST"
                data-url="/api/payroll/payruns/${payDateIso}/pay"
                data-success-message="Payroll marked as paid."
                data-confirm="Mark this payroll period as paid?"
                data-error-target="${errorTargetId}"
                ${disablePay}
              >Mark Paid</button>
              <a
                class="button button-secondary"
                href="/api/payroll/payruns/${payDateIso}/export"
                target="_blank"
                rel="noopener"
              >Export CSV</a>
              <a
                class="button button-secondary"
                href="/dashboard/payroll/summary/${payDateIso}"
              >View Details</a>
            </div>
            <p class="form-error" id="${errorTargetId}" role="alert"></p>
          </td>
        </tr>
      `;
    })
        .join('\n');
    const payrollTable = periods.length
        ? `<div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Pay Date</th>
              <th>Status</th>
              <th>Totals</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${periodRows}
          </tbody>
        </table>
      </div>`
        : '<div class="empty">No payroll periods have been calculated yet.</div>';
    const attendanceFacts = attendanceData?.facts ?? [];
    const attendanceRows = attendanceFacts
        .map((fact) => {
        const employee = employeeLookup.get(fact.userId);
        const reasons = Array.isArray(fact.reasons)
            ? fact.reasons.map((reason) => String(reason)).filter((reason) => reason.trim().length)
            : [];
        const scheduleNotes = reasons.length ? reasons.join('; ') : '—';
        const statusChip = fact.isPerfect
            ? '<span class="status-chip status-chip--approved">Perfect</span>'
            : '<span class="status-chip status-chip--warn">Review</span>';
        return `
        <tr>
          <td>
            ${escapeHtml(employee?.name ?? `User ${fact.userId}`)}
            <div class="meta">${escapeHtml(employee?.email ?? '')}</div>
          </td>
          <td>${formatHours(toNumber(fact.assignedHours))} h</td>
          <td>${formatHours(toNumber(fact.workedHours))} h</td>
          <td>${formatHours(toNumber(fact.ptoHours))} h</td>
          <td>${formatHours(toNumber(fact.utoAbsenceHours))} h</td>
          <td>${formatHours(toNumber(fact.matchedMakeUpHours))} h</td>
          <td>${fact.tardyMinutes}</td>
          <td>${statusChip}</td>
          <td>${escapeHtml(scheduleNotes)}</td>
        </tr>
      `;
    })
        .join('\n');
    const attendanceTable = attendanceFacts.length
        ? `<div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Assigned</th>
              <th>Worked</th>
              <th>PTO</th>
              <th>UTO</th>
              <th>Make-Up</th>
              <th>Tardy (m)</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${attendanceRows}
          </tbody>
        </table>
      </div>`
        : `<div class="empty">No attendance facts computed for ${escapeHtml(selectedFactsMonth)}.</div>`;
    const attendanceRangeNote = attendanceData
        ? renderTimezoneNote(attendanceData.rangeStart, attendanceData.rangeEnd)
        : '';
    const employeeOptions = buildSelectOptions([
        { value: '', label: 'Select employee' },
        ...employees.map((employee) => ({
            value: String(employee.id),
            label: employee.active ? employee.name : `${employee.name} (inactive)`
        }))
    ], normalizedEmployeeId ? String(normalizedEmployeeId) : '');
    const makeNumberValue = (value) => Number.isFinite(value) ? String(value) : '';
    const latestConfigRows = employees.length
        ? employees.map((employee) => {
            const profileUrl = `/dashboard/employees/${employee.id}`;
            const config = latestConfigByUser.get(employee.id);
            if (!config) {
                return `
          <tr class="compensation-row--missing">
            <td>
              <a href="${profileUrl}">${escapeHtml(employee.name)}</a>
              <div class="meta">${escapeHtml(employee.email)}</div>
              <div class="meta"><span class="status-chip status-chip--warn">Needs setup</span></div>
            </td>
            <td><span class="status-chip status-chip--warn">Not configured</span></td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td>
              <div>Not configured</div>
              <div class="meta"><a href="${profileUrl}">Set up compensation</a></div>
            </td>
          </tr>
        `;
            }
            const scheduleSummary = summarizeSchedule(config.schedule);
            const kpiLabel = config.kpiEligible
                ? `Eligible${config.defaultKpiBonus ? ` (${formatCurrency(config.defaultKpiBonus)})` : ''}`
                : 'Not eligible';
            const accrualLabel = `Enabled${config.accrualMethod ? ` – ${escapeHtml(config.accrualMethod)}` : ''}`;
            return `
        <tr>
          <td>
            <a href="${profileUrl}">${escapeHtml(employee.name)}</a>
            <div class="meta">${escapeHtml(employee.email)}</div>
          </td>
          <td>${escapeHtml(formatFullDate(config.effectiveOn))}</td>
          <td>${formatCurrency(config.baseSemiMonthlySalary)}</td>
          <td>${formatCurrency(config.monthlyAttendanceBonus)}</td>
          <td>${formatCurrency(config.quarterlyAttendanceBonus)}</td>
          <td>${escapeHtml(kpiLabel)}</td>
          <td>
            ${escapeHtml(accrualLabel)}
            <div class="meta">PTO ${formatHours(config.ptoBalanceHours)}h • UTO ${formatHours(config.utoBalanceHours)}h</div>
          </td>
          <td>
            ${scheduleSummary}
            <div class="meta"><a href="${profileUrl}">View profile</a></div>
          </td>
        </tr>
      `;
        }).join('\n')
        : '<tr><td colspan="8" class="empty">No employees found.</td></tr>';
    const compensationSubtitle = (() => {
        if (!employeesNeedingConfig.length) {
            return 'Latest effective configuration per employee.';
        }
        const countLabel = employeesNeedingConfig.length === 1 ? 'employee needs setup' : 'employees need setup';
        return `Latest effective configuration per employee. <span class="status-chip status-chip--warn">${employeesNeedingConfig.length} ${countLabel}</span> Use the "Set up compensation" links to finish onboarding.`;
    })();
    const compensationTable = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Effective On</th>
            <th>Base</th>
            <th>Monthly Bonus</th>
            <th>Quarterly Bonus</th>
            <th>KPI</th>
            <th>Accrual</th>
            <th>Schedule</th>
          </tr>
        </thead>
        <tbody>
          ${latestConfigRows}
        </tbody>
      </table>
    </div>
  `;
    const bonusTypeGroup = (type) => bonusTypeLabels[type] ?? type;
    const kpiCandidates = bonusCandidates.filter((candidate) => candidate.type === constants_1.BONUS_TYPE_KPI);
    const otherBonuses = bonusCandidates.filter((candidate) => candidate.type !== constants_1.BONUS_TYPE_KPI);
    const otherBonusRows = otherBonuses.length
        ? otherBonuses
            .map((candidate) => {
            const employee = candidate.user;
            const amount = candidate.finalAmount
                ? Number(candidate.finalAmount)
                : Number(candidate.amount);
            return `
            <tr>
              <td>${escapeHtml(employee?.name ?? `User ${candidate.userId}`)}<div class="meta">${escapeHtml(employee?.email ?? '')}</div></td>
              <td>${escapeHtml(bonusTypeGroup(candidate.type))}</td>
              <td>${formatCurrency(amount)}</td>
              <td><span class="status-chip status-chip--${escapeHtml(candidate.status)}">${escapeHtml(candidate.status)}</span></td>
            </tr>
          `;
        })
            .join('\n')
        : '<tr><td colspan="4" class="empty">No non-KPI bonuses queued for this pay date.</td></tr>';
    const kpiSections = kpiCandidates.length
        ? kpiCandidates
            .map((candidate) => {
            const employee = candidate.user;
            const amountValue = candidate.finalAmount
                ? Number(candidate.finalAmount)
                : Number(candidate.amount ?? 0);
            return `
            <article class="kpi-card" data-kpi-id="${candidate.id}">
              <header class="kpi-card__header">
                <div>
                  <h3>${escapeHtml(employee?.name ?? `User ${candidate.userId}`)}</h3>
                  <p class="meta">${escapeHtml(employee?.email ?? '')}</p>
                </div>
                <span class="status-chip status-chip--${escapeHtml(candidate.status)}">${escapeHtml(candidate.status)}</span>
              </header>
              <form data-async="true" data-kind="kpi-decision" data-success-message="KPI decision saved." data-candidate-id="${candidate.id}">
                <div class="kpi-form-grid">
                  <label>
                    <span>Final Amount</span>
                    <input type="number" name="finalAmount" step="0.01" min="0" value="${makeNumberValue(amountValue)}" />
                  </label>
                  <label>
                    <span>Notes</span>
                    <input type="text" name="notes" maxlength="500" value="${escapeHtml(candidate.notes ?? '')}" />
                  </label>
                </div>
                <input type="hidden" name="status" value="${escapeHtml(candidate.status)}" />
                <div class="kpi-actions">
                  <button type="submit" class="button" data-kpi-status="approved" data-confirm="Approve this KPI bonus?">Approve</button>
                  <button type="submit" class="button button-danger" data-kpi-status="denied" data-confirm="Deny this KPI bonus?">Deny</button>
                </div>
                <p class="form-error" data-error></p>
              </form>
            </article>
          `;
        })
            .join('\n')
        : '<div class="empty">No KPI bonuses pending review for this pay date.</div>';
    const messageAlert = message ? `<div class="alert success">${escapeHtml(message)}</div>` : '';
    const errorAlert = error ? `<div class="alert error">${escapeHtml(error)}</div>` : '';
    const nextPayDateLabel = formatFullDate(parsedWizardPayDate);
    const latestPeriod = periods[0];
    let latestStatusValue = null;
    let latestStatusChip = '<span class="status-chip status-chip--pending">Not Started</span>';
    if (latestPeriod) {
        latestStatusValue = normalizePayrollStatus(latestPeriod.status);
        latestStatusChip = `<span class="${payrollStatusClasses[latestStatusValue]}">${escapeHtml(payrollStatusLabels[latestStatusValue])}</span>`;
    }
    const latestPeriodDateLabel = latestPeriod ? formatFullDate(latestPeriod.payDate) : 'No runs yet';
    const latestLinesLabel = latestPeriod
        ? `${latestPeriod._count.lines} ${latestPeriod._count.lines === 1 ? 'employee line' : 'employee lines'}`
        : 'Run payroll to generate employee lines.';
    const latestComputedLabel = latestPeriod?.computedAt
        ? `Computed ${formatDateTime(latestPeriod.computedAt)}`
        : 'Not computed yet';
    let latestNextStep = 'Use Run Payroll to start your first pay period.';
    if (latestStatusValue === 'draft') {
        latestNextStep = 'Review totals and approve when everything looks good.';
    }
    else if (latestStatusValue === 'approved') {
        latestNextStep = 'Mark the period as paid once deposits are complete.';
    }
    else if (latestStatusValue === 'paid') {
        latestNextStep = 'All set. Prepare for the next pay run when needed.';
    }
    const nextRunStatusLine = latestStatusValue && latestPeriod && latestStatusValue !== 'paid'
        ? `Finish the ${formatFullDate(latestPeriod.payDate)} period before recalculating.`
        : 'Next eligible pay date from your payroll schedule.';
    const nextRunHint = latestStatusValue && latestStatusValue !== 'paid'
        ? 'Complete the current period before calculating the next one.'
        : 'Run the calculation once attendance looks good.';
    const attendanceMonthDate = parseDateInput(`${selectedFactsMonth}-01`);
    const attendanceMonthLabel = attendanceMonthDate
        ? (0, date_fns_tz_1.formatInTimeZone)(attendanceMonthDate, DASHBOARD_TIME_ZONE, 'MMMM yyyy')
        : selectedFactsMonth;
    const perfectCount = attendanceFacts.filter((fact) => fact.isPerfect).length;
    const reviewCount = attendanceFacts.length - perfectCount;
    const attendanceInsight = attendanceFacts.length
        ? `${perfectCount} perfect · ${reviewCount} needs review`
        : 'No attendance facts yet.';
    const attendanceActionHint = attendanceFacts.length
        ? 'Spot-check employees flagged for review before approving payroll.'
        : 'Re-run attendance to refresh supporting hours.';
    const attendanceActionLink = attendanceFacts.length ? '#attendance-facts' : '#attendance-tools';
    const attendanceActionText = attendanceFacts.length ? 'View attendance facts' : 'Open attendance tools';
    const bonusDateLabel = formatFullDate(bonusDateValue);
    const pendingKpiCount = kpiCandidates.filter((candidate) => candidate.status === 'pending').length;
    const decidedKpiCount = kpiCandidates.length - pendingKpiCount;
    const bonusValue = kpiCandidates.length
        ? `${pendingKpiCount}/${kpiCandidates.length} KPI pending`
        : otherBonuses.length
            ? `${otherBonuses.length} automatic bonuses`
            : 'No bonuses yet';
    const bonusSummaryParts = [];
    if (decidedKpiCount > 0) {
        bonusSummaryParts.push(`${decidedKpiCount} KPI decided`);
    }
    if (pendingKpiCount > 0) {
        bonusSummaryParts.push(`${pendingKpiCount} KPI pending`);
    }
    if (otherBonuses.length > 0) {
        bonusSummaryParts.push(`${otherBonuses.length} automatic ready`);
    }
    const bonusInsight = bonusSummaryParts.length ? bonusSummaryParts.join(' • ') : 'Bonuses populate after you run payroll.';
    const bonusActionHint = kpiCandidates.length
        ? 'Confirm KPI decisions so they export with payroll.'
        : otherBonuses.length
            ? 'Automatic attendance bonuses will export with payroll.'
            : 'Run payroll to populate upcoming bonuses.';
    const bonusActionLink = kpiCandidates.length || otherBonuses.length ? '#bonus-review' : '#run-payroll';
    const bonusActionText = kpiCandidates.length || otherBonuses.length ? 'Open bonus review' : 'Go to run payroll';
    const summaryCards = `
    <div class="cards-grid cards-grid--payroll cards-grid--summary">
      <section class="card summary-card summary-card--neutral">
        <p class="summary-title">Next pay run</p>
        <p class="summary-card__value">${escapeHtml(nextPayDateLabel)}</p>
        <div class="summary-card__status"><span>${escapeHtml(nextRunStatusLine)}</span></div>
        <p class="summary-card__meta">${escapeHtml(nextRunHint)}</p>
        <p class="summary-card__meta">${escapeHtml(`Times shown in ${DASHBOARD_TIME_ZONE}.`)}</p>
        <a class="button summary-card__action" href="#run-payroll">Run payroll</a>
      </section>
      <section class="card summary-card summary-card--neutral">
        <p class="summary-title">Latest period</p>
        <p class="summary-card__value">${escapeHtml(latestPeriodDateLabel)}</p>
        <div class="summary-card__status">
          ${latestStatusChip}
          <span>${escapeHtml(latestComputedLabel)}</span>
        </div>
        <p class="summary-card__meta">${escapeHtml(latestLinesLabel)}</p>
        <p class="summary-card__meta">${escapeHtml(latestNextStep)}</p>
        <a class="button button-secondary summary-card__action" href="#payroll-periods">Review pay history</a>
      </section>
      <section class="card summary-card summary-card--neutral">
        <p class="summary-title">Attendance month</p>
        <p class="summary-card__value">${escapeHtml(attendanceMonthLabel)}</p>
        <div class="summary-card__status"><span>${escapeHtml(attendanceInsight)}</span></div>
        <p class="summary-card__meta">${escapeHtml(attendanceActionHint)}</p>
        <a class="button button-secondary summary-card__action" href="${attendanceActionLink}">${escapeHtml(attendanceActionText)}</a>
      </section>
      <section class="card summary-card summary-card--neutral">
        <p class="summary-title">Bonuses for ${escapeHtml(bonusDateLabel)}</p>
        <p class="summary-card__value">${escapeHtml(bonusValue)}</p>
        <p class="summary-card__meta">${escapeHtml(bonusInsight)}</p>
        <p class="summary-card__meta">${escapeHtml(bonusActionHint)}</p>
        <a class="button button-secondary summary-card__action" href="${bonusActionLink}">${escapeHtml(bonusActionText)}</a>
      </section>
    </div>
  `;
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Payroll Dashboard</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--payroll">
        ${renderNav('payroll')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Payroll</p>
              <h1 class="page-header__title">Payroll Operations</h1>
              <p class="page-header__subtitle">Run pay periods, validate supporting data, and manage compensation from a single workspace.</p>
            </div>
            <div class="page-header__meta">
              <span>${periods.length ? `${periods.length} recent ${periods.length === 1 ? 'period' : 'periods'}` : 'No periods yet'}</span>
            </div>
          </header>
          ${messageAlert}
          ${errorAlert}
          ${summaryCards}
          <div class="cards-grid cards-grid--payroll cards-grid--payroll-split">
            <section class="card card--span-quarter" id="run-payroll">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Run Payroll</h2>
                  <p class="card__subtitle">Follow the guided checklist to keep your pay run, attendance, and bonuses aligned.</p>
                </div>
              </div>
              <div class="card__body">
                <ol class="step-list">
                  <li>
                    <strong>1. Calculate pay run</strong>
                    <span>Pick a pay date (15th or end-of-month) to generate or refresh the period.</span>
                    <form data-async="true" data-kind="payroll-run" data-success-message="Payroll recalculation queued." class="stack-form">
                      <label>
                        <span>Pay Date</span>
                        <input type="date" name="payDate" value="${wizardDefaultPayDate}" required />
                      </label>
                      <p class="meta">After success the page refreshes with updated totals.</p>
                      <p class="form-error" data-error></p>
                      <button type="submit">Calculate</button>
                    </form>
                  </li>
                  <li id="attendance-tools">
                    <strong>2. Refresh attendance</strong>
                    <span>Re-run the target month so monthly and quarterly bonuses stay accurate.</span>
                    <form data-async="true" data-kind="attendance-recalc" data-success-message="Attendance recalculation started." class="stack-form">
                      <label>
                        <span>Month</span>
                        <input type="month" name="month" value="${selectedFactsMonth}" required />
                      </label>
                      <p class="form-error" data-error></p>
                      <button type="submit" class="button-secondary">Re-run Attendance</button>
                    </form>
                  </li>
                  <li>
                    <strong>3. Final checks</strong>
                    <span>Verify supporting data before approving or paying the period.</span>
                    <div class="step-actions">
                      <a href="#attendance-facts" class="button button-secondary">Attendance facts</a>
                      <a href="#bonus-review" class="button button-secondary">Bonus review</a>
                    </div>
                  </li>
                </ol>
              </div>
            </section>
            <section class="card card--table card--span-three-quarter" id="payroll-periods">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Payroll Periods</h2>
                  <p class="card__subtitle">Limited to the 12 most recent runs.</p>
                </div>
              </div>
              <div class="card__body">
                ${payrollTable}
              </div>
            </section>
          </div>
          <div class="cards-grid cards-grid--payroll">
            <section class="card card--table" id="attendance-facts">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Attendance Facts</h2>
                  <p class="card__subtitle">Spot-check the selected month before approving payroll.</p>
                </div>
                <div class="card__actions no-print">
                  <form method="get" action="/dashboard/payroll" class="filters">
                    <label>
                      <span>Facts Month</span>
                      <input type="month" name="factsMonth" value="${selectedFactsMonth}" />
                    </label>
                    <input type="hidden" name="bonusDate" value="${bonusDateParam}" />
                    <input type="hidden" name="employeeId" value="${normalizedEmployeeId ? normalizedEmployeeId : ''}" />
                    <button type="submit">Load</button>
                  </form>
                </div>
              </div>
              <div class="card__body">
                ${attendanceRangeNote}
                ${attendanceTable}
              </div>
            </section>
          </div>
          <div class="cards-grid cards-grid--payroll">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Compensation Summary</h2>
                  <p class="card__subtitle">${compensationSubtitle}</p>
                </div>
              </div>
              <div class="card__body">
                ${compensationTable}
              </div>
            </section>
          </div>
          <div class="cards-grid cards-grid--payroll">
            <section class="card card--message">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Update Compensation</h2>
                  <p class="card__subtitle">Manage salaries, schedules, accrual settings, and time-off balances from the employee profile.</p>
                </div>
              </div>
              <div class="card__body">
                <p>Select an employee below and click <strong>View profile</strong> to record a new compensation version or adjust accrual settings.</p>
              </div>
            </section>
          </div>
          <div class="cards-grid cards-grid--payroll">
            <section class="card card--table" id="bonus-review">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Bonus Review</h2>
                  <p class="card__subtitle">Confirm monthly, quarterly, and KPI bonuses before final approval.</p>
                </div>
                <div class="card__actions no-print">
                  <form method="get" action="/dashboard/payroll" class="filters">
                    <label>
                      <span>Pay Date</span>
                      <input type="date" name="bonusDate" value="${bonusDateParam}" />
                    </label>
                    <input type="hidden" name="factsMonth" value="${selectedFactsMonth}" />
                    <input type="hidden" name="employeeId" value="${normalizedEmployeeId ? normalizedEmployeeId : ''}" />
                    <button type="submit">Load</button>
                  </form>
                </div>
              </div>
              <div class="card__body">
                <h3>KPI Bonuses</h3>
                ${kpiSections}
                <h3>Automatic Bonuses</h3>
                <div class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${otherBonusRows}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>
        </main>

        <script>
          (() => {
            const reloadWithBanner = (message, error) => {
              const url = new URL(window.location.href);
              if (message) {
                url.searchParams.set('message', message);
                url.searchParams.delete('error');
              } else if (error) {
                url.searchParams.set('error', error);
                url.searchParams.delete('message');
              } else {
                url.searchParams.delete('message');
                url.searchParams.delete('error');
              }
              window.location.href = url.toString();
            };

            const setError = (target, text) => {
              const el = typeof target === 'string' ? document.getElementById(target) : target;
              if (el) {
                el.textContent = text;
              }
            };

            document.querySelectorAll('[data-payroll-action]').forEach((button) => {
              button.addEventListener('click', async () => {
                if (!(button instanceof HTMLButtonElement)) return;
                if (button.disabled) return;
                const confirmMessage = button.dataset.confirm;
                if (confirmMessage && !window.confirm(confirmMessage)) {
                  return;
                }
                const url = button.dataset.url;
                if (!url) return;
                const method = button.dataset.method || 'POST';
                const errorTarget = button.dataset.errorTarget;
                button.disabled = true;
                setError(errorTarget, '');
                try {
                  const response = await fetch(url, { method, credentials: 'same-origin' });
                  if (!response.ok) {
                    let message = 'Unable to process request.';
                    try {
                      const data = await response.json();
                      if (data && typeof data.error === 'string') message = data.error;
                      else if (data && typeof data.message === 'string') message = data.message;
                    } catch (err) {}
                    throw new Error(message);
                  }
                  reloadWithBanner(button.dataset.successMessage || 'Action completed.');
                } catch (err) {
                  const message = err instanceof Error ? err.message : 'Unable to process request.';
                  setError(errorTarget, message);
                  button.disabled = false;
                }
              });
            });

            const serializeSchedule = (form) => {
              const start = form.querySelector('input[name="scheduleStart"]');
              const end = form.querySelector('input[name="scheduleEnd"]');
              const hours = form.querySelector('input[name="scheduleHours"]');
              const startValue = start instanceof HTMLInputElement && start.value ? start.value : '09:00';
              const endValue = end instanceof HTMLInputElement && end.value ? end.value : '17:00';
              const hoursValue = hours instanceof HTMLInputElement ? Number.parseFloat(hours.value) : 8;
              const schedule = {};
              const checkboxes = form.querySelectorAll('input[name="scheduleDay"]');
              checkboxes.forEach((input) => {
                if (!(input instanceof HTMLInputElement)) return;
                const day = input.dataset.day || input.value;
                if (!day) return;
                schedule[day] = {
                  enabled: input.checked,
                  start: startValue,
                  end: endValue,
                  breakMinutes: 0,
                  expectedHours: Number.isFinite(hoursValue) ? Math.max(0, hoursValue) : 8
                };
              });
              const timeZone = form.getAttribute('data-default-timezone') || '${constants_1.PAYROLL_TIME_ZONE}';
              return { timeZone, days: schedule, version: 2 };
            };

            const asyncForms = document.querySelectorAll('form[data-async="true"]');
            asyncForms.forEach((form) => {
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                const kind = form.getAttribute('data-kind');
                const errorEl = form.querySelector('[data-error]');
                if (errorEl) errorEl.textContent = '';
                const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
                if (submitter?.dataset.confirm && !window.confirm(submitter.dataset.confirm)) {
                  return;
                }
                if (submitter) submitter.disabled = true;
                try {
                  if (kind === 'payroll-run') {
                    const input = form.querySelector('input[name="payDate"]');
                    if (!(input instanceof HTMLInputElement) || !input.value.trim()) {
                      throw new Error('Select a pay date.');
                    }
                    const iso = input.value.trim();
                    const response = await fetch('/api/payroll/payruns/' + encodeURIComponent(iso) + '/recalc', {
                      method: 'POST',
                      credentials: 'same-origin'
                    });
                    if (!response.ok) {
                      let message = 'Unable to queue recalculation.';
                      try {
                        const data = await response.json();
                        if (data && typeof data.error === 'string') message = data.error;
                        else if (data && typeof data.message === 'string') message = data.message;
                      } catch (err) {}
                      throw new Error(message);
                    }
                    reloadWithBanner(form.getAttribute('data-success-message') || 'Payroll recalculated.');
                    return;
                  }

                  if (kind === 'attendance-recalc') {
                    const input = form.querySelector('input[name="month"]');
                    if (!(input instanceof HTMLInputElement) || !input.value.trim()) {
                      throw new Error('Select a month.');
                    }
                    const iso = input.value.trim();
                    const response = await fetch('/api/payroll/attendance/' + encodeURIComponent(iso) + '/recalc', {
                      method: 'POST',
                      credentials: 'same-origin'
                    });
                    if (!response.ok) {
                      let message = 'Unable to queue attendance recalculation.';
                      try {
                        const data = await response.json();
                        if (data && typeof data.error === 'string') message = data.error;
                        else if (data && typeof data.message === 'string') message = data.message;
                      } catch (err) {}
                      throw new Error(message);
                    }
                    reloadWithBanner(form.getAttribute('data-success-message') || 'Attendance recalculation started.');
                    return;
                  }

                  if (kind === 'shift-rebuild') {
                    const response = await fetch('/api/payroll/shifts/rebuild', {
                      method: 'POST',
                      credentials: 'same-origin'
                    });
                    if (!response.ok) {
                      let message = 'Unable to generate shifts.';
                      try {
                        const data = await response.json();
                        if (data && typeof data.error === 'string') message = data.error;
                        else if (data && typeof data.message === 'string') message = data.message;
                      } catch (err) {}
                      throw new Error(message);
                    }
                    let message = form.getAttribute('data-success-message') || 'Upcoming shifts refreshed.';
                    try {
                      const data = await response.json();
                      if (data?.summary && typeof data.summary.created === 'number') {
                        const created = data.summary.created;
                        const skipped = typeof data.summary.skipped === 'number' ? data.summary.skipped : 0;
                        const plural = created === 1 ? '' : 's';
                        message = 'Generated ' + created + ' shift' + plural + ' (' + skipped + ' skipped).';
                      }
                    } catch (err) {}
                    reloadWithBanner(message);
                    return;
                  }

                  if (kind === 'compensation') {
                    const userSelect = form.querySelector('select[name="userId"]');
                    const effective = form.querySelector('input[name="effectiveOn"]');
                    const base = form.querySelector('input[name="baseSemiMonthlySalary"]');
                    const monthly = form.querySelector('input[name="monthlyAttendanceBonus"]');
                    const quarterly = form.querySelector('input[name="quarterlyAttendanceBonus"]');
                    const kpiEligible = form.querySelector('input[name="kpiEligible"]');
                    const defaultKpi = form.querySelector('input[name="defaultKpiBonus"]');
                    const accrualMethodInput = form.querySelector('input[name="accrualMethod"]');

                    if (!(userSelect instanceof HTMLSelectElement) || !userSelect.value) {
                      throw new Error('Select an employee.');
                    }
                    if (!(effective instanceof HTMLInputElement) || !/^\d{4}-\d{2}-\d{2}$/.test(effective.value)) {
                      throw new Error('Effective date is required.');
                    }
                    const toFinite = (
                      input: Element | null,
                      label: string
                    ) => {
                      if (!(input instanceof HTMLInputElement)) {
                        throw new Error(label + ' is required.');
                      }
                      const raw = input.value.trim();
                      if (!raw) {
                        throw new Error(label + ' is required.');
                      }
                      const value = Number.parseFloat(raw);
                      if (!Number.isFinite(value)) {
                        throw new Error(label + ' must be a number.');
                      }
                      return value;
                    };

                    const payload = {
                      userId: Number.parseInt(userSelect.value, 10),
                      effectiveOn: effective.value,
                      baseSemiMonthlySalary: toFinite(base, 'Semi-monthly base'),
                      monthlyAttendanceBonus: toFinite(monthly, 'Monthly bonus'),
                      quarterlyAttendanceBonus: toFinite(quarterly, 'Quarterly bonus'),
                      kpiEligible: kpiEligible instanceof HTMLInputElement ? kpiEligible.checked : false,
                      defaultKpiBonus:
                        defaultKpi instanceof HTMLInputElement && defaultKpi.value.trim()
                          ? Number.parseFloat(defaultKpi.value)
                          : null,
                      schedule: serializeSchedule(form),
                      accrualEnabled: true,
                      accrualMethod:
                        accrualMethodInput instanceof HTMLInputElement && accrualMethodInput.value.trim()
                          ? accrualMethodInput.value.trim()
                          : null
                    };
                    if (!payload.kpiEligible) {
                      payload.defaultKpiBonus = null;
                    }
                    const response = await fetch('/api/payroll/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(payload),
                      credentials: 'same-origin'
                    });
                    if (!response.ok) {
                      let message = 'Unable to save configuration.';
                      try {
                        const data = await response.json();
                        if (data && typeof data.error === 'string') message = data.error;
                        else if (data && typeof data.message === 'string') message = data.message;
                      } catch (err) {}
                      throw new Error(message);
                    }
                    reloadWithBanner(form.getAttribute('data-success-message') || 'Configuration saved.');
                    return;
                  }

                  if (kind === 'kpi-decision') {
                    const id = form.getAttribute('data-candidate-id');
                    if (!id) throw new Error('Invalid KPI candidate.');
                    const statusInput = form.querySelector('input[name="status"]');
                    const finalAmount = form.querySelector('input[name="finalAmount"]');
                    const notes = form.querySelector('input[name="notes"]');
                    let status = statusInput instanceof HTMLInputElement ? statusInput.value : '';
                    if (event.submitter instanceof HTMLButtonElement && event.submitter.dataset.kpiStatus) {
                      status = event.submitter.dataset.kpiStatus;
                    }
                    if (status !== 'approved' && status !== 'denied') {
                      throw new Error('Choose approve or deny.');
                    }
                    const payload = { status };
                    if (finalAmount instanceof HTMLInputElement && finalAmount.value.trim()) {
                      const amount = Number.parseFloat(finalAmount.value);
                      if (!Number.isFinite(amount)) throw new Error('Final amount must be a number.');
                      payload.finalAmount = amount;
                    }
                    if (notes instanceof HTMLInputElement && notes.value.trim()) {
                      payload.notes = notes.value.trim();
                    }
                    const response = await fetch('/api/payroll/kpi/' + id + '/decision', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(payload),
                      credentials: 'same-origin'
                    });
                    if (!response.ok) {
                      let message = 'Unable to update KPI bonus.';
                      try {
                        const data = await response.json();
                        if (data && typeof data.error === 'string') message = data.error;
                        else if (data && typeof data.message === 'string') message = data.message;
                      } catch (err) {}
                      throw new Error(message);
                    }
                    reloadWithBanner(form.getAttribute('data-success-message') || 'KPI decision saved.');
                    return;
                  }

                  throw new Error('Unsupported form submission.');
                } catch (err) {
                  const message = err instanceof Error ? err.message : 'Unable to submit form.';
                  if (errorEl) errorEl.textContent = message;
                } finally {
                  if (submitter) submitter.disabled = false;
                }
              });
            });

          })();
        </script>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
const addEmployeeSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    email: zod_1.z.string().email()
});
const updateEmployeeNameSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200)
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
            const nameValue = escapeAttr(employee.name ?? '');
            return `
            <tr>
              <td>${escapeHtml(employee.name)}</td>
              <td>${escapeHtml(employee.email)}</td>
              <td>${employee.active ? 'Active' : 'Inactive'}</td>
              <td>${formatDateTime(employee.createdAt)}</td>
              <td>
                <form method="post" action="/dashboard/settings/employees/${employee.id}/name" class="inline-form" style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.5rem;">
                  <input type="text" name="name" value="${nameValue}" required maxlength="200" />
                  <button type="submit">Update Name</button>
                </form>
                <form method="post" action="/dashboard/settings/employees/${employee.id}/active" class="inline-form">
                  <input type="hidden" name="active" value="${nextValue}" />
                  <button type="submit">${toggleLabel}</button>
                </form>
                <form method="post" action="/dashboard/settings/employees/${employee.id}/delete" class="inline-form" onsubmit="return confirm('Are you sure you want to DELETE this employee and all their data? You can choose to deactivate instead.');">
                  <button type="submit" class="danger">Delete</button>
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
exports.dashboardRouter.get('/payroll/employees', async (req, res) => {
    const employees = await prisma_1.prisma.user.findMany({
        orderBy: { name: 'asc' },
        include: {
            balance: {
                select: {
                    ptoHours: true,
                    utoHours: true,
                    makeUpHours: true,
                    updatedAt: true
                }
            }
        }
    });
    const wantsCsv = typeof req.query.download === 'string' && req.query.download.toLowerCase() === 'csv';
    if (wantsCsv) {
        const header = [
            'Name',
            'Email',
            'Role',
            'Status',
            'PTO Hours',
            'UTO Hours',
            'Make-Up Hours',
            'Balance Updated',
            'Joined',
            'Profile URL'
        ];
        const rows = employees.map((employee) => {
            const balance = employee.balance;
            const pto = formatHours(Number(balance?.ptoHours ?? 0));
            const uto = formatHours(Number(balance?.utoHours ?? 0));
            const makeUp = formatHours(Number(balance?.makeUpHours ?? 0));
            const balanceUpdated = balance?.updatedAt ? formatCsvDateTime(balance.updatedAt) : '';
            const joined = formatCsvDateTime(employee.createdAt);
            const statusLabel = employee.active ? 'Active' : 'Inactive';
            const profileUrl = `/dashboard/employees/${employee.id}`;
            return [
                escapeCsv(employee.name),
                escapeCsv(employee.email),
                escapeCsv(employee.role ?? ''),
                escapeCsv(statusLabel),
                escapeCsv(pto),
                escapeCsv(uto),
                escapeCsv(makeUp),
                escapeCsv(balanceUpdated),
                escapeCsv(joined),
                escapeCsv(profileUrl)
            ].join(',');
        });
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="employee-profiles.csv"');
        return res.send(csv);
    }
    const totalEmployees = employees.length;
    const activeEmployees = employees.filter((employee) => employee.active).length;
    const tableRows = employees
        .map((employee) => {
        const profileUrl = `/dashboard/employees/${employee.id}`;
        const balance = employee.balance;
        const pto = `${formatHours(Number(balance?.ptoHours ?? 0))} h`;
        const uto = `${formatHours(Number(balance?.utoHours ?? 0))} h`;
        const makeUp = `${formatHours(Number(balance?.makeUpHours ?? 0))} h`;
        const balanceUpdated = balance?.updatedAt ? formatDateTime(balance.updatedAt) : '—';
        const joined = formatDateTime(employee.createdAt);
        const statusLabel = employee.active ? 'Active' : 'Inactive';
        const statusClass = employee.active ? 'status status--approved' : 'status status--warn';
        const searchValue = `${employee.name} ${employee.email} ${employee.role ?? ''}`.toLowerCase();
        return `
        <tr data-employee-row data-search="${escapeAttr(searchValue)}">
          <td><a href="${escapeAttr(profileUrl)}">${escapeHtml(employee.name)}</a></td>
          <td>${escapeHtml(employee.email)}</td>
          <td>${employee.role ? escapeHtml(employee.role) : '—'}</td>
          <td><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
          <td>${escapeHtml(pto)}</td>
          <td>${escapeHtml(uto)}</td>
          <td>${escapeHtml(makeUp)}</td>
          <td>${escapeHtml(balanceUpdated)}</td>
          <td>${escapeHtml(joined)}</td>
          <td class="no-print"><a class="button button-secondary" href="${escapeAttr(profileUrl)}">Open</a></td>
        </tr>
      `;
    })
        .join('\n');
    const tableMarkup = employees.length
        ? `<div class="table-scroll" data-employee-table>
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>PTO</th>
              <th>UTO</th>
              <th>Make-Up</th>
              <th>Balance Updated</th>
              <th>Joined</th>
              <th class="no-print">Profile</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
      <div class="empty hidden" data-employee-empty>No employees match your search.</div>`
        : '<div class="empty">No employees found.</div>';
    const filterScript = employees.length
        ? `
        <script>
          (() => {
            const input = document.querySelector('[data-employee-filter]');
            const rows = Array.from(document.querySelectorAll('[data-employee-row]'));
            const empty = document.querySelector('[data-employee-empty]');
            if (!input || !rows.length || !empty) return;
            const apply = () => {
              const query = input.value.trim().toLowerCase();
              let visible = 0;
              rows.forEach((row) => {
                const haystack = row.dataset.search ?? '';
                const matches = !query || haystack.includes(query);
                row.classList.toggle('hidden', !matches);
                if (matches) {
                  visible += 1;
                }
              });
              empty.classList.toggle('hidden', visible !== 0);
            };
            input.addEventListener('input', apply);
          })();
        </script>
      `
        : '';
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Employee Profiles – Payroll</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--payroll">
        ${renderNav('payroll-employees')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Payroll</p>
              <h1 class="page-header__title">Employee Profiles</h1>
              <p class="page-header__subtitle">Open an employee profile to review attendance, balances, and compensation settings.</p>
            </div>
            <div class="page-header__meta">
              <span>${totalEmployees} ${totalEmployees === 1 ? 'employee' : 'employees'}</span>
              <span>${activeEmployees} active</span>
            </div>
          </header>
          <section class="card card--table">
            <div class="card__header">
              <div>
                <h2 class="card__title">Roster</h2>
                <p class="card__subtitle">Choose an employee to open their detailed profile.</p>
              </div>
              <div class="card__actions no-print">
                <input type="search" placeholder="Search employees" aria-label="Search employees" data-employee-filter />
                <form method="get" action="/dashboard/payroll/employees">
                  <input type="hidden" name="download" value="csv" />
                  <button type="submit">Download CSV</button>
                </form>
                <button type="button" class="print-button" onclick="window.print()">Print</button>
              </div>
            </div>
            <div class="card__body">
              ${tableMarkup}
            </div>
          </section>
        </main>
        ${filterScript}
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/payroll/holidays', async (req, res) => {
    const toOptionalString = (value) => typeof value === 'string' && value.trim().length ? value.trim() : undefined;
    const message = toOptionalString(req.query.message);
    const error = toOptionalString(req.query.error);
    const now = new Date();
    const windowEnd = (0, date_fns_1.addMonths)(now, 12);
    const holidays = await (0, config_1.listHolidays)(now, windowEnd);
    const nextHoliday = holidays[0];
    const upcomingCount = holidays.length;
    const upcomingLabel = upcomingCount === 1 ? 'holiday' : 'holidays';
    const nextHolidayName = nextHoliday ? nextHoliday.name : 'No holiday scheduled';
    const nextHolidayDate = nextHoliday
        ? formatFullDate(nextHoliday.observedOn)
        : 'Add a holiday to populate the calendar.';
    const holidayRows = holidays
        .map((holiday) => {
        const iso = holiday.observedOn.toISOString().slice(0, 10);
        return `
        <tr>
          <td>${escapeHtml(holiday.name)}</td>
          <td>${escapeHtml(formatFullDate(holiday.observedOn))}</td>
          <td>
            <button
              type="button"
              class="button button-danger"
              data-holiday-delete
              data-date="${iso}"
              data-name="${escapeHtml(holiday.name)}"
              data-success-message="Holiday removed."
              data-error-target="holiday-error"
            >Remove</button>
          </td>
        </tr>
      `;
    })
        .join('\n');
    const holidayTable = holidays.length
        ? `<div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${holidayRows}
          </tbody>
        </table>
      </div>`
        : '<div class="empty">No upcoming holidays recorded.</div>';
    const messageAlert = message ? `<div class="alert success">${escapeHtml(message)}</div>` : '';
    const errorAlert = error ? `<div class="alert error">${escapeHtml(error)}</div>` : '';
    const timezoneNote = renderTimezoneNote(now, windowEnd);
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Holiday Calendar – Payroll</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--payroll-holidays">
        ${renderNav('payroll-holidays')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Payroll</p>
              <h1 class="page-header__title">Holiday Calendar</h1>
              <p class="page-header__subtitle">Plan, review, and update company-observed holidays for the next 12 months.</p>
            </div>
            <div class="page-header__meta">
              <span>${upcomingCount ? `${upcomingCount} upcoming ${upcomingLabel}` : 'No holidays scheduled'}</span>
              <a class="button button-secondary" href="/dashboard/payroll">Back to Payroll</a>
            </div>
          </header>
          ${messageAlert}
          ${errorAlert}
          <div class="cards-grid cards-grid--payroll cards-grid--summary">
            <section class="card summary-card summary-card--neutral">
              <p class="summary-title">Next observed holiday</p>
              <p class="summary-card__value">${escapeHtml(nextHolidayName)}</p>
              <div class="summary-card__status"><span>${escapeHtml(nextHolidayDate)}</span></div>
              <p class="summary-card__meta">${escapeHtml(`Tracking ${upcomingCount} ${upcomingLabel} in the upcoming year.`)}</p>
              <a class="button button-secondary summary-card__action" href="/dashboard/payroll">Open payroll operations</a>
            </section>
          </div>
          <div class="cards-grid cards-grid--payroll">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Holiday Calendar</h2>
                  <p class="card__subtitle">Manage observed dates for the next 12 months.</p>
                </div>
              </div>
              <div class="card__body">
                ${timezoneNote}
                ${holidayTable}
                <form data-async="true" data-kind="holiday" data-success-message="Holiday saved." class="stack-form holiday-form">
                  <label>
                    <span>Name</span>
                    <input type="text" name="name" maxlength="200" required />
                  </label>
                  <label>
                    <span>Date</span>
                    <input type="date" name="observedOn" required />
                  </label>
                  <p class="form-error" id="holiday-error" data-error></p>
                  <button type="submit">Save Holiday</button>
                </form>
              </div>
            </section>
          </div>
        </main>

        <script>
          (() => {
            const reloadWithBanner = (message, error) => {
              const url = new URL(window.location.href);
              if (message) {
                url.searchParams.set('message', message);
                url.searchParams.delete('error');
              } else if (error) {
                url.searchParams.set('error', error);
                url.searchParams.delete('message');
              } else {
                url.searchParams.delete('message');
                url.searchParams.delete('error');
              }
              window.location.href = url.toString();
            };

            const setError = (target, text) => {
              const el = typeof target === 'string' ? document.getElementById(target) : target;
              if (el) {
                el.textContent = text;
              }
            };

            document.querySelectorAll('[data-holiday-delete]').forEach((button) => {
              button.addEventListener('click', async () => {
                const date = button.getAttribute('data-date');
                if (!date) return;
                const name = button.getAttribute('data-name') || 'this holiday';
                if (!window.confirm('Remove ' + name + '?')) {
                  return;
                }
                const errorTarget = button.getAttribute('data-error-target');
                setError(errorTarget, '');
                button.setAttribute('disabled', 'true');
                try {
                  const response = await fetch('/api/payroll/holidays/' + date, {
                    method: 'DELETE',
                    credentials: 'same-origin'
                  });
                  if (!response.ok) {
                    let message = 'Unable to delete holiday.';
                    try {
                      const data = await response.json();
                      if (data && typeof data.error === 'string') message = data.error;
                      else if (data && typeof data.message === 'string') message = data.message;
                    } catch (err) {}
                    throw new Error(message);
                  }
                  reloadWithBanner(button.getAttribute('data-success-message') || 'Holiday removed.');
                } catch (err) {
                  const message = err instanceof Error ? err.message : 'Unable to delete holiday.';
                  setError(errorTarget, message);
                  button.removeAttribute('disabled');
                }
              });
            });

            const holidayForm = document.querySelector('form[data-kind="holiday"]');
            if (holidayForm instanceof HTMLFormElement) {
              holidayForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const errorEl = holidayForm.querySelector('[data-error]');
                setError(errorEl, '');
                const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
                if (submitter) submitter.disabled = true;
                try {
                  const nameInput = holidayForm.querySelector('input[name="name"]');
                  const dateInput = holidayForm.querySelector('input[name="observedOn"]');
                  if (!(nameInput instanceof HTMLInputElement) || !nameInput.value.trim()) {
                    throw new Error('Name is required.');
                  }
                  if (!(dateInput instanceof HTMLInputElement) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(dateInput.value)) {
                    throw new Error('Date is required.');
                  }
                  const response = await fetch('/api/payroll/holidays', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: nameInput.value.trim(), observedOn: dateInput.value }),
                    credentials: 'same-origin'
                  });
                  if (!response.ok) {
                    let message = 'Unable to save holiday.';
                    try {
                      const data = await response.json();
                      if (data && typeof data.error === 'string') message = data.error;
                      else if (data && typeof data.message === 'string') message = data.message;
                    } catch (err) {}
                    throw new Error(message);
                  }
                  reloadWithBanner(holidayForm.getAttribute('data-success-message') || 'Holiday saved.');
                } catch (err) {
                  const message = err instanceof Error ? err.message : 'Unable to save holiday.';
                  setError(errorEl, message);
                  if (submitter) submitter.disabled = false;
                }
              });
            }
          })();
        </script>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/payroll/summary/:payDate', async (req, res) => {
    const payDateParam = typeof req.params.payDate === 'string' ? req.params.payDate : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDateParam)) {
        res.status(404).type('html').send('<!doctype html><html><body>Payroll period not found.</body></html>');
        return;
    }
    const parsedPayDate = parseDateInput(payDateParam);
    if (!parsedPayDate) {
        res.status(404).type('html').send('<!doctype html><html><body>Payroll period not found.</body></html>');
        return;
    }
    const { payDate: normalizedPayDate, periodStart, periodEnd } = computePayPeriodWindow(parsedPayDate);
    const period = await (0, payroll_1.getPayrollPeriod)(normalizedPayDate);
    if (!period) {
        const payDateLabel = formatFullDate(normalizedPayDate);
        const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Payroll Summary – ${escapeHtml(payDateLabel)}</title>
          <style>${baseStyles}</style>
        </head>
        <body class="dashboard dashboard--payroll-summary">
          ${renderNav('payroll')}
          <main class="page-shell">
            <header class="page-header">
              <div class="page-header__content">
                <p class="page-header__eyebrow">Payroll</p>
                <h1 class="page-header__title">Payroll Summary</h1>
                <p class="page-header__subtitle">No payroll data is available for this pay date.</p>
              </div>
              <div class="page-header__meta">
                <a class="button button-secondary" href="/dashboard/payroll">Back to Payroll</a>
              </div>
            </header>
            <section class="card">
              <div class="card__body">
                <div class="empty empty--error">No payroll period was found for ${escapeHtml(payDateLabel)}.</div>
              </div>
            </section>
          </main>
        </body>
      </html>
    `;
        res.status(404).type('html').send(html);
        return;
    }
    const lines = Array.isArray(period.lines) ? period.lines : [];
    const sortedLines = lines
        .slice()
        .sort((a, b) => (a.user?.name ?? `User ${a.userId}`).localeCompare(b.user?.name ?? `User ${b.userId}`));
    const summarizeBehavior = (summary) => {
        const aggregate = {
            lunchCount: 0,
            lunchMinutes: 0,
            breakCount: 0,
            breakMinutes: 0,
            idleMinutes: 0,
            idleDays: 0,
            averageLunch: null,
            averageBreak: null,
            averageIdle: null
        };
        if (!summary)
            return aggregate;
        for (const detail of summary.details) {
            if (detail.lunchCount > 0) {
                aggregate.lunchCount += detail.lunchCount;
                aggregate.lunchMinutes += detail.lunchMinutes;
            }
            if (detail.breakCount > 0) {
                aggregate.breakCount += detail.breakCount;
                aggregate.breakMinutes += detail.breakMinutes;
            }
            aggregate.idleMinutes += detail.idleMinutes;
            if (detail.expectedHours > 0 || detail.workedHours > 0 || detail.ptoHours > 0) {
                aggregate.idleDays += 1;
            }
        }
        aggregate.averageLunch = aggregate.lunchCount > 0
            ? Math.round((aggregate.lunchMinutes / aggregate.lunchCount) * 10) / 10
            : null;
        aggregate.averageBreak = aggregate.breakCount > 0
            ? Math.round((aggregate.breakMinutes / aggregate.breakCount) * 10) / 10
            : null;
        aggregate.averageIdle = aggregate.idleDays > 0
            ? Math.round((aggregate.idleMinutes / aggregate.idleDays) * 10) / 10
            : null;
        return aggregate;
    };
    const employeeSummaries = await Promise.all(sortedLines.map(async (line) => {
        const attendanceSummary = await collectAttendanceSummary(line.userId, periodStart, periodEnd);
        const totals = attendanceSummary.totals;
        const behavior = summarizeBehavior(attendanceSummary);
        const totalHoursRaw = totals.workedHours + totals.ptoHours + totals.utoHours + totals.makeUpHours;
        const totalHours = Math.round(totalHoursRaw * 100) / 100;
        const payLine = {
            baseAmount: Math.round(Number(line.baseAmount) * 100) / 100,
            monthlyAttendance: Math.round(Number(line.monthlyAttendance) * 100) / 100,
            monthlyDeferred: Math.round(Number(line.monthlyDeferred) * 100) / 100,
            quarterlyAttendance: Math.round(Number(line.quarterlyAttendance) * 100) / 100,
            kpiBonus: Math.round(Number(line.kpiBonus) * 100) / 100,
            finalAmount: Math.round(Number(line.finalAmount) * 100) / 100
        };
        const attendanceBonus = Math.round((payLine.monthlyAttendance + payLine.monthlyDeferred + payLine.quarterlyAttendance) * 100) / 100;
        const onTimePercent = totals.scheduledDays
            ? Math.round(((totals.onTimeDays / totals.scheduledDays) * 100) * 10) / 10
            : null;
        return {
            userId: line.userId,
            name: line.user?.name ?? `User ${line.userId}`,
            email: line.user?.email ?? '',
            totals: {
                workedHours: Math.round(totals.workedHours * 100) / 100,
                ptoHours: Math.round(totals.ptoHours * 100) / 100,
                utoHours: Math.round(totals.utoHours * 100) / 100,
                makeUpHours: Math.round(totals.makeUpHours * 100) / 100,
                tardyMinutes: totals.tardyMinutes,
                tardyEvents: totals.tardyEvents,
                scheduledDays: totals.scheduledDays,
                onTimeDays: totals.onTimeDays
            },
            totalHours,
            onTimePercent,
            behavior,
            payLine,
            attendanceBonus
        };
    }));
    const periodTotals = parsePeriodTotals(period.totals);
    const attendanceBonusTotal = periodTotals.monthlyAttendance + periodTotals.monthlyDeferred + periodTotals.quarterlyAttendance;
    const teamTotalHours = employeeSummaries.reduce((acc, entry) => acc + entry.totalHours, 0);
    const teamAttendanceTotals = employeeSummaries.reduce((acc, entry) => ({
        scheduledDays: acc.scheduledDays + entry.totals.scheduledDays,
        onTimeDays: acc.onTimeDays + entry.totals.onTimeDays,
        tardyMinutes: acc.tardyMinutes + entry.totals.tardyMinutes,
        tardyEvents: acc.tardyEvents + entry.totals.tardyEvents
    }), { scheduledDays: 0, onTimeDays: 0, tardyMinutes: 0, tardyEvents: 0 });
    const teamBehaviorTotals = employeeSummaries.reduce((acc, entry) => ({
        lunchMinutes: acc.lunchMinutes + entry.behavior.lunchMinutes,
        lunchCount: acc.lunchCount + entry.behavior.lunchCount,
        breakMinutes: acc.breakMinutes + entry.behavior.breakMinutes,
        breakCount: acc.breakCount + entry.behavior.breakCount,
        idleMinutes: acc.idleMinutes + entry.behavior.idleMinutes,
        idleDays: acc.idleDays + entry.behavior.idleDays
    }), { lunchMinutes: 0, lunchCount: 0, breakMinutes: 0, breakCount: 0, idleMinutes: 0, idleDays: 0 });
    const teamOnTimePercent = teamAttendanceTotals.scheduledDays
        ? (teamAttendanceTotals.onTimeDays / teamAttendanceTotals.scheduledDays) * 100
        : null;
    const teamAverageTardy = teamAttendanceTotals.tardyEvents
        ? teamAttendanceTotals.tardyMinutes / teamAttendanceTotals.tardyEvents
        : null;
    const teamAverageLunch = teamBehaviorTotals.lunchCount
        ? teamBehaviorTotals.lunchMinutes / teamBehaviorTotals.lunchCount
        : null;
    const teamAverageBreak = teamBehaviorTotals.breakCount
        ? teamBehaviorTotals.breakMinutes / teamBehaviorTotals.breakCount
        : null;
    const teamAverageIdle = teamBehaviorTotals.idleDays
        ? teamBehaviorTotals.idleMinutes / teamBehaviorTotals.idleDays
        : null;
    const hasSummaries = employeeSummaries.length > 0;
    const noSummariesMessage = 'No payroll lines have been computed for this period.';
    const formatPercent = (value) => {
        if (value === null || !Number.isFinite(value))
            return '—';
        const rounded = Math.round(value * 10) / 10;
        return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
    };
    const formatHoursCell = (value) => (value ? `${formatHours(value)} h` : '—');
    const formatAverageMinutes = (value) => {
        if (value === null || !Number.isFinite(value)) {
            return '—';
        }
        const rounded = Math.round(value * 10) / 10;
        return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} min`;
    };
    const employeeRows = employeeSummaries
        .map((employee) => {
        const detailUrl = `/dashboard/payroll/period/${formatIsoDate(normalizedPayDate)}?employeeId=${employee.userId}`;
        const tardyLabel = employee.totals.tardyMinutes
            ? `${employee.totals.tardyMinutes} min`
            : '—';
        const compensationParts = [
            `Base ${formatCurrency(employee.payLine.baseAmount)}`,
            `Attendance ${formatCurrency(employee.attendanceBonus)}`
        ];
        if (employee.payLine.kpiBonus) {
            compensationParts.push(`KPI ${formatCurrency(employee.payLine.kpiBonus)}`);
        }
        const compensationSummary = `${compensationParts.join(' + ')} = ${formatCurrency(employee.payLine.finalAmount)}`;
        return `
        <tr>
          <td>
            <a href="${escapeHtml(detailUrl)}">${escapeHtml(employee.name)}</a>
            ${employee.email ? `<div class="meta">${escapeHtml(employee.email)}</div>` : ''}
          </td>
          <td>${formatHoursCell(Math.round(employee.totalHours * 100) / 100)}</td>
          <td>${formatHoursCell(employee.totals.ptoHours)}</td>
          <td>${formatHoursCell(employee.totals.utoHours)}</td>
          <td>${formatHoursCell(employee.totals.makeUpHours)}</td>
          <td>${tardyLabel}</td>
          <td>${escapeHtml(formatPercent(employee.onTimePercent))}</td>
          <td>${escapeHtml(formatAverageMinutes(employee.behavior.averageLunch))}</td>
          <td>${escapeHtml(formatAverageMinutes(employee.behavior.averageBreak))}</td>
          <td>${escapeHtml(formatAverageMinutes(employee.behavior.averageIdle))}</td>
          <td>${escapeHtml(compensationSummary)}</td>
        </tr>
      `;
    })
        .join('\n');
    const employeeTable = employeeSummaries.length
        ? `<div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Total Hours</th>
              <th>PTO Hours</th>
              <th>UTO Hours</th>
              <th>Make-up Hours</th>
              <th>Tardy (m)</th>
              <th>On-time %</th>
              <th>Avg Lunch</th>
              <th>Avg Break</th>
              <th>Avg Idle</th>
              <th>Compensation</th>
            </tr>
          </thead>
          <tbody>
            ${employeeRows}
          </tbody>
        </table>
      </div>`
        : '';
    const employeeEmptyState = hasSummaries
        ? ''
        : `<div class="empty" data-summary-empty>${escapeHtml(noSummariesMessage)}</div>`;
    const teamHoursLabel = `${formatHours(Math.round(teamTotalHours * 100) / 100)} h`;
    const teamTotalsTable = `
    <table class="totals-table">
      <tbody>
        <tr><th scope="row">Gross</th><td>${formatCurrency(periodTotals.finalAmount)}</td></tr>
        <tr><th scope="row">Base</th><td>${formatCurrency(periodTotals.base)}</td></tr>
        <tr><th scope="row">Attendance Bonus</th><td>${formatCurrency(attendanceBonusTotal)}</td></tr>
        <tr><th scope="row">KPI Bonus</th><td>${formatCurrency(periodTotals.kpiBonus)}</td></tr>
      </tbody>
    </table>
  `;
    const teamTotalsEmptyState = hasSummaries
        ? ''
        : `<div class="empty" data-totals-empty>${escapeHtml(noSummariesMessage)}</div>`;
    const teamTotalsContent = hasSummaries
        ? `<div data-totals-content hidden>
        ${teamTotalsTable}
        <p class="meta">Team logged ${escapeHtml(teamHoursLabel)} total hours.</p>
      </div>`
        : '';
    const teamMetricsCards = hasSummaries
        ? (() => {
            const onTimeMeta = teamAttendanceTotals.scheduledDays
                ? `${teamAttendanceTotals.onTimeDays} of ${teamAttendanceTotals.scheduledDays} days on time`
                : 'No scheduled days recorded';
            const tardyMeta = teamAttendanceTotals.tardyEvents
                ? `${teamAttendanceTotals.tardyEvents} tardy ${teamAttendanceTotals.tardyEvents === 1 ? 'event' : 'events'}`
                : 'No tardy events recorded';
            const lunchMeta = teamBehaviorTotals.lunchCount
                ? `${teamBehaviorTotals.lunchCount} lunches tracked`
                : 'No lunches tracked';
            const breakMeta = teamBehaviorTotals.breakCount
                ? `${teamBehaviorTotals.breakCount} breaks tracked`
                : 'No breaks tracked';
            const idleMeta = teamBehaviorTotals.idleDays
                ? `${teamBehaviorTotals.idleDays} working ${teamBehaviorTotals.idleDays === 1 ? 'day' : 'days'}`
                : 'No idle time tracked';
            return `
          <div class="summary-cards">
            <div class="summary-card">
              <div class="summary-title">On-Time %</div>
              <div class="summary-value">${escapeHtml(formatPercent(teamOnTimePercent))}</div>
              <div class="summary-meta">${escapeHtml(onTimeMeta)}</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Avg Tardy</div>
              <div class="summary-value">${escapeHtml(formatAverageMinutes(teamAverageTardy))}</div>
              <div class="summary-meta">${escapeHtml(tardyMeta)}</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Avg Lunch</div>
              <div class="summary-value">${escapeHtml(formatAverageMinutes(teamAverageLunch))}</div>
              <div class="summary-meta">${escapeHtml(lunchMeta)}</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Avg Break</div>
              <div class="summary-value">${escapeHtml(formatAverageMinutes(teamAverageBreak))}</div>
              <div class="summary-meta">${escapeHtml(breakMeta)}</div>
            </div>
            <div class="summary-card">
              <div class="summary-title">Avg Idle</div>
              <div class="summary-value">${escapeHtml(formatAverageMinutes(teamAverageIdle))}</div>
              <div class="summary-meta">${escapeHtml(idleMeta)}</div>
            </div>
          </div>
        `;
        })()
        : '';
    const teamMetricsEmptyState = hasSummaries
        ? ''
        : `<div class="empty" data-metrics-empty>${escapeHtml('Team metrics are unavailable without payroll lines.')}</div>`;
    const payDateLabel = formatFullDate(normalizedPayDate);
    const periodRangeLabel = `${formatFullDate(periodStart)} – ${formatFullDate(periodEnd)}`;
    const statusValue = normalizePayrollStatus(period.status);
    const statusChip = `<span class="${payrollStatusClasses[statusValue]}">${escapeHtml(payrollStatusLabels[statusValue])}</span>`;
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Payroll Summary – ${escapeHtml(payDateLabel)}</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--payroll-summary">
        ${renderNav('payroll')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Payroll</p>
              <h1 class="page-header__title">Payroll Summary</h1>
              <p class="page-header__subtitle">Team snapshot for ${escapeHtml(payDateLabel)}.</p>
            </div>
            <div class="page-header__meta">
              ${statusChip}
              <span>${escapeHtml(periodRangeLabel)}</span>
              <a class="button button-secondary" href="/dashboard/payroll">Back to Payroll</a>
            </div>
          </header>
          <div class="cards-grid cards-grid--summary">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Team Totals</h2>
                  <p class="card__subtitle">Compensation mix and coverage for the selected pay period.</p>
                </div>
              </div>
              <div class="card__body">
                <div data-totals-loading class="empty">Loading team totals…</div>
                <div data-totals-error class="empty empty--error" hidden>Unable to load team totals.</div>
                ${teamTotalsEmptyState}
                ${teamTotalsContent}
              </div>
            </section>
            <section class="card">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Team Metrics</h2>
                  <p class="card__subtitle">Punctuality and behavior insights for the pay period.</p>
                </div>
              </div>
              <div class="card__body">
                <div data-metrics-loading class="empty">Loading team metrics…</div>
                <div data-metrics-error class="empty empty--error" hidden>Unable to load team metrics.</div>
                ${teamMetricsEmptyState}
                ${hasSummaries ? `<div data-metrics-content hidden>${teamMetricsCards}</div>` : ''}
              </div>
            </section>
          </div>
          <div class="cards-grid">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Employee Breakdown</h2>
                  <p class="card__subtitle">Hours, adherence, and payout summary per employee.</p>
                </div>
              </div>
              <div class="card__body">
                <div data-summary-loading class="empty">Loading payroll summary…</div>
                <div data-summary-error class="empty empty--error" hidden>Unable to load payroll summary.</div>
                ${employeeEmptyState}
                ${employeeSummaries.length ? `<div data-summary-content hidden>${employeeTable}</div>` : ''}
                <noscript>${employeeSummaries.length ? employeeTable : '<div class="empty">No payroll lines have been computed for this period.</div>'}</noscript>
              </div>
            </section>
          </div>
        </main>
        <script>
          (() => {
            const reveal = (key) => {
              const loading = document.querySelector('[data-' + key + '-loading]');
              const content = document.querySelector('[data-' + key + '-content]');
              if (loading) {
                loading.setAttribute('hidden', 'true');
              }
              if (content) {
                content.removeAttribute('hidden');
              }
            };
            ['summary', 'totals', 'metrics'].forEach(reveal);
          })();
        </script>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get(['/payroll/period/:payDate', '/payroll/period/:payDate/employee/:employeeId'], async (req, res) => {
    const payDateParam = typeof req.params.payDate === 'string' ? req.params.payDate : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDateParam)) {
        res.status(404).type('html').send('<!doctype html><html><body>Payroll period not found.</body></html>');
        return;
    }
    const parsedPayDate = parseDateInput(payDateParam);
    if (!parsedPayDate) {
        res.status(404).type('html').send('<!doctype html><html><body>Payroll period not found.</body></html>');
        return;
    }
    const { payDate: normalizedPayDate, periodStart, periodEnd } = computePayPeriodWindow(parsedPayDate);
    const period = await (0, payroll_1.getPayrollPeriod)(normalizedPayDate);
    const periods = await prisma_1.prisma.payrollPeriod.findMany({
        orderBy: { payDate: 'desc' },
        take: 12
    });
    const periodOptions = periods.length
        ? buildSelectOptions(periods.map((entry) => {
            const status = normalizePayrollStatus(entry.status);
            const label = `${formatFullDate(entry.payDate)} (${payrollStatusLabels[status]})`;
            return { value: formatIsoDate(entry.payDate), label };
        }), formatIsoDate(normalizedPayDate))
        : '';
    if (!period) {
        const payDateLabel = formatFullDate(normalizedPayDate);
        const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Payroll Period – ${escapeHtml(payDateLabel)}</title>
          <style>${baseStyles}</style>
        </head>
        <body class="dashboard dashboard--payroll-detail">
          ${renderNav('payroll')}
          <main class="page-shell">
            <header class="detail-header">
              <div class="detail-identity">
                <a class="button button-secondary detail-back" href="/dashboard/payroll">Back to Payroll</a>
                <div class="detail-avatar">?</div>
                <div class="detail-identity-text">
                  <h1>${escapeHtml(payDateLabel)}</h1>
                  <p>No payroll run is available for this pay date yet.</p>
                </div>
              </div>
              <div class="detail-meta">
                <span>${escapeHtml(formatFullDate(periodStart))} – ${escapeHtml(formatFullDate(periodEnd))}</span>
              </div>
            </header>
            <div class="card">
              <div class="card__body">
                <div class="empty">No payroll period was found for ${escapeHtml(payDateLabel)}.</div>
              </div>
            </div>
          </main>
        </body>
      </html>
    `;
        res.status(404).type('html').send(html);
        return;
    }
    const lines = period.lines ?? [];
    const employeeQueryParam = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const employeePathParam = typeof req.params.employeeId === 'string' ? req.params.employeeId : undefined;
    const employeeIdParam = employeeQueryParam && employeeQueryParam.trim().length
        ? employeeQueryParam
        : employeePathParam;
    const employeeIdCandidate = employeeIdParam && /^\d+$/.test(employeeIdParam)
        ? Number.parseInt(employeeIdParam, 10)
        : undefined;
    const sortedLines = lines
        .slice()
        .sort((a, b) => (a.user?.name ?? `User ${a.userId}`).localeCompare(b.user?.name ?? `User ${b.userId}`));
    const selectedLine = sortedLines.find((line) => line.userId === employeeIdCandidate) ?? sortedLines[0] ?? null;
    const selectedEmployeeId = selectedLine?.userId ?? null;
    const employeeRecord = selectedEmployeeId
        ? await prisma_1.prisma.user.findUnique({
            where: { id: selectedEmployeeId },
            select: { id: true, name: true, email: true, role: true }
        })
        : null;
    const attendanceSummary = selectedEmployeeId
        ? await collectAttendanceSummary(selectedEmployeeId, periodStart, periodEnd)
        : null;
    const totals = attendanceSummary?.totals ?? {
        workedHours: 0,
        ptoHours: 0,
        utoHours: 0,
        makeUpHours: 0,
        tardyMinutes: 0,
        tardyEvents: 0,
        scheduledDays: 0,
        onTimeDays: 0,
        absenceDays: 0
    };
    const previousPayDate = computePreviousPayDate(normalizedPayDate);
    const previousWindow = computePayPeriodWindow(previousPayDate);
    const previousSummary = selectedEmployeeId
        ? await collectAttendanceSummary(selectedEmployeeId, previousWindow.periodStart, previousWindow.periodEnd)
        : null;
    const onTimePercentage = totals.scheduledDays > 0 ? (totals.onTimeDays / totals.scheduledDays) * 100 : null;
    const previousOnTimePercentage = previousSummary && previousSummary.totals.scheduledDays > 0
        ? (previousSummary.totals.onTimeDays / previousSummary.totals.scheduledDays) * 100
        : null;
    const detailList = attendanceSummary?.details ?? [];
    const summarizeBehavior = (summary) => {
        const aggregate = {
            averageLunch: null,
            lunchCount: 0,
            lunchMinutes: 0,
            averageBreak: null,
            breakCount: 0,
            breakMinutes: 0,
            averageIdle: null,
            idleMinutes: 0,
            idleDays: 0
        };
        if (!summary) {
            return aggregate;
        }
        for (const detail of summary.details) {
            if (detail.lunchCount > 0) {
                aggregate.lunchCount += detail.lunchCount;
                aggregate.lunchMinutes += detail.lunchMinutes;
            }
            if (detail.breakCount > 0) {
                aggregate.breakCount += detail.breakCount;
                aggregate.breakMinutes += detail.breakMinutes;
            }
            aggregate.idleMinutes += detail.idleMinutes;
            if (detail.expectedHours > 0 || detail.workedHours > 0 || detail.ptoHours > 0) {
                aggregate.idleDays += 1;
            }
        }
        aggregate.averageLunch = aggregate.lunchCount > 0
            ? Math.round((aggregate.lunchMinutes / aggregate.lunchCount) * 10) / 10
            : null;
        aggregate.averageBreak = aggregate.breakCount > 0
            ? Math.round((aggregate.breakMinutes / aggregate.breakCount) * 10) / 10
            : null;
        aggregate.averageIdle = aggregate.idleDays > 0
            ? Math.round((aggregate.idleMinutes / aggregate.idleDays) * 10) / 10
            : null;
        return aggregate;
    };
    const currentBehavior = summarizeBehavior(attendanceSummary);
    const previousBehavior = summarizeBehavior(previousSummary);
    const formatPercent = (value) => {
        if (value === null || !Number.isFinite(value))
            return '—';
        const rounded = Math.round(value * 10) / 10;
        return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
    };
    const formatHoursDisplay = (value) => `${formatHours(Math.round(value * 100) / 100)} h`;
    const formatAverageMinutes = (value) => {
        if (value === null || !Number.isFinite(value)) {
            return '—';
        }
        const rounded = Math.round(value * 10) / 10;
        return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} min`;
    };
    const payLine = selectedLine
        ? {
            baseAmount: Math.round(Number(selectedLine.baseAmount) * 100) / 100,
            monthlyAttendance: Math.round(Number(selectedLine.monthlyAttendance) * 100) / 100,
            monthlyDeferred: Math.round(Number(selectedLine.monthlyDeferred) * 100) / 100,
            quarterlyAttendance: Math.round(Number(selectedLine.quarterlyAttendance) * 100) / 100,
            kpiBonus: Math.round(Number(selectedLine.kpiBonus) * 100) / 100,
            finalAmount: Math.round(Number(selectedLine.finalAmount) * 100) / 100
        }
        : null;
    const payComponents = payLine
        ? [
            { label: 'Base Earnings', amount: payLine.baseAmount },
            { label: 'Monthly Attendance Bonus', amount: payLine.monthlyAttendance },
            { label: 'Deferred Monthly Bonus', amount: payLine.monthlyDeferred },
            { label: 'Quarterly Attendance Bonus', amount: payLine.quarterlyAttendance },
            { label: 'KPI Bonus', amount: payLine.kpiBonus }
        ]
        : [];
    const payComponentTotal = payComponents.reduce((acc, item) => acc + item.amount, 0);
    const finalAmount = payLine?.finalAmount ?? 0;
    const reconciliationDelta = Math.round((payComponentTotal - finalAmount) * 100) / 100;
    const employeeName = employeeRecord?.name ?? selectedLine?.user?.name ?? (selectedEmployeeId ? `User ${selectedEmployeeId}` : 'Select an employee');
    const employeeEmail = employeeRecord?.email ?? selectedLine?.user?.email ?? '';
    const employeeRoleLabel = employeeRecord?.role
        ? `${employeeRecord.role.charAt(0).toUpperCase()}${employeeRecord.role.slice(1)}`
        : 'Employee';
    const employeeInitials = (employeeName
        .split(/\s+/)
        .map((part) => part.charAt(0))
        .filter(Boolean)
        .join('')
        .slice(0, 2)
        .toUpperCase() || '?');
    const statusValue = normalizePayrollStatus(period.status);
    const statusChip = `<span class="${payrollStatusClasses[statusValue]}">${escapeHtml(payrollStatusLabels[statusValue])}</span>`;
    const payDateLabel = formatFullDate(normalizedPayDate);
    const periodRangeLabel = `${formatFullDate(periodStart)} – ${formatFullDate(periodEnd)}`;
    const computedLabel = period.computedAt ? `Computed ${escapeHtml(formatDateTime(period.computedAt))}` : 'Not computed yet';
    const kpiCards = [
        {
            label: 'PTO Hours',
            value: totals.ptoHours ? formatHoursDisplay(totals.ptoHours) : '—',
            meta: totals.ptoHours ? 'Approved PTO this period' : 'No PTO recorded'
        },
        {
            label: 'UTO Hours',
            value: totals.utoHours ? formatHoursDisplay(totals.utoHours) : '—',
            meta: totals.utoHours ? 'Approved non-PTO time' : 'No non-PTO time recorded'
        },
        {
            label: 'Make-up Hours',
            value: totals.makeUpHours ? formatHoursDisplay(totals.makeUpHours) : '—',
            meta: totals.makeUpHours ? 'Matched within period' : 'No make-up time applied'
        },
        {
            label: 'Tardiness Minutes',
            value: `${totals.tardyMinutes} min`,
            meta: totals.tardyEvents ? `${totals.tardyEvents} event${totals.tardyEvents === 1 ? '' : 's'}` : 'On time throughout'
        },
        {
            label: 'On-Time Attendance',
            value: formatPercent(onTimePercentage),
            meta: totals.scheduledDays
                ? `${totals.onTimeDays} of ${totals.scheduledDays} scheduled day${totals.scheduledDays === 1 ? '' : 's'}`
                : 'No scheduled days'
        },
        {
            label: 'Avg Lunch Duration',
            value: currentBehavior.averageLunch !== null ? formatAverageMinutes(currentBehavior.averageLunch) : '—',
            meta: currentBehavior.lunchCount
                ? `${currentBehavior.lunchCount} lunch${currentBehavior.lunchCount === 1 ? '' : 'es'} · ${currentBehavior.lunchMinutes} min total`
                : 'No lunches recorded',
            placeholder: currentBehavior.averageLunch === null
        },
        {
            label: 'Avg Break Duration',
            value: currentBehavior.averageBreak !== null ? formatAverageMinutes(currentBehavior.averageBreak) : '—',
            meta: currentBehavior.breakCount
                ? `${currentBehavior.breakCount} break${currentBehavior.breakCount === 1 ? '' : 's'} · ${currentBehavior.breakMinutes} min total`
                : 'No breaks recorded',
            placeholder: currentBehavior.averageBreak === null
        },
        {
            label: 'Avg Idle Minutes',
            value: currentBehavior.averageIdle !== null ? formatAverageMinutes(currentBehavior.averageIdle) : '—',
            meta: currentBehavior.idleMinutes > 0
                ? `${currentBehavior.idleMinutes} min across ${currentBehavior.idleDays} day${currentBehavior.idleDays === 1 ? '' : 's'}`
                : 'No idle time recorded',
            placeholder: currentBehavior.averageIdle === null
        }
    ]
        .map((card) => {
        const meta = card.meta ? `<span>${escapeHtml(card.meta)}</span>` : '';
        const value = card.placeholder ? `<strong class="detail-kpi-placeholder">${escapeHtml(card.value)}</strong>` : `<strong>${escapeHtml(card.value)}</strong>`;
        return `
        <article class="detail-kpi-card">
          <h3>${escapeHtml(card.label)}</h3>
          ${value}
          ${meta}
        </article>
      `;
    })
        .join('\n');
    const hoursTable = `
    <table class="detail-mini-table">
      <thead>
        <tr><th>Hours</th><th>Total</th></tr>
      </thead>
      <tbody>
        <tr><td>Worked</td><td>${formatHoursDisplay(totals.workedHours)}</td></tr>
        <tr><td>PTO</td><td>${totals.ptoHours ? formatHoursDisplay(totals.ptoHours) : '—'}</td></tr>
        <tr><td>UTO</td><td>${totals.utoHours ? formatHoursDisplay(totals.utoHours) : '—'}</td></tr>
        <tr><td>Make-up</td><td>${totals.makeUpHours ? formatHoursDisplay(totals.makeUpHours) : '—'}</td></tr>
      </tbody>
    </table>
  `;
    const payTable = payLine
        ? `
      <table class="detail-mini-table">
        <thead>
          <tr><th>Component</th><th>Amount</th></tr>
        </thead>
        <tbody>
          ${payComponents
            .map((component) => `
                <tr>
                  <td>${escapeHtml(component.label)}</td>
                  <td>${formatCurrency(component.amount)}</td>
                </tr>
              `)
            .join('')}
          <tr>
            <td><strong>Total</strong></td>
            <td><strong>${formatCurrency(payComponentTotal)}</strong></td>
          </tr>
        </tbody>
      </table>
    `
        : '<div class="empty">Select an employee to review payroll details.</div>';
    const reconciliationNote = payLine
        ? reconciliationDelta === 0
            ? '<p class="detail-pay-meta">Components reconcile to the final payout.</p>'
            : `<p class="detail-pay-meta">Difference vs. final payout: ${formatCurrency(reconciliationDelta)}.</p>`
        : '';
    const makeUpRequests = attendanceSummary?.makeUpRequests ?? [];
    const makeUpList = makeUpRequests.length
        ? `<div><p class="detail-pay-meta"><strong>Matched make-up requests</strong></p><ul class="detail-makeup-list">${makeUpRequests
            .map((request) => `<li>${escapeHtml(request.start)} – ${escapeHtml(request.end)} · ${formatHoursDisplay(request.hours)}</li>`)
            .join('')}</ul></div>`
        : '';
    const formatShiftRange = (startIso, endIso) => {
        const toTime = (iso) => {
            if (!iso)
                return null;
            const parsed = new Date(iso);
            return Number.isNaN(parsed.getTime()) ? null : formatTimeOfDay(parsed);
        };
        const startText = toTime(startIso);
        const endText = toTime(endIso);
        if (!startText && !endText) {
            return '—';
        }
        if (startText && endText) {
            return `${startText} – ${endText}`;
        }
        return `${startText ?? '—'} – ${endText ?? '—'}`;
    };
    const formatPauseSummary = (count, minutes) => {
        if (!count && !minutes) {
            return '—';
        }
        const parts = [];
        if (count) {
            parts.push(`${count}×`);
        }
        if (minutes) {
            parts.push(`${minutes} min`);
        }
        return parts.join(' · ');
    };
    const timelineRows = detailList.length
        ? detailList
            .map((detail) => {
            const expected = detail.expectedHours ? formatHoursDisplay(detail.expectedHours) : '—';
            const worked = detail.workedHours ? formatHoursDisplay(detail.workedHours) : '—';
            const pto = detail.ptoHours ? formatHoursDisplay(detail.ptoHours) : '—';
            const makeUp = detail.makeUpHours ? formatHoursDisplay(detail.makeUpHours) : '—';
            const uto = detail.utoHours ? formatHoursDisplay(detail.utoHours) : '—';
            const tardy = detail.tardyMinutes ? `${detail.tardyMinutes} min` : '—';
            const shift = formatShiftRange(detail.clockIn, detail.clockOut);
            const breaks = formatPauseSummary(detail.breakCount, detail.breakMinutes);
            const lunches = formatPauseSummary(detail.lunchCount, detail.lunchMinutes);
            const idle = detail.idleMinutes ? `${detail.idleMinutes} min` : '—';
            const notes = detail.notes.length
                ? detail.notes.map((note) => `<div>${escapeHtml(note)}</div>`).join('')
                : '—';
            return `
            <tr>
              <td>${escapeHtml(detail.label)}</td>
              <td>${escapeHtml(expected)}</td>
              <td>${escapeHtml(shift)}</td>
              <td>${escapeHtml(worked)}</td>
              <td>${escapeHtml(pto)}</td>
              <td>${escapeHtml(makeUp)}</td>
              <td>${escapeHtml(uto)}</td>
              <td>${escapeHtml(tardy)}</td>
              <td>${escapeHtml(breaks)}</td>
              <td>${escapeHtml(lunches)}</td>
              <td>${escapeHtml(idle)}</td>
              <td>${notes === '—' ? '—' : notes}</td>
            </tr>
          `;
        })
            .join('\n')
        : '';
    const timelineSection = attendanceSummary?.details.length
        ? `
        <div class="table-scroll detail-timeline">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Expected</th>
                <th>Shift</th>
                <th>Worked</th>
                <th>PTO</th>
                <th>Make-up</th>
                <th>UTO</th>
                <th>Tardy</th>
                <th>Breaks</th>
                <th>Lunch</th>
                <th>Idle</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${timelineRows}
            </tbody>
          </table>
        </div>
      `
        : '<div class="empty">Day-level attendance details are not available for this period.</div>';
    const exceptionItems = [];
    if (totals.tardyEvents > 0) {
        exceptionItems.push({
            label: 'Tardy arrivals',
            detail: `${totals.tardyEvents} event${totals.tardyEvents === 1 ? '' : 's'} · ${totals.tardyMinutes} min`
        });
    }
    if (totals.absenceDays > 0) {
        exceptionItems.push({
            label: 'Absence alerts',
            detail: `${totals.absenceDays} day${totals.absenceDays === 1 ? '' : 's'} flagged`
        });
    }
    if (totals.utoHours > 0) {
        exceptionItems.push({
            label: 'UTO usage',
            detail: formatHoursDisplay(totals.utoHours)
        });
    }
    const missingPunches = detailList.filter((detail) => detail.expectedHours > 0 && (!detail.clockIn || !detail.clockOut));
    if (missingPunches.length) {
        exceptionItems.push({
            label: 'Missing punches',
            detail: `${missingPunches.length} day${missingPunches.length === 1 ? '' : 's'} to review`
        });
    }
    const longLunches = detailList.filter((detail) => detail.lunchMinutes > 75);
    if (longLunches.length) {
        const totalLongLunch = longLunches.reduce((sum, detail) => sum + detail.lunchMinutes, 0);
        exceptionItems.push({
            label: 'Long lunches',
            detail: `${longLunches.length} day${longLunches.length === 1 ? '' : 's'} · ${totalLongLunch} min`
        });
    }
    const longBreaks = detailList.filter((detail) => detail.breakMinutes > 45);
    if (longBreaks.length) {
        const totalLongBreak = longBreaks.reduce((sum, detail) => sum + detail.breakMinutes, 0);
        exceptionItems.push({
            label: 'Extended breaks',
            detail: `${longBreaks.length} day${longBreaks.length === 1 ? '' : 's'} · ${totalLongBreak} min`
        });
    }
    const idleSpikes = detailList.filter((detail) => detail.idleMinutes >= 60);
    if (idleSpikes.length) {
        const totalIdle = idleSpikes.reduce((sum, detail) => sum + detail.idleMinutes, 0);
        exceptionItems.push({
            label: 'Idle spikes',
            detail: `${idleSpikes.length} day${idleSpikes.length === 1 ? '' : 's'} · ${totalIdle} min`
        });
    }
    const exceptionsHtml = exceptionItems.length
        ? `<ul class="detail-exceptions">${exceptionItems
            .map((item) => `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></li>`)
            .join('')}</ul>`
        : '<div class="empty">No exceptions recorded for this employee.</div>';
    const renderDelta = (current, previous, unit, invert = false) => {
        if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) {
            return '<span class="trend-neutral">—</span>';
        }
        const rounded = Math.round((current - previous) * 10) / 10;
        if (Math.abs(rounded) < 0.05) {
            return '<span class="trend-neutral">—</span>';
        }
        const improved = invert ? rounded < 0 : rounded > 0;
        const arrow = improved ? '▲' : '▼';
        const className = improved ? 'trend-up' : 'trend-down';
        const absValue = Math.abs(rounded);
        const formatted = absValue % 1 === 0 ? absValue.toFixed(0) : absValue.toFixed(1);
        const suffix = unit === 'percent' ? ' pts' : ' min';
        return `<span class="${className}">${arrow} ${formatted}${suffix}</span>`;
    };
    const previousTardyMinutes = previousSummary ? previousSummary.totals.tardyMinutes : null;
    const trendsRows = `
    <tr>
      <td>On-time Attendance</td>
      <td>${formatPercent(onTimePercentage)}</td>
      <td>${formatPercent(previousOnTimePercentage)}</td>
      <td>${renderDelta(onTimePercentage, previousOnTimePercentage, 'percent')}</td>
    </tr>
    <tr>
      <td>Avg Lunch Duration</td>
      <td>${escapeHtml(formatAverageMinutes(currentBehavior.averageLunch))}</td>
      <td>${escapeHtml(formatAverageMinutes(previousBehavior.averageLunch))}</td>
      <td>${renderDelta(currentBehavior.averageLunch, previousBehavior.averageLunch, 'minutes', true)}</td>
    </tr>
    <tr>
      <td>Avg Break Duration</td>
      <td>${escapeHtml(formatAverageMinutes(currentBehavior.averageBreak))}</td>
      <td>${escapeHtml(formatAverageMinutes(previousBehavior.averageBreak))}</td>
      <td>${renderDelta(currentBehavior.averageBreak, previousBehavior.averageBreak, 'minutes', true)}</td>
    </tr>
    <tr>
      <td>Avg Idle Minutes</td>
      <td>${escapeHtml(formatAverageMinutes(currentBehavior.averageIdle))}</td>
      <td>${escapeHtml(formatAverageMinutes(previousBehavior.averageIdle))}</td>
      <td>${renderDelta(currentBehavior.averageIdle, previousBehavior.averageIdle, 'minutes', true)}</td>
    </tr>
    <tr>
      <td>Tardiness Minutes</td>
      <td>${totals.tardyMinutes} min</td>
      <td>${previousTardyMinutes !== null ? `${previousTardyMinutes} min` : '—'}</td>
      <td>${renderDelta(totals.tardyMinutes, previousTardyMinutes, 'minutes', true)}</td>
    </tr>
  `;
    const employeeOptions = sortedLines.length
        ? buildSelectOptions(sortedLines.map((line) => ({ value: String(line.userId), label: line.user?.name ?? `User ${line.userId}` })), selectedEmployeeId ? String(selectedEmployeeId) : undefined)
        : '';
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Payroll Period – ${escapeHtml(payDateLabel)}</title>
        <style>${baseStyles}</style>
      </head>
      <body class="dashboard dashboard--payroll-detail">
        ${renderNav('payroll')}
        <main class="page-shell">
          <header class="detail-header">
            <div class="detail-identity">
              <a class="button button-secondary detail-back" href="/dashboard/payroll">Back to Payroll</a>
              <div class="detail-avatar">${escapeHtml(employeeInitials)}</div>
              <div class="detail-identity-text">
                <h1>${escapeHtml(employeeName)}</h1>
                <p>${escapeHtml(employeeRoleLabel)}${employeeEmail ? ` · ${escapeHtml(employeeEmail)}` : ''}</p>
              </div>
            </div>
            <div class="detail-meta">
              ${statusChip}
              <span>${escapeHtml(periodRangeLabel)}</span>
              <span>${escapeHtml(computedLabel)}</span>
            </div>
          </header>
          <section class="detail-kpis">
            ${kpiCards}
          </section>
          <div class="cards-grid">
            <section class="card">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Hours &amp; Pay Calculation</h2>
                  <p class="card__subtitle">How hours and payroll inputs reconcile to the final amount.</p>
                </div>
              </div>
              <div class="card__body detail-hours-grid">
                ${hoursTable}
                ${payTable}
              </div>
              <div class="card__body">
                ${reconciliationNote}
                ${makeUpList}
              </div>
            </section>
            <section class="card">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Attendance Timeline Summary</h2>
                  <p class="card__subtitle">Clock-ins, lunches, breaks, and idle signals for the period.</p>
                </div>
              </div>
              <div class="card__body">
                ${timelineSection}
              </div>
            </section>
          </div>
          <div class="cards-grid">
            <section class="card">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Exceptions &amp; Flags</h2>
                  <p class="card__subtitle">Policy breaches and anomalies to review.</p>
                </div>
              </div>
              <div class="card__body">
                ${exceptionsHtml}
              </div>
            </section>
            <section class="card">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Trends vs. Prior Period</h2>
                  <p class="card__subtitle">How this employee is trending period-over-period.</p>
                </div>
              </div>
              <div class="card__body">
                <table class="detail-trends">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Current</th>
                      <th>Prior</th>
                      <th>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${trendsRows}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <section class="card">
            <div class="card__header">
              <div>
                <h2 class="card__title">Utilities</h2>
                <p class="card__subtitle">Jump to another period, export, or capture notes.</p>
              </div>
            </div>
            <div class="card__body detail-utilities">
              <div class="detail-utility-row">
                <label>
                  <span>Payroll period</span>
                  <select data-period-select>
                    ${periodOptions}
                  </select>
                </label>
                <label>
                  <span>Employee</span>
                  <select data-employee-select>
                    ${employeeOptions}
                  </select>
                </label>
              </div>
              <div class="detail-utility-actions">
                <button type="button" class="button button-secondary" data-print>Print</button>
                <a class="button" href="/api/payroll/payruns/${formatIsoDate(normalizedPayDate)}/export" target="_blank" rel="noopener">Export CSV</a>
              </div>
              <label class="detail-notes">
                <span>Review Notes</span>
                <textarea readonly placeholder="Use Payroll notes to capture manager follow-ups."></textarea>
              </label>
            </div>
          </section>
        </main>
        <script>
          (() => {
            const employeeSelect = document.querySelector('[data-employee-select]');
            if (employeeSelect instanceof HTMLSelectElement) {
              employeeSelect.addEventListener('change', () => {
                const url = new URL(window.location.href);
                if (employeeSelect.value) {
                  url.searchParams.set('employeeId', employeeSelect.value);
                } else {
                  url.searchParams.delete('employeeId');
                }
                window.location.href = url.toString();
              });
            }
            const periodSelect = document.querySelector('[data-period-select]');
            if (periodSelect instanceof HTMLSelectElement) {
              periodSelect.addEventListener('change', () => {
                if (!periodSelect.value) return;
                const base = new URL('/dashboard/payroll/period/' + periodSelect.value, window.location.origin);
                const current = new URL(window.location.href);
                const employee = current.searchParams.get('employeeId');
                if (employee) {
                  base.searchParams.set('employeeId', employee);
                }
                window.location.href = base.toString();
              });
            }
            const printButton = document.querySelector('[data-print]');
            if (printButton instanceof HTMLButtonElement) {
              printButton.addEventListener('click', () => window.print());
            }
          })();
        </script>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
exports.dashboardRouter.get('/employees/:employeeId', async (req, res) => {
    const employeeIdParam = Number.parseInt(req.params.employeeId ?? '', 10);
    if (!Number.isFinite(employeeIdParam) || employeeIdParam <= 0) {
        throw errors_1.HttpError.notFound('Employee not found');
    }
    const employee = await prisma_1.prisma.user.findUnique({ where: { id: employeeIdParam } });
    if (!employee || employee.role !== 'employee') {
        throw errors_1.HttpError.notFound('Employee not found');
    }
    const configs = await (0, config_1.listEmployeeConfigs)(employee.id);
    const latestConfig = configs[0] ?? null;
    const scheduleSnapshot = latestConfig ? (0, config_1.ensureSchedule)(latestConfig.schedule) : (0, config_1.ensureSchedule)({});
    const defaultEffectiveDate = formatIsoDate(zonedStartOfDay(new Date()));
    const toNumberInput = (value) => value !== null && value !== undefined && Number.isFinite(value) ? String(value) : '';
    const compensationHistoryRows = configs.length
        ? configs
            .map((config) => {
            const kpiLabel = config.kpiEligible
                ? `Eligible${config.defaultKpiBonus ? ` (${formatCurrency(config.defaultKpiBonus)})` : ''}`
                : 'Not eligible';
            const accrualLabel = `Enabled${config.accrualMethod ? ` – ${escapeHtml(config.accrualMethod)}` : ''}`;
            return `
            <tr>
              <td>${escapeHtml(formatFullDate(config.effectiveOn))}</td>
              <td>${formatCurrency(config.baseSemiMonthlySalary)}</td>
              <td>${formatCurrency(config.monthlyAttendanceBonus)}</td>
              <td>${formatCurrency(config.quarterlyAttendanceBonus)}</td>
              <td>${escapeHtml(kpiLabel)}</td>
              <td>${escapeHtml(accrualLabel)}</td>
            </tr>
          `;
        })
            .join('\n')
        : '<tr><td colspan="6" class="empty">No compensation versions recorded yet.</td></tr>';
    const scheduleHistoryRows = configs.length
        ? configs
            .map((config) => {
            const summary = summarizeSchedule(config.schedule);
            return `
            <tr>
              <td>${escapeHtml(formatFullDate(config.effectiveOn))}</td>
              <td>${summary}</td>
            </tr>
          `;
        })
            .join('\n')
        : '<tr><td colspan="2" class="empty">No schedule versions recorded yet.</td></tr>';
    const dayKeys = ['0', '1', '2', '3', '4', '5', '6'];
    const scheduleDayRows = dayKeys
        .map((dayKey) => {
        const entry = scheduleSnapshot.days[dayKey];
        const startValue = escapeHtml(entry.start);
        const endValue = escapeHtml(entry.end);
        const breakValue = toNumberInput(entry.breakMinutes);
        const checked = entry.enabled ? ' checked' : '';
        return `
        <tr data-day-row="${dayKey}">
          <th scope="row">${escapeHtml(weekdayLabels[Number(dayKey)])}</th>
          <td><input type="checkbox" name="day-enabled" data-day="${dayKey}"${checked} /></td>
          <td><input type="time" name="day-start" data-day="${dayKey}" value="${startValue}" required /></td>
          <td><input type="time" name="day-end" data-day="${dayKey}" value="${endValue}" required /></td>
          <td><input type="number" name="day-break" data-day="${dayKey}" value="${breakValue}" min="0" step="5" /></td>
        </tr>
      `;
    })
        .join('\n');
    const latestEffectiveInput = latestConfig ? formatIsoDate(latestConfig.effectiveOn) : defaultEffectiveDate;
    const balanceRecord = await (0, balances_1.ensureBalance)(employee.id);
    const profilePayload = {
        user: {
            id: employee.id,
            name: employee.name,
            email: employee.email,
            role: employee.role,
            active: employee.active
        },
        balance: {
            ptoHours: Number(balanceRecord.ptoHours),
            basePtoHours: Number(balanceRecord.basePtoHours),
            utoHours: Number(balanceRecord.utoHours),
            baseUtoHours: Number(balanceRecord.baseUtoHours),
            makeUpHours: Number(balanceRecord.makeUpHours),
            baseMakeUpHours: Number(balanceRecord.baseMakeUpHours ?? 0)
        },
        latestConfig: latestConfig
            ? {
                effectiveOn: latestEffectiveInput,
                baseSemiMonthlySalary: latestConfig.baseSemiMonthlySalary,
                monthlyAttendanceBonus: latestConfig.monthlyAttendanceBonus,
                quarterlyAttendanceBonus: latestConfig.quarterlyAttendanceBonus,
                kpiEligible: latestConfig.kpiEligible,
                defaultKpiBonus: latestConfig.defaultKpiBonus,
                accrualEnabled: true,
                accrualMethod: latestConfig.accrualMethod,
                ptoBalanceHours: latestConfig.ptoBalanceHours,
                utoBalanceHours: latestConfig.utoBalanceHours,
                schedule: scheduleSnapshot
            }
            : null
    };
    const profileJson = JSON.stringify(profilePayload).replace(/</g, '\\u003c');
    const statusChip = employee.active
        ? '<span class="status-chip status-chip--approved">Active</span>'
        : '<span class="status-chip status-chip--warn">Inactive</span>';
    const employeeTitle = `${escapeHtml(employee.name)} – Employee Profile`;
    const compensationBaseValue = toNumberInput(latestConfig?.baseSemiMonthlySalary);
    const compensationMonthlyValue = toNumberInput(latestConfig?.monthlyAttendanceBonus);
    const compensationQuarterlyValue = toNumberInput(latestConfig?.quarterlyAttendanceBonus);
    const compensationKpiChecked = latestConfig?.kpiEligible ? ' checked' : '';
    const compensationKpiValue = toNumberInput(latestConfig?.defaultKpiBonus ?? null);
    const compensationAccrualStatus = latestConfig ? 'Enabled' : 'Not configured';
    const compensationAccrualMethodDisplay = latestConfig?.accrualMethod && latestConfig.accrualMethod.trim().length
        ? latestConfig.accrualMethod
        : '—';
    const compensationPtoDisplay = formatHours(Number(balanceRecord.basePtoHours ?? balanceRecord.ptoHours ?? 0));
    const compensationUtoDisplay = formatHours(Number(balanceRecord.baseUtoHours ?? balanceRecord.utoHours ?? 0));
    const compensationMakeUpDisplay = formatHours(Number(balanceRecord.baseMakeUpHours ?? balanceRecord.makeUpHours ?? 0));
    const scheduleTimeZoneValue = escapeHtml(scheduleSnapshot.timeZone);
    const scheduleDisabledAttr = latestConfig ? '' : ' disabled';
    const scheduleDisabledMessage = latestConfig ? '' : 'Save compensation details before updating the schedule.';
    const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${employeeTitle}</title>
        <style>${baseStyles}</style>
        <style>
          body.dashboard--employee-profile .profile-grid { display: grid; gap: 1.5rem; }
          body.dashboard--employee-profile .profile-summary { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.95rem; color: #475569; }
          body.dashboard--employee-profile .profile-summary strong { color: #0f172a; }
          body.dashboard--employee-profile .profile-summary span { display: inline-flex; align-items: center; gap: 0.35rem; }
          body.dashboard--employee-profile .profile-form { display: grid; gap: 1.25rem; }
          body.dashboard--employee-profile .profile-form__grid { display: grid; gap: 0.9rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
          body.dashboard--employee-profile .profile-form label { display: grid; gap: 0.35rem; font-size: 0.95rem; color: #0f172a; }
          body.dashboard--employee-profile .profile-form label span { font-weight: 600; }
          body.dashboard--employee-profile .profile-form__footer { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; justify-content: flex-end; }
          body.dashboard--employee-profile .profile-form__footer .form-error { flex: 1; margin: 0; min-height: 1rem; color: #dc2626; font-size: 0.9rem; }
          body.dashboard--employee-profile .profile-compensation-layout { display: grid; gap: 1.2rem; }
          @media (min-width: 960px) {
            body.dashboard--employee-profile .profile-compensation-layout { grid-template-columns: minmax(0, 1fr) minmax(260px, 0.85fr); align-items: start; }
          }
          body.dashboard--employee-profile .profile-compensation-column { display: grid; gap: 1rem; }
          body.dashboard--employee-profile .profile-timeoff { border: 1px solid rgba(148,163,184,0.26); border-radius: 16px; background: rgba(248,250,252,0.8); padding: 1rem 1.25rem; display: grid; gap: 0.85rem; box-shadow: inset 0 1px 0 rgba(255,255,255,0.6); }
          body.dashboard--employee-profile .profile-timeoff__title { margin: 0; font-size: 0.95rem; font-weight: 700; color: #0f172a; }
          body.dashboard--employee-profile .profile-timeoff__hint { margin: 0; font-size: 0.85rem; color: #64748b; }
          body.dashboard--employee-profile .profile-timeoff__fields { display: grid; gap: 0.75rem; border: 1px dashed rgba(148,163,184,0.25); border-radius: 12px; padding: 0.9rem 1rem; background: rgba(255,255,255,0.55); transition: opacity 0.2s ease; }
          body.dashboard--employee-profile .profile-timeoff__fields.profile-timeoff__fields--disabled { opacity: 0.55; }
          body.dashboard--employee-profile .profile-timeoff__fields.profile-timeoff__fields--disabled input { cursor: not-allowed; }
          body.dashboard--employee-profile .profile-timeoff__hint--readonly { margin-top: 0.35rem; font-size: 0.8rem; color: #475569; }
          body.dashboard--employee-profile .profile-timeoff__fields--readonly { opacity: 0.7; pointer-events: none; }
          body.dashboard--employee-profile .profile-timeoff__fields--readonly input { background: rgba(248,250,252,0.8); color: #475569; border-color: rgba(148,163,184,0.35); cursor: default; }
          body.dashboard--employee-profile .profile-timeoff__readonly input { cursor: default; }
          body.dashboard--employee-profile .profile-timeoff__note { margin: 0; font-size: 0.8rem; color: #475569; }
          body.dashboard--employee-profile .profile-schedule-table { width: 100%; border-collapse: collapse; }
          body.dashboard--employee-profile .profile-schedule-table th,
          body.dashboard--employee-profile .profile-schedule-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid rgba(148,163,184,0.18); text-align: left; }
          body.dashboard--employee-profile .profile-schedule-table td:nth-child(2) { text-align: center; }
          body.dashboard--employee-profile .profile-schedule-table input[type='time'] { width: 100%; }
          body.dashboard--employee-profile .profile-schedule-table input[type='number'] { width: 100%; }
        </style>
      </head>
      <body class="dashboard dashboard--employee-profile">
        ${renderNav('payroll')}
        <main class="page-shell">
          <header class="page-header">
            <div class="page-header__content">
              <p class="page-header__eyebrow">Employee</p>
              <h1 class="page-header__title">${escapeHtml(employee.name)}</h1>
              <div class="profile-summary">
                <span><strong>Email:</strong> ${escapeHtml(employee.email)}</span>
                <span><strong>Status:</strong> ${statusChip}</span>
              </div>
            </div>
            <div class="page-header__meta">
              <a class="button button-secondary" href="/dashboard/payroll">Back to Payroll</a>
            </div>
          </header>

          <section class="card">
            <div class="card__header">
              <div>
                <h2 class="card__title">New Compensation Version</h2>
                <p class="card__subtitle">Create a new compensation record with an effective date. Prior versions remain archived.</p>
              </div>
            </div>
            <div class="card__body">
              <form class="profile-form" data-profile-form="compensation">
                <div class="profile-compensation-layout">
                  <div class="profile-compensation-column">
                    <div class="profile-form__grid">
                      <label>
                        <span>Effective On</span>
                        <input type="date" name="effectiveOn" value="${latestEffectiveInput}" required />
                      </label>
                      <label>
                        <span>Semi-Monthly Base</span>
                        <input type="number" name="baseSemiMonthlySalary" min="0" step="0.01" value="${compensationBaseValue}" required />
                      </label>
                      <label>
                        <span>Monthly Attendance Bonus</span>
                        <input type="number" name="monthlyAttendanceBonus" min="0" step="0.01" value="${compensationMonthlyValue}" required />
                      </label>
                      <label>
                        <span>Quarterly Attendance Bonus</span>
                        <input type="number" name="quarterlyAttendanceBonus" min="0" step="0.01" value="${compensationQuarterlyValue}" required />
                      </label>
                      <label class="checkbox-field">
                        <input type="checkbox" name="kpiEligible"${compensationKpiChecked} />
                        <span>KPI Eligible</span>
                      </label>
                      <label>
                        <span>Default KPI Bonus</span>
                        <input type="number" name="defaultKpiBonus" min="0" step="0.01" value="${compensationKpiValue}" />
                      </label>
                    </div>
                  </div>
                  <div class="profile-compensation-column">
                    <div class="profile-timeoff">
                      <div>
                        <h3 class="profile-timeoff__title">Time Off Balances</h3>
                        <p class="profile-timeoff__hint">Control baseline PTO / UTO values used by payroll.</p>
                        <p class="profile-timeoff__hint profile-timeoff__hint--readonly">Values shown here are read-only. Use the Balances tab to adjust accrual rates (set to 0 hours to pause accrual).</p>
                      </div>
                      <div class="profile-timeoff__fields profile-timeoff__fields--readonly">
                        <label class="profile-timeoff__readonly">
                          <span>Accrual Status</span>
                          <input type="text" value="${escapeHtml(compensationAccrualStatus)}" readonly />
                        </label>
                        <label>
                          <span>Accrual Method</span>
                          <input type="text" value="${escapeHtml(compensationAccrualMethodDisplay)}" readonly />
                        </label>
                        <label>
                          <span>PTO Balance (hours)</span>
                          <input type="text" value="${escapeHtml(compensationPtoDisplay)}" readonly />
                        </label>
                        <label>
                          <span>UTO Balance (hours)</span>
                          <input type="text" value="${escapeHtml(compensationUtoDisplay)}" readonly />
                        </label>
                        <label>
                          <span>Make-Up Balance (hours)</span>
                          <input type="text" value="${escapeHtml(compensationMakeUpDisplay)}" readonly />
                        </label>
                      </div>
                      <p class="profile-timeoff__note">Manage balances and monthly accrual amounts from the Balances tab so the app and payroll stay in sync.</p>
                    </div>
                  </div>
                </div>
                <div class="profile-form__footer">
                  <p class="form-error" data-error></p>
                  <button type="submit" class="button primary">Save Compensation Version</button>
                </div>
              </form>
            </div>
          </section>

          <section class="card">
            <div class="card__header">
              <div>
                <h2 class="card__title">New Schedule Version</h2>
                <p class="card__subtitle">Update the weekly schedule pattern with a new effective date.</p>
              </div>
            </div>
            <div class="card__body">
              <form class="profile-form" data-profile-form="schedule" data-default-timezone="${scheduleTimeZoneValue}">
                <div class="profile-form__grid">
                  <label>
                    <span>Effective On</span>
                    <input type="date" name="effectiveOn" value="${defaultEffectiveDate}" required />
                  </label>
                  <label>
                    <span>Timezone</span>
                    <input type="text" name="scheduleTimeZone" value="${scheduleTimeZoneValue}" required />
                  </label>
                </div>
                <div class="table-scroll">
                  <table class="profile-schedule-table">
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th>Enabled</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Unpaid Break (min)</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${scheduleDayRows}
                    </tbody>
                  </table>
                </div>
                <div class="profile-form__footer">
                  <p class="form-error" data-error>${scheduleDisabledMessage}</p>
                  <button type="submit" class="button primary"${scheduleDisabledAttr}>Save Schedule Version</button>
                </div>
              </form>
            </div>
          </section>

          <div class="cards-grid">
            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Compensation History</h2>
                  <p class="card__subtitle">Most recent versions first.</p>
                </div>
              </div>
              <div class="card__body">
                <div class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Effective On</th>
                        <th>Base</th>
                        <th>Monthly Bonus</th>
                        <th>Quarterly Bonus</th>
                        <th>KPI</th>
                        <th>Accrual</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${compensationHistoryRows}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section class="card card--table">
              <div class="card__header">
                <div>
                  <h2 class="card__title">Schedule History</h2>
                  <p class="card__subtitle">Summaries include the configured timezone.</p>
                </div>
              </div>
              <div class="card__body">
                <div class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Effective On</th>
                        <th>Schedule</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${scheduleHistoryRows}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>

          <script id="employee-profile-data" type="application/json">${profileJson}</script>
          <script>
            (() => {
              const dataElement = document.getElementById('employee-profile-data');
              if (!dataElement) return;
              let profile;
              try {
                profile = JSON.parse(dataElement.textContent || '{}');
              } catch (error) {
                console.error('Unable to parse profile data', error);
                return;
              }

              const DEFAULT_TIME_ZONE = '${constants_1.PAYROLL_TIME_ZONE}';
              const DAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'];

              const buildEmptySchedule = () => {
                const days = {};
                DAY_KEYS.forEach((day) => {
                  days[day] = {
                    enabled: false,
                    start: '09:00',
                    end: '17:00',
                    breakMinutes: 0,
                    expectedHours: 8
                  };
                });
                return { version: 2, timeZone: DEFAULT_TIME_ZONE, days };
              };

              const latest = profile.latestConfig;
              const cloneSchedule = (schedule) => JSON.parse(JSON.stringify(schedule));
              const latestSchedule = latest?.schedule ? cloneSchedule(latest.schedule) : buildEmptySchedule();

              const computeExpectedHours = (start, end, breakMinutes) => {
                const parse = (value) => {
                  const parts = value.split(':');
                  if (parts.length !== 2) return null;
                  const hours = Number.parseInt(parts[0], 10);
                  const minutes = Number.parseInt(parts[1], 10);
                  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
                  return hours * 60 + minutes;
                };
                const startTotal = parse(start);
                const endTotal = parse(end);
                if (startTotal === null || endTotal === null) return 0;
                const span = Math.max(0, endTotal - startTotal);
                const net = Math.max(0, span - Math.max(0, breakMinutes));
                return Math.round((net / 60) * 100) / 100;
              };

              const buildBasePayload = () => ({
                userId: profile.user.id,
                baseSemiMonthlySalary: Number(latest?.baseSemiMonthlySalary ?? 0),
                monthlyAttendanceBonus: Number(latest?.monthlyAttendanceBonus ?? 0),
                quarterlyAttendanceBonus: Number(latest?.quarterlyAttendanceBonus ?? 0),
                kpiEligible: Boolean(latest?.kpiEligible ?? false),
                defaultKpiBonus: latest?.defaultKpiBonus ?? null,
                schedule: latest?.schedule ? cloneSchedule(latest.schedule) : buildEmptySchedule(),
                accrualEnabled: true,
                accrualMethod: latest?.accrualMethod ?? null
              });

              const toFiniteNumber = (value, fallback = 0) => {
                const parsed = Number.parseFloat(value ?? '');
                return Number.isFinite(parsed) ? parsed : fallback;
              };

              const formatNumberForInput = (value) => {
                if (value === null || value === undefined) {
                  return '';
                }
                const parsed = Number(value);
                return Number.isFinite(parsed) ? String(parsed) : '';
              };

              const forms = document.querySelectorAll('[data-profile-form]');
              forms.forEach((form) => {
                form.addEventListener('submit', async (event) => {
                  event.preventDefault();
                  const kind = form.getAttribute('data-profile-form');
                  const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
                  const errorEl = form.querySelector('[data-error]');
                  if (errorEl) errorEl.textContent = '';
                  if (submitter) submitter.disabled = true;

                  try {
                    if (kind === 'schedule' && !latest) {
                      throw new Error('Save compensation details before updating the schedule.');
                    }

                    const payload = buildBasePayload();
                    const effectiveInput = form.querySelector('input[name="effectiveOn"]');
                    if (!(effectiveInput instanceof HTMLInputElement) || !effectiveInput.value) {
                      throw new Error('Effective date is required.');
                    }
                    payload.effectiveOn = effectiveInput.value;

                    if (kind === 'compensation') {
                      const baseInput = form.querySelector('input[name="baseSemiMonthlySalary"]');
                      const monthlyInput = form.querySelector('input[name="monthlyAttendanceBonus"]');
                      const quarterlyInput = form.querySelector('input[name="quarterlyAttendanceBonus"]');
                      const kpiCheckbox = form.querySelector('input[name="kpiEligible"]');
                      const kpiBonusInput = form.querySelector('input[name="defaultKpiBonus"]');

                      payload.baseSemiMonthlySalary = toFiniteNumber(baseInput?.value, 0);
                      payload.monthlyAttendanceBonus = toFiniteNumber(monthlyInput?.value, 0);
                      payload.quarterlyAttendanceBonus = toFiniteNumber(quarterlyInput?.value, 0);
                      payload.kpiEligible = kpiCheckbox instanceof HTMLInputElement ? kpiCheckbox.checked : false;
                      if (payload.kpiEligible) {
                        payload.defaultKpiBonus = toFiniteNumber(kpiBonusInput?.value, 0);
                      } else {
                        payload.defaultKpiBonus = null;
                      }

                      payload.accrualEnabled = true;
                      payload.accrualMethod =
                        typeof latest?.accrualMethod === 'string' && latest.accrualMethod.trim().length
                          ? latest.accrualMethod.trim()
                          : null;
                    } else if (kind === 'schedule') {
                      const timeZoneInput = form.querySelector('input[name="scheduleTimeZone"]');
                      const timeZone = timeZoneInput instanceof HTMLInputElement && timeZoneInput.value.trim()
                        ? timeZoneInput.value.trim()
                        : latestSchedule.timeZone || DEFAULT_TIME_ZONE;

                      const days = {};
                      DAY_KEYS.forEach((day) => {
                        const enabledInput = form.querySelector("input[name='day-enabled'][data-day='" + day + "']");
                        const startInput = form.querySelector("input[name='day-start'][data-day='" + day + "']");
                        const endInput = form.querySelector("input[name='day-end'][data-day='" + day + "']");
                        const breakInput = form.querySelector("input[name='day-break'][data-day='" + day + "']");

                        const enabled = enabledInput instanceof HTMLInputElement ? enabledInput.checked : false;
                        const start = startInput instanceof HTMLInputElement && startInput.value ? startInput.value : '09:00';
                        const end = endInput instanceof HTMLInputElement && endInput.value ? endInput.value : '17:00';
                        const breakMinutes = Number.parseInt(breakInput?.value ?? '0', 10);

                        days[day] = {
                          enabled,
                          start,
                          end,
                          breakMinutes: Number.isFinite(breakMinutes) ? Math.max(0, breakMinutes) : 0,
                          expectedHours: computeExpectedHours(start, end, Number.isFinite(breakMinutes) ? Math.max(0, breakMinutes) : 0)
                        };
                      });

                      payload.schedule = { version: 2, timeZone, days };
                    }

                    const response = await fetch('/api/payroll/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(payload),
                      credentials: 'same-origin'
                    });

                    if (!response.ok) {
                      let message = 'Unable to save changes.';
                      if (response.status === 403) {
                        message = 'You do not have permission to manage compensation. Sign in with an admin account.';
                      } else if (response.status === 401) {
                        message = 'Your session expired. Refresh and sign in again.';
                      }
                      try {
                        const data = await response.json();
                        if (data && typeof data.error === 'string') message = data.error;
                        else if (data && typeof data.message === 'string') message = data.message;
                      } catch (err) {}
                      throw new Error(message);
                    }

                    window.location.reload();
                  } catch (error) {
                    if (errorEl) {
                      errorEl.textContent = error instanceof Error ? error.message : 'Unable to save changes.';
                    }
                    if (submitter) submitter.disabled = false;
                  }
              });
            });

            const compensationForm = document.querySelector('[data-profile-form="compensation"]');
            if (compensationForm) {
              const kpiCheckbox = compensationForm.querySelector('input[name="kpiEligible"]');
              const kpiInput = compensationForm.querySelector('input[name="defaultKpiBonus"]');
              const syncKpi = () => {
                if (!(kpiInput instanceof HTMLInputElement)) return;
                const enabled = kpiCheckbox instanceof HTMLInputElement ? kpiCheckbox.checked : false;
                kpiInput.disabled = !enabled;
                if (!enabled) {
                  kpiInput.value = '';
                } else if (!kpiInput.value && latest) {
                  kpiInput.value = formatNumberForInput(latest.defaultKpiBonus ?? 0);
                }
              };
              syncKpi();
              if (kpiCheckbox instanceof HTMLInputElement) {
                kpiCheckbox.addEventListener('change', syncKpi);
              }
            }
          })();
          </script>
        </main>
      </body>
    </html>
  `;
    res.type('html').send(html);
});
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
exports.dashboardRouter.post('/settings/employees/:id/delete', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw errors_1.HttpError.badRequest('Invalid employee id');
    }
    const employee = await prisma_1.prisma.user.findUnique({ where: { id } });
    if (!employee || employee.role !== 'employee') {
        throw errors_1.HttpError.notFound('Employee not found');
    }
    await prisma_1.prisma.$transaction(async (tx) => {
        await tx.event.deleteMany({ where: { session: { userId: id } } });
        await tx.minuteStat.deleteMany({ where: { session: { userId: id } } });
        await tx.sessionPause.deleteMany({ where: { session: { userId: id } } });
        await tx.presencePrompt.deleteMany({ where: { session: { userId: id } } });
        await tx.session.deleteMany({ where: { userId: id } });
        await tx.timeRequest.deleteMany({ where: { userId: id } });
        await tx.timesheetEditRequest.deleteMany({ where: { userId: id } });
        await tx.shiftAssignment.deleteMany({ where: { userId: id } });
        await tx.attendanceMonthFact.deleteMany({ where: { userId: id } });
        await tx.payrollLine.deleteMany({ where: { userId: id } });
        await tx.bonusCandidate.deleteMany({ where: { userId: id } });
        await tx.balanceLedger.deleteMany({ where: { userId: id } });
        await tx.accrualRule.deleteMany({ where: { userId: id } });
        await tx.refreshToken.deleteMany({ where: { userId: id } });
        await tx.ptoBalance.deleteMany({ where: { userId: id } });
        await tx.employeeCompConfig.deleteMany({ where: { userId: id } });
        await tx.user.delete({ where: { id } });
    });
    res.redirect('/dashboard/settings?message=' + encodeURIComponent('Employee deleted.'));
}));
exports.dashboardRouter.post('/settings/employees/:id/name', (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw errors_1.HttpError.badRequest('Invalid employee id');
    }
    const parsed = updateEmployeeNameSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Provide a name between 1 and 200 characters.'));
    }
    const name = parsed.data.name.trim();
    if (!name) {
        return res.redirect('/dashboard/settings?error=' + encodeURIComponent('Name is required.'));
    }
    const employee = await prisma_1.prisma.user.findUnique({ where: { id } });
    if (!employee || employee.role !== 'employee') {
        throw errors_1.HttpError.notFound('Employee not found');
    }
    if (employee.name === name) {
        return res.redirect('/dashboard/settings?message=' + encodeURIComponent('Employee name unchanged.'));
    }
    await prisma_1.prisma.user.update({ where: { id }, data: { name } });
    res.redirect('/dashboard/settings?message=' + encodeURIComponent('Employee name updated.'));
}));

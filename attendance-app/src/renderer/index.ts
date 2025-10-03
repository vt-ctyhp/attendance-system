import { resolveHeroAvatarPaths, type HeroAvatarStatus } from './avatarResolver';

const MINUTE = 60_000;

type SessionStatus = 'clocked_out' | 'working' | 'break' | 'lunch';
type RequestType = 'make_up' | 'time_off' | 'edit';
type RequestStatus = 'pending' | 'approved' | 'denied';
type TimesheetView = 'weekly' | 'pay_period' | 'monthly';

type ActivityCategory = 'session' | 'presence' | 'break' | 'lunch' | 'request' | 'idle';

interface TimesheetDay {
  date: string;
  label: string;
  activeHours: number;
  idleHours: number;
  breaks: number;
  lunches: number;
  tardyMinutes: number;
  presenceMisses: number;
  note?: string;
}

interface TimesheetTotals {
  activeHours: number;
  idleHours: number;
  breaks: number;
  lunches: number;
  tardyMinutes: number;
  presenceMisses: number;
}

interface TimesheetPeriod {
  label: string;
  range: string;
  days: TimesheetDay[];
  totals: TimesheetTotals;
}

interface RequestItem {
  id: string;
  type: RequestType;
  status: RequestStatus;
  startDate: string;
  endDate?: string | null;
  hours: number;
  reason: string;
  submittedAt: string;
}

interface ScheduleTemplate {
  label: string;
  start: string;
  end: string;
}

interface ScheduleEntry {
  id: string;
  date: string;
  label: string;
  start: string;
  end: string;
  location: string;
  status: 'upcoming' | 'in_progress' | 'completed';
  note?: string;
}

interface ActivityItem {
  id: string;
  timestamp: string;
  message: string;
  category: ActivityCategory;
}

interface TodaySnapshot {
  date: string;
  label: string;
  activeMinutes: number;
  idleMinutes: number;
  breakMinutes: number;
  lunchMinutes: number;
  breaksCount: number;
  lunchCount: number;
  tardyMinutes: number;
  presenceMisses: number;
}

interface SessionState {
  status: SessionStatus;
  startedAt: Date | null;
  breakStartedAt: Date | null;
  lunchStartedAt: Date | null;
  lastPresenceCheck: Date | null;
  nextPresenceCheck: Date;
  lastClockedInAt: Date | null;
  lastClockedOutAt: Date | null;
}

interface AttendanceState {
  user: {
    name: string;
    role: string;
    location: string;
  };
  session: SessionState;
  today: TodaySnapshot;
  timesheet: {
    view: TimesheetView;
    periods: Record<TimesheetView, TimesheetPeriod>;
  };
  requests: RequestItem[];
  schedule: {
    defaults: ScheduleTemplate[];
    upcoming: ScheduleEntry[];
  };
  activity: ActivityItem[];
  makeUpCap: {
    used: number;
    cap: number;
  };
}

interface OverviewTimesheetDay {
  date: string;
  label: string;
  activeHours: number;
  idleHours: number;
  breaks: number;
  lunches: number;
  tardyMinutes?: number;
  presenceMisses?: number;
}

interface OverviewTimesheetPeriod {
  label: string;
  range: string;
  days: OverviewTimesheetDay[];
  totals: {
    activeHours: number;
    idleHours: number;
    breaks: number;
    lunches: number;
    tardyMinutes?: number;
    presenceMisses?: number;
  };
}

interface OverviewRequestItem {
  id: string;
  type: RequestType;
  status: RequestStatus;
  startDate: string;
  endDate?: string | null;
  hours: number;
  reason: string;
  submittedAt: string;
}

interface OverviewResponse {
  user: { id: number; email: string; name: string; role: string; location: string };
  session: {
    id: string | null;
    status: SessionStatus;
    startedAt: string | null;
    breakStartedAt: string | null;
    lunchStartedAt: string | null;
    lastPresenceCheck: string | null;
    nextPresenceCheck: string | null;
    lastClockedInAt: string | null;
    lastClockedOutAt: string | null;
  };
  today: TodaySnapshot;
  timesheet: {
    view: TimesheetView;
    periods: Record<TimesheetView, OverviewTimesheetPeriod>;
  };
  requests: OverviewRequestItem[];
  schedule: {
    defaults: ScheduleTemplate[];
    upcoming: ScheduleEntry[];
  };
  activity: ActivityItem[];
  makeUpCap: { used: number; cap: number };
  meta?: { generatedAt: string; referenceDate: string };
}

const addDays = (date: Date, amount: number) => {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + amount);
  return copy;
};

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE);

const startOfWeek = (date: Date) => {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay();
  const mondayIndex = (day + 6) % 7;
  copy.setDate(copy.getDate() - mondayIndex);
  return copy;
};

const isoDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseIsoDate = (value: string) => new Date(`${value}T00:00:00`);

const formatDayLabel = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);

const formatDateLong = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(date);

const formatMonthLabel = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);

const formatRelative = (date: Date | null) => {
  if (!date) {
    return '—';
  }
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.round(diffMs / MINUTE);
  if (diffMinutes < 1) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`;
  }
  return formatDateLong(date);
};

const formatCountdown = (target: Date | null) => {
  if (!target) {
    return '—';
  }
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) {
    return 'due now';
  }
  const minutes = Math.floor(diffMs / MINUTE);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (remainder === 0) {
      return `${hours} hr${hours === 1 ? '' : 's'}`;
    }
    return `${hours} hr ${remainder} min`;
  }
  return `${minutes} min`;
};

const formatDurationMinutes = (minutes: number) => {
  if (minutes <= 0) {
    return '0m';
  }
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  if (hours === 0) {
    return `${remainder}m`;
  }
  if (remainder === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainder}m`;
};

const formatHours = (hours: number) => {
  const rounded = Math.round(hours * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

const minutesBetween = (start: Date | null, end: Date = new Date()) => {
  if (!start) {
    return 0;
  }
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / MINUTE));
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const createDay = (
  date: Date,
  data: {
    active: number;
    idle: number;
    breaks: number;
    lunches: number;
    presence: number;
    tardy?: number;
    note?: string;
  }
): TimesheetDay => ({
  date: isoDate(date),
  label: formatDayLabel(date),
  activeHours: data.active,
  idleHours: data.idle,
  breaks: data.breaks,
  lunches: data.lunches,
  tardyMinutes: data.tardy ?? 0,
  presenceMisses: data.presence,
  note: data.note
});

interface AppContext {
  baseUrl: string | null;
  deviceId: string | null;
  platform: string;
  email: string | null;
  sessionId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
}

let appContext: AppContext = {
  baseUrl: null,
  deviceId: null,
  platform: navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent,
  email: null,
  sessionId: null,
  accessToken: null,
  refreshToken: null,
  tokenExpiresAt: null
};

let activePromptId: string | null = null;
const presenceUnsubscribers: Array<() => void> = [];

type AuthTokens = {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
  tokenType?: string;
  scope?: string;
};

const clearTokens = () => {
  appContext.accessToken = null;
  appContext.refreshToken = null;
  appContext.tokenExpiresAt = null;
};

const applyTokens = (tokens: AuthTokens) => {
  appContext.accessToken = tokens.accessToken;
  appContext.refreshToken = tokens.refreshToken;
  appContext.tokenExpiresAt = tokens.accessTokenExpiresAt
    ? new Date(tokens.accessTokenExpiresAt)
    : null;
};

const hasValidToken = () => {
  if (!appContext.accessToken) {
    return false;
  }
  if (!appContext.tokenExpiresAt) {
    return true;
  }
  const expiresInMs = appContext.tokenExpiresAt.getTime() - Date.now();
  return expiresInMs > 60_000; // keep a one-minute buffer
};

let authInFlight: Promise<boolean> | null = null;

const authenticate = async (): Promise<boolean> => {
  if (hasValidToken()) {
    return true;
  }

  if (authInFlight) {
    return authInFlight;
  }

  if (!appContext.baseUrl || !appContext.deviceId) {
    showToast('Configure the server connection before syncing with the cloud.', 'warning');
    return false;
  }

  if (!appContext.email) {
    showToast('Add your work email in Settings to sync with the server.', 'warning');
    return false;
  }

  authInFlight = (async () => {
    try {
      const tokens = await postJson<AuthTokens>(
        '/api/sessions/start',
        {
          flow: 'email_only',
          email: appContext.email,
          deviceId: appContext.deviceId
        },
        { requiresAuth: false }
      );
      applyTokens(tokens);
      return true;
    } catch (error) {
      console.error('Authentication failed', error);
      showToast('Unable to authenticate with the attendance server.', 'danger');
      clearTokens();
      return false;
    } finally {
      authInFlight = null;
    }
  })();

  return authInFlight;
};

const registerPresenceListeners = () => {
  presenceUnsubscribers.splice(0).forEach((unsub) => {
    try {
      unsub();
    } catch (error) {
      console.warn('Failed to remove presence listener', error);
    }
  });

  if (!presenceEnabled) {
    return;
  }

  if (window.attendance?.onPresenceWindowConfirm) {
    const unsubscribe = window.attendance.onPresenceWindowConfirm(async (promptId) => {
      activePromptId = promptId;
      const confirmed = await confirmPresencePrompt(promptId);
      if (confirmed) {
        pushActivity('Presence confirmed.', 'presence');
        showToast('Presence confirmed.', 'success');
        logAction('presence_confirm');
        await hydrateFromServer();
      }
    });
    presenceUnsubscribers.push(unsubscribe);
  }

  if (window.attendance?.onPresenceWindowDismiss) {
    const unsubscribe = window.attendance.onPresenceWindowDismiss((promptId) => {
      if (!activePromptId || activePromptId === promptId) {
        activePromptId = null;
      }
      pushActivity('Presence prompt dismissed.', 'presence');
      showToast('Presence prompt dismissed.', 'info');
    });
    presenceUnsubscribers.push(unsubscribe);
  }
};

const recomputeTotals = (days: TimesheetDay[]): TimesheetTotals =>
  days.reduce(
    (totals, day) => {
      totals.activeHours += day.activeHours;
      totals.idleHours += day.idleHours;
      totals.breaks += day.breaks;
      totals.lunches += day.lunches;
      totals.tardyMinutes += day.tardyMinutes;
      totals.presenceMisses += day.presenceMisses;
      return totals;
    },
    { activeHours: 0, idleHours: 0, breaks: 0, lunches: 0, tardyMinutes: 0, presenceMisses: 0 }
  );

const greeting = (date: Date) => {
  const hour = date.getHours();
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 17) {
    return 'Good afternoon';
  }
  return 'Good evening';
};

const requestLabel = (type: RequestType) => {
  switch (type) {
    case 'make_up':
      return 'Make-up hours';
    case 'time_off':
      return 'Time off';
    case 'edit':
      return 'Timesheet edit';
    default:
      return type.replace('_', ' ');
  }
};

const requestStatusClass = (status: RequestStatus) => {
  if (status === 'pending') {
    return 'pill pill--pending';
  }
  if (status === 'approved') {
    return 'pill pill--approved';
  }
  return 'pill pill--denied';
};

const categoryIcon = (category: ActivityCategory) => {
  switch (category) {
    case 'session':
      return '🕑';
    case 'presence':
      return '👋';
    case 'break':
      return '☕';
    case 'lunch':
      return '🍱';
    case 'request':
      return '📝';
    case 'idle':
      return '💤';
    default:
      return '•';
  }
};

const logAction = (action: string) => {
  try {
    window.attendance?.logAction(action);
  } catch (error) {
    console.warn('logAction failed', error);
  }
};

const requireServerContext = () => {
  if (!appContext.baseUrl) {
    throw new Error('Server URL is not configured. Update Settings with a server address.');
  }
  if (!appContext.deviceId) {
    throw new Error('Device identity missing. Relaunch the application.');
  }
};

const postJson = async <T = unknown>(
  path: string,
  body: Record<string, unknown>,
  options: {
    method?: 'POST' | 'PUT' | 'PATCH';
    expectJson?: boolean;
    requiresAuth?: boolean;
    retryOnAuthFailure?: boolean;
  } = {}
): Promise<T> => {
  requireServerContext();
  const {
    method = 'POST',
    expectJson = true,
    requiresAuth = true,
    retryOnAuthFailure = true
  } = options;

  if (requiresAuth) {
    const authed = await authenticate();
    if (!authed) {
      throw new Error('Authentication required');
    }
  }

  const url = new URL(path, appContext.baseUrl!);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (requiresAuth && appContext.accessToken) {
    headers.Authorization = `Bearer ${appContext.accessToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`Network request failed: ${(error as Error).message}`);
  }

  if (response.status === 401 && requiresAuth) {
    clearTokens();
    if (retryOnAuthFailure && (await authenticate())) {
      return postJson(path, body, { method, expectJson, requiresAuth, retryOnAuthFailure: false });
    }
    throw new Error('Authentication failed');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const snippet = text.slice(0, 200);
    throw new Error(`Request failed (${response.status}): ${snippet || response.statusText}`);
  }

  if (!expectJson || response.status === 204) {
    return undefined as unknown as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as unknown as T;
  }
  return JSON.parse(text) as T;
};

const startSessionOnServer = async (): Promise<boolean> => {
  if (!appContext.baseUrl) {
    await hydrateFromServer().catch(() => undefined);
  }
  requireServerContext();
  if (!appContext.email) {
    showToast('Add a work email in Settings before clocking in.', 'warning');
    return false;
  }

  try {
    const result = await postJson<{ sessionId?: string; id?: string }>(
      '/api/sessions/start',
      {
        email: appContext.email,
        deviceId: appContext.deviceId,
        platform: appContext.platform
      },
      { requiresAuth: false }
    );

    const sessionId = result?.sessionId ?? result?.id ?? null;
    if (!sessionId) {
      throw new Error('Missing session identifier in response.');
    }
    appContext.sessionId = sessionId;
    await authenticate();
    return true;
  } catch (error) {
    console.error('Failed to start session', error);
    showToast('Unable to start session on the server.', 'danger');
    return false;
  }
};

const ensureActiveSession = async (): Promise<string | null> => {
  if (appContext.sessionId) {
    return appContext.sessionId;
  }
  const started = await startSessionOnServer();
  return started ? appContext.sessionId : null;
};

const endSessionOnServer = async () => {
  if (!appContext.sessionId) {
    return true;
  }

  try {
    await postJson('/api/sessions/end', { sessionId: appContext.sessionId }, { expectJson: true });
    appContext.sessionId = null;
    return true;
  } catch (error) {
    console.error('Failed to end session', error);
    showToast('Unable to end session on the server.', 'danger');
    return false;
  }
};

const sendSimpleEvent = async (path: string) => {
  const sessionId = await ensureActiveSession();
  if (!sessionId) {
    return false;
  }

  try {
    await postJson(
      `/api/events/${path}`,
      {
        sessionId,
        timestamp: new Date().toISOString()
      },
      { expectJson: false }
    );
    return true;
  } catch (error) {
    console.error(`Failed to send event ${path}`, error);
    showToast('Unable to communicate with the attendance server.', 'danger');
    return false;
  }
};

const confirmPresencePrompt = async (promptId: string) => {
  const sessionId = await ensureActiveSession();
  if (!sessionId) {
    return false;
  }

  try {
    await postJson(
      '/api/events/presence/confirm',
      {
        sessionId,
        promptId,
        timestamp: new Date().toISOString()
      },
      { expectJson: false }
    );
    return true;
  } catch (error) {
    console.error('Failed to confirm presence prompt', error);
    showToast('Unable to confirm presence with the server.', 'danger');
    return false;
  }
};

const showToast = (message: string, variant: 'info' | 'success' | 'warning' | 'danger' = 'success') => {
  const toast = document.getElementById('toast');
  if (!toast) {
    return;
  }
  toast.textContent = message;
  if (variant === 'info') {
    toast.removeAttribute('data-variant');
  } else {
    toast.dataset.variant = variant;
  }
  toast.setAttribute('data-visible', 'true');
  window.setTimeout(() => toast.removeAttribute('data-visible'), 2_500);
};

const now = new Date();
const weekStart = startOfWeek(now);

const weeklyTemplate = [
  { active: 7.8, idle: 0.4, breaks: 2, lunches: 1, presence: 0, tardy: 0, note: 'Floor reset complete.' },
  { active: 7.6, idle: 0.5, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.9, idle: 0.6, breaks: 3, lunches: 1, presence: 1, tardy: 15, note: 'Missed presence check at 2:10 pm.' },
  { active: 8.2, idle: 0.3, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.4, idle: 0.5, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 5.0, idle: 0.7, breaks: 2, lunches: 1, presence: 0, tardy: 0, note: 'Partial shift for inventory count.' },
  { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0, tardy: 0, note: 'Scheduled day off.' }
] as const;

const weeklyDays = weeklyTemplate.map((data, index) => createDay(addDays(weekStart, index), data));

const previousWeekTemplate = [
  { active: 7.5, idle: 0.6, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.9, idle: 0.4, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 8.1, idle: 0.5, breaks: 3, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.7, idle: 0.6, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.3, idle: 0.6, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 4.5, idle: 0.5, breaks: 1, lunches: 1, presence: 0, tardy: 0 },
  { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0, tardy: 0 }
] as const;

const previousWeekStart = addDays(weekStart, -7);
const previousWeekDays = previousWeekTemplate.map((data, index) => createDay(addDays(previousWeekStart, index), data));

const earlyWeekTemplate = [
  { active: 7.2, idle: 0.5, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.8, idle: 0.4, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.6, idle: 0.5, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 8.0, idle: 0.4, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 7.1, idle: 0.6, breaks: 2, lunches: 1, presence: 0, tardy: 0 },
  { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0, tardy: 0 },
  { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0, tardy: 0 }
] as const;

const earlyWeekStart = addDays(previousWeekStart, -7);
const earlyWeekDays = earlyWeekTemplate.map((data, index) => createDay(addDays(earlyWeekStart, index), data));

const payPeriodDays = [...previousWeekDays, ...weeklyDays];
const monthlyDays = [...earlyWeekDays, ...previousWeekDays, ...weeklyDays];

const weeklyPeriod: TimesheetPeriod = {
  label: `${formatDayLabel(parseIsoDate(weeklyDays[0].date))} – ${formatDayLabel(
    parseIsoDate(weeklyDays[weeklyDays.length - 1].date)
  )}`,
  range: `${formatDateLong(parseIsoDate(weeklyDays[0].date))} – ${formatDateLong(
    parseIsoDate(weeklyDays[weeklyDays.length - 1].date)
  )}`,
  days: weeklyDays,
  totals: recomputeTotals(weeklyDays)
};

const payPeriod: TimesheetPeriod = {
  label: `Pay Period ${formatDateLong(parseIsoDate(payPeriodDays[0].date))} – ${formatDateLong(
    parseIsoDate(payPeriodDays[payPeriodDays.length - 1].date)
  )}`,
  range: `${formatDayLabel(parseIsoDate(payPeriodDays[0].date))} – ${formatDayLabel(
    parseIsoDate(payPeriodDays[payPeriodDays.length - 1].date)
  )}`,
  days: payPeriodDays,
  totals: recomputeTotals(payPeriodDays)
};

const monthStart = parseIsoDate(monthlyDays[0].date);
const monthEnd = parseIsoDate(monthlyDays[monthlyDays.length - 1].date);

const monthlyPeriod: TimesheetPeriod = {
  label: `${formatMonthLabel(monthStart)} • ${formatDayLabel(monthStart)} – ${formatDayLabel(monthEnd)}`,
  range: `${formatDateLong(monthStart)} – ${formatDateLong(monthEnd)}`,
  days: monthlyDays,
  totals: recomputeTotals(monthlyDays)
};

const todayIso = isoDate(now);
const todayEntry = weeklyDays.find((day) => day.date === todayIso) ?? weeklyDays[0];

const todaySnapshot: TodaySnapshot = {
  date: todayEntry.date,
  label: todayEntry.label,
  activeMinutes: Math.round(todayEntry.activeHours * 60),
  idleMinutes: Math.round(todayEntry.idleHours * 60),
  breakMinutes: todayEntry.breaks * 10,
  lunchMinutes: todayEntry.lunches > 0 ? todayEntry.lunches * 45 : 0,
  breaksCount: todayEntry.breaks,
  lunchCount: todayEntry.lunches,
  tardyMinutes: todayEntry.tardyMinutes,
  presenceMisses: todayEntry.presenceMisses
};

let state: AttendanceState = {
  user: {
    name: 'Chloe Sanchez',
    role: 'Retail Associate',
    location: 'San Francisco Retail Floor'
  },
  session: {
    status: 'clocked_out',
    startedAt: null,
    breakStartedAt: null,
    lunchStartedAt: null,
    lastPresenceCheck: null,
    nextPresenceCheck: addMinutes(now, 45),
    lastClockedInAt: null,
    lastClockedOutAt: addMinutes(now, -30)
  },
  today: todaySnapshot,
  timesheet: {
    view: 'weekly',
    periods: {
      weekly: weeklyPeriod,
      pay_period: payPeriod,
      monthly: monthlyPeriod
    }
  },
  requests: [
    {
      id: 'req-pto-001',
      type: 'time_off',
      status: 'approved',
      startDate: addDays(now, -3).toISOString(),
      endDate: addDays(now, -2).toISOString(),
      hours: 16,
      reason: 'Family visit in Sacramento.',
      submittedAt: addDays(now, -12).toISOString()
    },
    {
      id: 'req-make-up-002',
      type: 'make_up',
      status: 'pending',
      startDate: addDays(now, 2).toISOString(),
      endDate: addDays(now, 2).toISOString(),
      hours: 3,
      reason: 'Cover for inventory audit.',
      submittedAt: addDays(now, -1).toISOString()
    },
    {
      id: 'req-edit-003',
      type: 'edit',
      status: 'denied',
      startDate: addDays(now, -7).toISOString(),
      endDate: addDays(now, -7).toISOString(),
      hours: 0,
      reason: 'Adjustment already applied by manager.',
      submittedAt: addDays(now, -5).toISOString()
    }
  ],
  schedule: {
    defaults: [
      { label: 'Mon – Fri', start: '09:00', end: '17:30' },
      { label: 'Sat', start: '10:00', end: '18:00' }
    ],
    upcoming: [
      {
        id: 'shift-today',
        date: todayIso,
        label: 'Today',
        start: '09:00',
        end: '17:30',
        location: 'Retail Floor',
        status: 'in_progress',
        note: 'Coverage with Marcus during lunch rush.'
      },
      {
        id: 'shift-tomorrow',
        date: isoDate(addDays(now, 1)),
        label: 'Tomorrow',
        start: '11:00',
        end: '19:30',
        location: 'Outlet – Union Square',
        status: 'upcoming',
        note: 'Swap approved for evening coverage.'
      },
      {
        id: 'shift-weekend',
        date: isoDate(addDays(now, 3)),
        label: formatDayLabel(addDays(now, 3)),
        start: '10:00',
        end: '16:00',
        location: 'Pop-up Kiosk',
        status: 'upcoming'
      },
      {
        id: 'shift-prev',
        date: isoDate(addDays(now, -1)),
        label: 'Yesterday',
        start: '09:30',
        end: '17:00',
        location: 'Retail Floor',
        status: 'completed'
      }
    ]
  },
  activity: [
    {
      id: 'activity-1',
      timestamp: addMinutes(now, -12).toISOString(),
      message: 'Presence check confirmed from desktop app.',
      category: 'presence'
    },
    {
      id: 'activity-2',
      timestamp: addMinutes(now, -38).toISOString(),
      message: 'Lunch ended – 42 minutes.',
      category: 'lunch'
    },
    {
      id: 'activity-3',
      timestamp: addMinutes(now, -96).toISOString(),
      message: 'Break recorded – 10 minutes.',
      category: 'break'
    },
    {
      id: 'activity-4',
      timestamp: addMinutes(now, -150).toISOString(),
      message: 'Idle from 1:55 pm – 2:05 pm (10 minutes).',
      category: 'idle'
    },
    {
      id: 'activity-5',
      timestamp: addMinutes(now, -130).toISOString(),
      message: 'Clocked in from store kiosk.',
      category: 'session'
    },
    {
      id: 'activity-6',
      timestamp: addMinutes(now, -280).toISOString(),
      message: 'Approved time-off request for Oct 3 – Oct 4.',
      category: 'request'
    }
  ],
  makeUpCap: {
    used: 6,
    cap: 20
  }
};

let presenceEnabled = false;
let presenceButtonListenerAttached = false;
const applyPresenceVisibility = () => {
  if (dom.presenceButton) {
    if (presenceEnabled) {
      if (!presenceButtonListenerAttached) {
        dom.presenceButton.addEventListener('click', handlePresence);
        presenceButtonListenerAttached = true;
      }
      dom.presenceButton.hidden = false;
      dom.presenceButton.style.removeProperty('display');
      dom.presenceButton.removeAttribute('aria-hidden');
      dom.presenceButton.removeAttribute('tabindex');
    } else {
      if (presenceButtonListenerAttached) {
        dom.presenceButton.removeEventListener('click', handlePresence);
        presenceButtonListenerAttached = false;
      }
      dom.presenceButton.hidden = true;
      dom.presenceButton.style.display = 'none';
      dom.presenceButton.setAttribute('aria-hidden', 'true');
      dom.presenceButton.setAttribute('tabindex', '-1');
    }
  }

  if (dom.heroPresence) {
    if (presenceEnabled) {
      dom.heroPresence.hidden = false;
      dom.heroPresence.style.removeProperty('display');
      dom.heroPresence.removeAttribute('aria-hidden');
      renderHero();
    } else {
      dom.heroPresence.textContent = '';
      dom.heroPresence.hidden = true;
      dom.heroPresence.style.display = 'none';
      dom.heroPresence.setAttribute('aria-hidden', 'true');
    }
  }
};
const HERO_AVATAR_OVERTIME_THRESHOLD_MINUTES = 9 * 60;

const MOTIVATION_PHRASES = [
  "Let’s have a fantastic day!",
  'Today is going to be even better than tomorrow.',
  'Small steps every day lead to big success.',
  'Your focus today builds your future.',
  'Progress, not perfection.',
  'Choose positivity and the rest will follow.',
  'Make today count — it’s a fresh start.',
  'Consistency beats intensity.',
  'A little progress each day adds up to big results.',
  'Your hard work today is tomorrow’s reward.'
] as const;

const HERO_SUBTITLE_FALLBACK = MOTIVATION_PHRASES[0];

const getDailyMotivation = (date: Date = new Date()): string => {
  const millisInDay = 86_400_000;
  const daysSinceEpoch = Math.floor(date.getTime() / millisInDay);
  const index = ((daysSinceEpoch % MOTIVATION_PHRASES.length) + MOTIVATION_PHRASES.length) % MOTIVATION_PHRASES.length;
  return MOTIVATION_PHRASES[index] ?? HERO_SUBTITLE_FALLBACK;
};

const dom = {
  heroAvatar: document.getElementById('hero-avatar') as HTMLDivElement | null,
  heroTitle: document.getElementById('hero-title')!,
  heroSubtitle: document.getElementById('hero-subtitle')!,
  heroStatus: document.getElementById('hero-status')!,
  heroDuration: document.getElementById('hero-duration')!,
  heroPresence: document.getElementById('hero-presence')!,
  clockToggle: document.getElementById('clock-toggle') as HTMLButtonElement,
  breakToggle: document.getElementById('break-toggle') as HTMLButtonElement,
  lunchToggle: document.getElementById('lunch-toggle') as HTMLButtonElement,
  presenceButton: document.getElementById('presence-button') as HTMLButtonElement | null,
  downloadButton: document.getElementById('download-report') as HTMLButtonElement,
  snapshotLabel: document.getElementById('snapshot-label')!,
  statsList: document.getElementById('stats-list')!,
  timesheetLabel: document.getElementById('timesheet-label')!,
  timesheetBody: document.getElementById('timesheet-body')!,
  timesheetView: document.getElementById('timesheet-view') as HTMLSelectElement,
  requestList: document.getElementById('request-list')!,
  requestForm: document.getElementById('request-form') as HTMLFormElement,
  requestType: document.getElementById('request-type') as HTMLSelectElement,
  requestHours: document.getElementById('request-hours') as HTMLInputElement,
  requestStartDate: document.getElementById('request-start-date') as HTMLInputElement,
  requestEndDate: document.getElementById('request-end-date') as HTMLInputElement,
  requestReason: document.getElementById('request-reason') as HTMLTextAreaElement,
  requestHint: document.getElementById('request-hint')!,
  scheduleList: document.getElementById('schedule-list')!,
  activityList: document.getElementById('activity-list')!,
  makeupProgress: document.getElementById('makeup-progress')!
};

let heroAvatarImg: HTMLImageElement | null = null;
let currentHeroAvatarStatus: HeroAvatarStatus | null = null;

const ensureHeroAvatarImage = () => {
  if (!dom.heroAvatar) {
    return null;
  }
  if (!heroAvatarImg) {
    heroAvatarImg = document.createElement('img');
    heroAvatarImg.alt = '';
    heroAvatarImg.decoding = 'async';
    heroAvatarImg.loading = 'eager';
    dom.heroAvatar.appendChild(heroAvatarImg);
  }
  return heroAvatarImg;
};

const updateHeroAvatarForStatus = (status: HeroAvatarStatus) => {
  if (!dom.heroAvatar) {
    return;
  }

  if (currentHeroAvatarStatus === status) {
    return;
  }

  const image = ensureHeroAvatarImage();
  if (!image) {
    return;
  }

  currentHeroAvatarStatus = status;
  const { primary, fallback } = resolveHeroAvatarPaths(status);
  const candidates = Array.from(new Set([primary, fallback]));
  let attempt = 0;

  const attemptLoad = () => {
    if (attempt >= candidates.length) {
      if (!image.src) {
        dom.heroAvatar?.classList.remove('hero__avatar--visible');
        dom.heroAvatar?.setAttribute('aria-hidden', 'true');
      }
      return;
    }

    const candidate = candidates[attempt];
    const probe = new Image();
    probe.decoding = 'async';
    probe.onload = () => {
      image.src = candidate;
      image.dataset.status = status;
      dom.heroAvatar?.classList.add('hero__avatar--visible');
      dom.heroAvatar?.setAttribute('aria-hidden', 'false');
    };
    probe.onerror = () => {
      attempt += 1;
      attemptLoad();
    };
    probe.src = candidate;
  };

  attemptLoad();
};

const initializeHeroAvatar = () => {
  if (!dom.heroAvatar) {
    return;
  }
  dom.heroAvatar.setAttribute('aria-hidden', 'true');
  ensureHeroAvatarImage();
};

initializeHeroAvatar();

const initializeHeroSubtitle = () => {
  if (!dom.heroSubtitle) {
    return;
  }
  dom.heroSubtitle.textContent = getDailyMotivation();
};

initializeHeroSubtitle();


dom.timesheetView.value = state.timesheet.view;

const resolveHeroAvatarStatus = (): HeroAvatarStatus => {
  if (state.session.status === 'clocked_out') {
    return 'ClockedOut';
  }

  if (state.session.status === 'break') {
    return 'OnBreak';
  }

  if (state.session.status === 'lunch') {
    return 'OnLunch';
  }

  if (state.session.status === 'working') {
    if (state.today.presenceMisses > 0) {
      return 'PresenceMissed';
    }

    const nextPresence = state.session.nextPresenceCheck;
    if (nextPresence && nextPresence.getTime() <= Date.now()) {
      return 'PresenceDue';
    }

    if (state.today.activeMinutes >= HERO_AVATAR_OVERTIME_THRESHOLD_MINUTES) {
      return 'Overtime';
    }

    return 'Working';
  }

  return 'Working';
};

const updateTimesheetFromToday = () => {
  const hours = state.today.activeMinutes / 60;
  const idleHours = state.today.idleMinutes / 60;
  (Object.values(state.timesheet.periods) as TimesheetPeriod[]).forEach((period) => {
    const day = period.days.find((entry) => entry.date === state.today.date);
    if (day) {
      day.activeHours = Math.round(hours * 100) / 100;
      day.idleHours = Math.round(idleHours * 100) / 100;
      day.breaks = state.today.breaksCount;
      day.lunches = state.today.lunchCount;
      day.tardyMinutes = state.today.tardyMinutes;
      day.presenceMisses = state.today.presenceMisses;
      period.totals = recomputeTotals(period.days);
    }
  });
};

const renderHero = () => {
  dom.heroTitle.textContent = `${greeting(new Date())}, ${state.user.name}`;
  dom.heroStatus.textContent =
    state.session.status === 'working'
      ? 'Working'
      : state.session.status === 'break'
      ? 'On Break'
      : state.session.status === 'lunch'
      ? 'At Lunch'
      : 'Clocked Out';

  updateHeroAvatarForStatus(resolveHeroAvatarStatus());

  const duration = (() => {
    switch (state.session.status) {
      case 'working':
        return `Working for ${formatDurationMinutes(minutesBetween(state.session.startedAt))}`;
      case 'break':
        return `On break for ${formatDurationMinutes(minutesBetween(state.session.breakStartedAt))}`;
      case 'lunch':
        return `On lunch for ${formatDurationMinutes(minutesBetween(state.session.lunchStartedAt))}`;
      default:
        return state.session.lastClockedOutAt
          ? `Last clock out ${formatRelative(state.session.lastClockedOutAt)}`
          : 'No session yet';
    }
  })();

  dom.heroDuration.textContent = duration;
  if (presenceEnabled) {
    dom.heroPresence.textContent = `Presence check in ${formatCountdown(
      state.session.status === 'clocked_out' ? null : state.session.nextPresenceCheck
    )}`;
    dom.heroPresence.hidden = false;
    dom.heroPresence.style.removeProperty('display');
    dom.heroPresence.removeAttribute('aria-hidden');
  } else {
    dom.heroPresence.textContent = '';
  }
};

const renderSnapshot = () => {
  dom.snapshotLabel.textContent = `${state.today.label} • ${state.user.location}`;
  dom.makeupProgress.textContent = `${state.makeUpCap.used} / ${state.makeUpCap.cap} make-up hours used`;
  dom.makeupProgress.title = `${Math.max(state.makeUpCap.cap - state.makeUpCap.used, 0)} hours remaining this month`;

  const stats = [
    {
      label: 'Active hours',
      value: formatHours(state.today.activeMinutes / 60),
      meta: `Idle ${formatHours(state.today.idleMinutes / 60)} h`
    },
    {
      label: 'Break time',
      value: formatDurationMinutes(state.today.breakMinutes),
      meta: `${state.today.breaksCount} break${state.today.breaksCount === 1 ? '' : 's'}`
    },
    {
      label: 'Lunch',
      value: formatDurationMinutes(state.today.lunchMinutes),
      meta: state.today.lunchCount ? `${state.today.lunchCount} lunch` : 'No lunch logged'
    }
  ];

  dom.statsList.innerHTML = stats
    .map(
      (item) => `
        <div class="stats__item">
          <span class="stats__label">${escapeHtml(item.label)}</span>
          <span class="stats__value">${escapeHtml(item.value)}</span>
          <span class="stats__meta">${escapeHtml(item.meta)}</span>
        </div>
      `
    )
    .join('\n');
};

const renderTimesheet = () => {
  const period = state.timesheet.periods[state.timesheet.view];
  dom.timesheetLabel.textContent = period.label;

  dom.timesheetBody.innerHTML = period.days
    .map((day) => {
      const noteRow = day.note ? `<div class="form-hint">${escapeHtml(day.note)}</div>` : '';
      const tardyValue = `${day.tardyMinutes}`;
      return `
        <tr>
          <td>
            <div>${escapeHtml(day.label)}</div>
            ${noteRow}
          </td>
          <td>${escapeHtml(formatHours(day.activeHours))}</td>
          <td>${escapeHtml(formatHours(day.idleHours))}</td>
          <td>${day.breaks}</td>
          <td>${day.lunches}</td>
          <td>${escapeHtml(tardyValue)}</td>
        </tr>
      `;
    })
    .join('\n');
};

const renderRequests = () => {
  const items = state.requests
    .slice()
    .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
    .map((request) => {
      const start = new Date(request.startDate);
      const end = request.endDate ? new Date(request.endDate) : start;
      const rangeLabel = start.getTime() === end.getTime()
        ? formatDateLong(start)
        : `${formatDateLong(start)} – ${formatDateLong(end)}`;
      const hoursLabel = request.hours ? `${request.hours}h` : '—';
      return `
        <li class="list__item">
          <div class="list__headline">${escapeHtml(requestLabel(request.type))}</div>
          <div class="list__meta">
            <span class="${requestStatusClass(request.status)}">${escapeHtml(request.status)}</span>
            <span>${escapeHtml(rangeLabel)}</span>
            <span>${escapeHtml(hoursLabel)}</span>
            <span>${escapeHtml(formatRelative(new Date(request.submittedAt)))}</span>
          </div>
          <p class="form-hint">${escapeHtml(request.reason)}</p>
        </li>
      `;
    });

  dom.requestList.innerHTML = items.join('') || '<li class="form-hint">No requests submitted yet.</li>';
  const remaining = Math.max(state.makeUpCap.cap - state.makeUpCap.used, 0);
  dom.requestHint.textContent = `${state.makeUpCap.used} of ${state.makeUpCap.cap} make-up hours used this month • ${remaining} remaining.`;
};

const renderSchedule = () => {
  const defaults = state.schedule.defaults
    .map(
      (entry) => `
        <li class="schedule__item">
          <div>
            <strong>${escapeHtml(entry.label)}</strong>
            <div class="schedule__meta">Default • ${escapeHtml(entry.start)} – ${escapeHtml(entry.end)}</div>
          </div>
          <span class="pill">Default</span>
        </li>
      `
    )
    .join('\n');

  const shifts = state.schedule.upcoming
    .slice()
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((entry) => {
      const timeLabel = `${entry.start} – ${entry.end}`;
      const statusClass =
        entry.status === 'completed' ? 'pill pill--approved' : entry.status === 'in_progress' ? 'pill pill--pending' : 'pill';
      const noteRow = entry.note ? `<div class="schedule__meta">${escapeHtml(entry.note)}</div>` : '';
      return `
        <li class="schedule__item">
          <div>
            <strong>${escapeHtml(entry.label)}</strong>
            <div class="schedule__meta">${escapeHtml(timeLabel)} • ${escapeHtml(entry.location)}</div>
            ${noteRow}
          </div>
          <span class="${statusClass}">${escapeHtml(entry.status.replace('_', ' '))}</span>
        </li>
      `;
    })
    .join('\n');

  dom.scheduleList.innerHTML = defaults + shifts;
};

const renderActivity = () => {
  dom.activityList.innerHTML = state.activity
    .slice()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10)
    .map(
      (item) => `
        <li class="timeline__item">
          <span class="timeline__label">${categoryIcon(item.category)} ${escapeHtml(item.message)}</span>
          <span class="timeline__time">${escapeHtml(formatRelative(new Date(item.timestamp)))}</span>
        </li>
      `
    )
    .join('\n');
};

const updateControls = () => {
  dom.clockToggle.textContent = state.session.status === 'clocked_out' ? 'Clock In' : 'Clock Out';
  dom.breakToggle.textContent = state.session.status === 'break' ? 'End Break' : 'Start Break';
  dom.lunchToggle.textContent = state.session.status === 'lunch' ? 'End Lunch' : 'Start Lunch';

  const disabled = state.session.status === 'clocked_out';
  dom.breakToggle.disabled = disabled;
  dom.lunchToggle.disabled = disabled;
  if (dom.presenceButton) {
    dom.presenceButton.disabled = true;
  }
};

const pushActivity = (message: string, category: ActivityCategory) => {
  state.activity.unshift({
    id: `activity-${Date.now()}`,
    timestamp: new Date().toISOString(),
    message,
    category
  });
  state.activity = state.activity.slice(0, 20);
  renderActivity();
};

const render = () => {
  renderHero();
  renderSnapshot();
  renderTimesheet();
  renderRequests();
  renderSchedule();
  renderActivity();
  updateControls();
};

const completeBreakIfNeeded = () => {
  if (state.session.status === 'break' && state.session.breakStartedAt) {
    const minutes = minutesBetween(state.session.breakStartedAt);
    state.today.breakMinutes += minutes;
    state.today.breaksCount += 1;
    state.session.breakStartedAt = null;
    pushActivity(`Break ended (${formatDurationMinutes(minutes)})`, 'break');
    logAction('break_end');
  }
};

const completeLunchIfNeeded = () => {
  if (state.session.status === 'lunch' && state.session.lunchStartedAt) {
    const minutes = minutesBetween(state.session.lunchStartedAt);
    state.today.lunchMinutes += minutes;
    state.today.lunchCount += 1;
    state.session.lunchStartedAt = null;
    pushActivity(`Lunch ended (${formatDurationMinutes(minutes)})`, 'lunch');
    logAction('lunch_end');
  }
};

const handleClockToggle = async () => {
  if (state.session.status === 'clocked_out') {
    const started = await startSessionOnServer();
    if (!started) {
      return;
    }
    state.session.status = 'working';
    state.session.startedAt = new Date();
    state.session.lastClockedInAt = state.session.startedAt;
    state.session.nextPresenceCheck = addMinutes(state.session.startedAt, 45);
    pushActivity('Clocked in', 'session');
    showToast('Clocked in. Have a great shift!', 'success');
    logAction('clock_in');
  } else {
    if (state.session.status === 'break') {
      const ended = await sendSimpleEvent('break/end');
      if (!ended) {
        return;
      }
      completeBreakIfNeeded();
    }
    if (state.session.status === 'lunch') {
      const ended = await sendSimpleEvent('lunch/end');
      if (!ended) {
        return;
      }
      completeLunchIfNeeded();
    }

    const minutes = minutesBetween(state.session.startedAt);
    if (minutes > 0) {
      state.today.activeMinutes += minutes;
    }
    const ended = await endSessionOnServer();
    if (!ended) {
      return;
    }
    state.session.status = 'clocked_out';
    state.session.lastClockedOutAt = new Date();
    state.session.startedAt = null;
    showToast('Clocked out. Rest well!', 'info');
    pushActivity('Clocked out', 'session');
    logAction('clock_out');
  }
  updateTimesheetFromToday();
  render();
  void hydrateFromServer();
};

const handleBreakToggle = async () => {
  if (state.session.status === 'clocked_out') {
    showToast('Clock in before starting a break.', 'warning');
    return;
  }
  if (state.session.status === 'break') {
    const ended = await sendSimpleEvent('break/end');
    if (!ended) {
      return;
    }
    completeBreakIfNeeded();
    state.session.status = 'working';
  } else {
    if (!(await ensureActiveSession())) {
      return;
    }
    if (state.session.status === 'lunch') {
      const lunchEnded = await sendSimpleEvent('lunch/end');
      if (!lunchEnded) {
        return;
      }
      completeLunchIfNeeded();
    }
    const started = await sendSimpleEvent('break/start');
    if (!started) {
      return;
    }
    state.session.status = 'break';
    state.session.breakStartedAt = new Date();
    pushActivity('Break started', 'break');
    showToast('Enjoy your break.', 'success');
    logAction('break_start');
  }
  updateTimesheetFromToday();
  render();
  void hydrateFromServer();
};

const handleLunchToggle = async () => {
  if (state.session.status === 'clocked_out') {
    showToast('Clock in before starting lunch.', 'warning');
    return;
  }
  if (state.session.status === 'lunch') {
    const ended = await sendSimpleEvent('lunch/end');
    if (!ended) {
      return;
    }
    completeLunchIfNeeded();
    state.session.status = 'working';
  } else {
    if (!(await ensureActiveSession())) {
      return;
    }
    if (state.session.status === 'break') {
      const breakEnded = await sendSimpleEvent('break/end');
      if (!breakEnded) {
        return;
      }
      completeBreakIfNeeded();
    }
    const started = await sendSimpleEvent('lunch/start');
    if (!started) {
      return;
    }
    state.session.status = 'lunch';
    state.session.lunchStartedAt = new Date();
    pushActivity('Lunch started', 'lunch');
    showToast('Lunch started.', 'success');
    logAction('lunch_start');
  }
  updateTimesheetFromToday();
  render();
  void hydrateFromServer();
};

const handlePresence = async () => {
  if (!presenceEnabled) {
    return;
  }
  if (state.session.status === 'clocked_out') {
    showToast('Start a session before confirming presence.', 'warning');
    return;
  }
  if (activePromptId) {
    const confirmed = await confirmPresencePrompt(activePromptId);
    if (!confirmed) {
      return;
    }
    activePromptId = null;
  }
  state.session.lastPresenceCheck = new Date();
  state.session.nextPresenceCheck = addMinutes(state.session.lastPresenceCheck, 45);
  state.today.presenceMisses = Math.max(0, state.today.presenceMisses - 1);
  pushActivity('Presence confirmed', 'presence');
  showToast('Presence confirmed.', 'success');
  logAction('presence_confirm');
  updateTimesheetFromToday();
  render();
  void hydrateFromServer();
};

const handleRequestSubmit = async (event: SubmitEvent) => {
  event.preventDefault();
  const type = dom.requestType.value as RequestType;
  const hours = Number(dom.requestHours.value) || 0;
  if (hours <= 0) {
    showToast('Enter a positive number of hours.', 'warning');
    return;
  }
  const startDateValue = dom.requestStartDate.value;
  const endDateValue = dom.requestEndDate.value;
  const reason = dom.requestReason.value.trim();
  if (!reason) {
    showToast('Share a short reason for the request.', 'warning');
    return;
  }
  if (!startDateValue) {
    showToast('Choose a start date for the request.', 'warning');
    return;
  }
  if (endDateValue && endDateValue < startDateValue) {
    showToast('End date cannot be before start date.', 'warning');
    return;
  }
  if (!appContext.email || !appContext.deviceId) {
    showToast('Update Settings with your work email before submitting requests.', 'warning');
    return;
  }

  const submittedAt = new Date();
  if (!(await authenticate())) {
    return;
  }
  try {
    await postJson(
      '/api/time-requests',
      {
        type,
        startDate: startDateValue,
        endDate: endDateValue || undefined,
        hours,
        reason,
        email: appContext.email,
        deviceId: appContext.deviceId
      }
    );
  } catch (error) {
    console.error('Failed to submit request', error);
    showToast('Unable to submit request right now.', 'danger');
    return;
  }

  const request: RequestItem = {
    id: `req-${Date.now()}`,
    type,
    status: 'pending',
    startDate: new Date(startDateValue).toISOString(),
    endDate: endDateValue ? new Date(endDateValue).toISOString() : null,
    hours,
    reason,
    submittedAt: submittedAt.toISOString()
  };

  state.requests.unshift(request);
  if (type === 'make_up') {
    state.makeUpCap.used = Math.min(state.makeUpCap.cap, Math.round((state.makeUpCap.used + hours) * 100) / 100);
  }

  dom.requestForm.reset();
  dom.requestHours.value = '1';
  showToast('Request submitted.', 'success');
  pushActivity(`Submitted ${requestLabel(type)}`, 'request');
  renderRequests();
  renderSnapshot();
  logAction('request_submit');
  void hydrateFromServer();
};

const handleTimesheetChange = () => {
  state.timesheet.view = dom.timesheetView.value as TimesheetView;
  renderTimesheet();
};

const handleDownload = () => {
  const period = state.timesheet.periods[state.timesheet.view];
  const header = ['Date', 'Active Hours', 'Idle Hours', 'Breaks', 'Lunches', 'Tardy (m)', 'Note'];
  const rows = period.days.map((day) => [
    day.label,
    formatHours(day.activeHours),
    formatHours(day.idleHours),
    `${day.breaks}`,
    `${day.lunches}`,
    `${day.tardyMinutes}`,
    day.note ?? ''
  ]);

  const csv = [header, ...rows]
    .map((line) => line.map((value) => `"${value.replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const slug = period.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  link.download = `timesheet-${slug}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Timesheet exported.', 'info');
};

const parseDateOrNull = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

const mapOverviewPeriod = (period: OverviewTimesheetPeriod): TimesheetPeriod => ({
  label: period.label,
  range: period.range,
  days: period.days.map((day) => ({
    date: day.date,
    label: day.label,
    activeHours: day.activeHours,
    idleHours: day.idleHours,
    breaks: day.breaks,
    lunches: day.lunches,
    tardyMinutes: day.tardyMinutes ?? day.presenceMisses ?? 0,
    presenceMisses: day.presenceMisses ?? 0,
    note: undefined
  })),
  totals: {
    activeHours: period.totals.activeHours,
    idleHours: period.totals.idleHours,
    breaks: period.totals.breaks,
    lunches: period.totals.lunches,
    tardyMinutes: period.totals.tardyMinutes ?? period.totals.presenceMisses ?? 0,
    presenceMisses: period.totals.presenceMisses ?? 0
  }
});

const applyOverview = (overview: OverviewResponse) => {
  const previousView = state.timesheet.view;
  const periods: Record<TimesheetView, TimesheetPeriod> = {
    weekly: mapOverviewPeriod(overview.timesheet.periods.weekly),
    pay_period: mapOverviewPeriod(overview.timesheet.periods.pay_period),
    monthly: mapOverviewPeriod(overview.timesheet.periods.monthly)
  };

  const resolvedView = periods[previousView] ? previousView : overview.timesheet.view;

  const startedAt = parseDateOrNull(overview.session.startedAt);
  const breakStartedAt = parseDateOrNull(overview.session.breakStartedAt);
  const lunchStartedAt = parseDateOrNull(overview.session.lunchStartedAt);
  const lastPresenceCheck = parseDateOrNull(overview.session.lastPresenceCheck);
  const lastClockedInAt = parseDateOrNull(overview.session.lastClockedInAt);
  const lastClockedOutAt = parseDateOrNull(overview.session.lastClockedOutAt);
  const nextPresenceRaw = parseDateOrNull(overview.session.nextPresenceCheck);
  const presenceAnchor = lastPresenceCheck ?? startedAt ?? lastClockedInAt;
  const nextPresenceCheck = nextPresenceRaw ?? (presenceAnchor ? addMinutes(presenceAnchor, 45) : addMinutes(new Date(), 45));

  state = {
    user: {
      name: overview.user.name,
      role: overview.user.role,
      location: overview.user.location
    },
    session: {
      status: overview.session.status,
      startedAt,
      breakStartedAt,
      lunchStartedAt,
      lastPresenceCheck,
      nextPresenceCheck,
      lastClockedInAt,
      lastClockedOutAt
    },
    today: { ...overview.today },
    timesheet: {
      view: resolvedView,
      periods
    },
    requests: overview.requests.map((request) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      startDate: request.startDate,
      endDate: request.endDate ?? null,
      hours: request.hours,
      reason: request.reason,
      submittedAt: request.submittedAt
    })),
    schedule: {
      defaults: overview.schedule.defaults.slice(),
      upcoming: overview.schedule.upcoming.slice()
    },
    activity: overview.activity.slice(),
    makeUpCap: { ...overview.makeUpCap }
  };

  state.today.tardyMinutes = state.today.tardyMinutes ?? (state.today.presenceMisses ?? 0);
  state.today.presenceMisses = state.today.presenceMisses ?? 0;

  appContext.sessionId = overview.session.id;

  dom.timesheetView.value = state.timesheet.view;
  updateTimesheetFromToday();
  render();
  showToast('Synced with attendance server.', 'info');
};

const fetchOverview = async (baseUrl: string, email: string): Promise<OverviewResponse> => {
  const url = new URL('/api/app/overview', baseUrl);
  url.searchParams.set('email', email);

  const response = await fetch(url.toString(), { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Overview request failed with status ${response.status}`);
  }
  return (await response.json()) as OverviewResponse;
};

const hydrateFromServer = async () => {
  try {
    const [bootstrap, settings] = await Promise.all([
      window.attendance.getBootstrap(),
      window.attendance.getSettings()
    ]);

    presenceEnabled = Boolean(bootstrap.presenceEnabled ?? true);
    applyPresenceVisibility();
    registerPresenceListeners();

    const email = settings.workEmail;
    if (!email) {
      showToast('Add your work email in Settings to load live data.', 'warning');
      return;
    }

    const baseUrl = settings.serverBaseUrl || bootstrap.baseUrl;
    appContext = {
      baseUrl,
      deviceId: bootstrap.deviceId,
      platform: bootstrap.platform ?? appContext.platform,
      email,
      sessionId: appContext.sessionId
    };

    await authenticate();

    const overview = await fetchOverview(baseUrl, email);
    applyOverview(overview);
  } catch (error) {
    console.error('Failed to hydrate from server', error);
    showToast('Unable to load the latest data from the server.', 'danger');
  }
};

const initialize = () => {
  updateTimesheetFromToday();
  applyPresenceVisibility();
  render();

  dom.clockToggle.addEventListener('click', handleClockToggle);
  dom.breakToggle.addEventListener('click', handleBreakToggle);
  dom.lunchToggle.addEventListener('click', handleLunchToggle);
  dom.requestForm.addEventListener('submit', handleRequestSubmit);
  dom.timesheetView.addEventListener('change', handleTimesheetChange);
  dom.downloadButton.addEventListener('click', handleDownload);

  registerPresenceListeners();

  window.setInterval(renderHero, 30_000);
  window.addEventListener('focus', renderHero);

  void hydrateFromServer();
};

initialize();

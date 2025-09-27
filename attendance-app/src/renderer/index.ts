import {
  applyPauseUpdate,
  buildPauseState,
  computePauseDuration as computePauseDurationHelper,
  formatPauseLabel,
  type PauseAction,
  type PauseApiPayload,
  type PauseKind,
  type PauseRecord,
  type PauseSnapshot,
  type PauseState
} from './pauseLogic';

const HEARTBEAT_INTERVAL_MS = 60_000;
const IDLE_THRESHOLD_SECONDS = 10 * 60; // 10 minutes
const PRESENCE_CONFIRMATION_WINDOW_MS = 60_000;
const ACTIVITY_HISTORY_MINUTES = 10;

interface ApiRequest<TResponse = unknown> {
  path: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  requiresAuth?: boolean;
  description?: string;
  tokenOverride?: string | null;
  transform?: (data: unknown) => TResponse;
}

class ApiError extends Error {
  status?: number;
  body?: unknown;
  requestId?: string;

  constructor(message: string, status?: number, body?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

class ApiClient {
  private token: string | null = null;

  constructor(private baseUrl: string) {}

  setToken(token: string | null) {
    this.token = token;
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  getToken() {
    return this.token;
  }

  async request<TResponse = unknown>(request: ApiRequest<TResponse>): Promise<TResponse> {
    const { path, method = 'POST', body, requiresAuth = false, tokenOverride, transform } = request;
    const normalizedMethod = method.toUpperCase() as typeof method;
    const isGetRequest = normalizedMethod === 'GET';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const requestId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `req_${Math.random().toString(36).slice(2, 10)}`);
    headers['X-Debug-Req'] = requestId;

    const authToken = requiresAuth ? tokenOverride ?? this.token : null;
    if (requiresAuth && !authToken) {
      throw new ApiError('No authentication token available');
    }

    if (requiresAuth && authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    if (isGetRequest) {
      headers['Cache-Control'] = 'no-cache';
      headers.Pragma = 'no-cache';
    }

    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'if-none-match') {
        delete headers[key];
      }
    }

    const stringify = (payload: unknown) => {
      if (payload === undefined || payload === null) {
        return '';
      }
      try {
        const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return raw.length > 1024 ? `${raw.slice(0, 1024)}…` : raw;
      } catch (error) {
        return `[unserializable:${(error as Error).message}]`;
      }
    };

    const executeFetch = async (attempt: number): Promise<Response> => {
      const url = new URL(path, this.baseUrl);
      if (isGetRequest) {
        url.searchParams.set('_t', Date.now().toString());
      }

      const fetchHeaders = { ...headers };
      const requestInit: RequestInit = { method: normalizedMethod, headers: fetchHeaders };
      if (isGetRequest) {
        requestInit.cache = attempt === 0 ? 'no-store' : 'reload';
      }
      if (body !== undefined) {
        requestInit.body = JSON.stringify(body);
      }

      console.info('[api]', {
        phase: 'request',
        attempt: attempt + 1,
        method: normalizedMethod,
        url: url.toString(),
        requestId,
        body: attempt === 0 ? stringify(body) : undefined
      });

      try {
        return await fetch(url.toString(), requestInit);
      } catch (error) {
        console.error('[api]', {
          phase: 'network_error',
          method: normalizedMethod,
          url: url.toString(),
          requestId,
          message: (error as Error).message
        });
        recordRequestTrace({ requestId, url: url.toString(), status: -1 });
        throw new ApiError((error as Error).message, undefined, undefined, requestId);
      }
    };

    let response = await executeFetch(0);

    if (response.status === 304 && isGetRequest) {
      console.warn('[api]', {
        phase: 'not_modified_retry',
        method: normalizedMethod,
        path,
        requestId
      });
      response = await executeFetch(1);
    }

    // Treat 204 No Content as a successful response with no body
    if (response.status === 204) {
      console.info('[api]', {
        phase: 'response',
        method: normalizedMethod,
        path,
        status: 204,
        requestId
      });
      recordRequestTrace({ requestId, url: new URL(path, this.baseUrl).toString(), status: 204 });
      return undefined;
    }

    if (!response.ok) {
      let errorBody: unknown = null;
      let snippet = '';
      try {
        const raw = await response.text();
        snippet = stringify(raw);
        const contentType = response.headers.get('content-type');
        errorBody = contentType && contentType.includes('application/json') ? JSON.parse(raw) : raw;
      } catch (error) {
        errorBody = (error as Error).message;
        snippet = stringify(errorBody);
      }

      console.warn('[api]', {
        phase: 'response_error',
        method: normalizedMethod,
        path,
        status: response.status,
        requestId,
        body: snippet
      });

      recordRequestTrace({ requestId, url: `${this.baseUrl}${path}`, status: response.status });

      throw new ApiError(`Request failed with status ${response.status}`, response.status, errorBody, requestId);
    }

    const contentType = response.headers.get('content-type');
    let data: unknown;
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    const serverDateHeader = response.headers.get('date');
    processServerDateHeader(serverDateHeader, requestId);

    console.info('[api]', {
      phase: 'response',
      method: normalizedMethod,
      path,
      status: response.status,
      requestId
    });

    recordRequestTrace({ requestId, url: `${this.baseUrl}${path}`, status: response.status });

    return transform ? transform(data) : (data as TResponse);
  }
}

// Manual test tip: stub global fetch so the first call returns a 304 and the second a 200,
// then assert request() resolves with the retry payload to cover the 304 retry path.

type AuthTokens = {
  tokenType: string;
  scope: string;
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
};

type QueueEntry = QueueItem;

type QueuedRequest = ApiRequest & {
  attempt: number;
  nextAttemptAt: number;
  tokenOverride?: string | null;
};

type TimeRequest = {
  id?: string;
  type: string;
  startDate: string;
  endDate?: string | null;
  hours: number;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | string;
  createdAt?: string;
};

type TimesheetView = 'weekly' | 'pay_period' | 'monthly';

type TimesheetTotals = {
  activeMinutes: number;
  activeHours: number;
  idleMinutes: number;
  idleHours: number;
  breaks: number;
  lunches: number;
  presenceMisses: number;
};

type TimesheetEditRequest = {
  id: string;
  status: 'pending' | 'approved' | 'denied' | string;
  targetDate: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
  requestedMinutes: number | null;
  adminNote: string | null;
  reviewedAt: string | null;
};

type TimesheetDay = {
  date: string;
  label: string;
  activeMinutes: number;
  idleMinutes: number;
  breaks: number;
  lunches: number;
  presenceMisses: number;
  editRequests: TimesheetEditRequest[];
};

type TimesheetSummary = {
  view: TimesheetView;
  label: string;
  rangeStart: string;
  rangeEnd: string;
  rangeStartLabel: string;
  rangeEndLabel: string;
  totals: TimesheetTotals;
  days: TimesheetDay[];
  editRequests: TimesheetEditRequest[];
};

class OfflineQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private hydrated = false;

  constructor(private readonly client: ApiClient) {}

  async initialize() {
    if (this.hydrated) {
      return;
    }
    try {
      const persisted = await window.attendance.loadOfflineQueue();
      if (Array.isArray(persisted) && persisted.length > 0) {
        this.queue.push(...persisted);
      }
    } catch (error) {
      console.warn('Failed to hydrate offline queue', error);
    }
    this.hydrated = true;
    if (this.queue.length > 0) {
      void this.process();
    }
  }

  hasPending() {
    return this.queue.length > 0;
  }

  enqueue(request: ApiRequest) {
    const { transform: _unused, ...rest } = request;
    const entry: QueueEntry = {
      ...rest,
      tokenOverride: request.tokenOverride ?? this.client.getToken(),
      attempt: 0,
      nextAttemptAt: Date.now()
    };
    this.queue.push(entry);
    void this.persist();
    void this.process();
  }

  reset() {
    this.queue.length = 0;
    void this.persist();
  }

  private async persist() {
    try {
      if (this.queue.length > 0) {
        await window.attendance.saveOfflineQueue(this.queue);
      } else {
        await window.attendance.clearOfflineQueue();
      }
    } catch (error) {
      console.warn('Failed to persist offline queue', error);
    }
  }

  async process() {
    if (this.processing) {
      return;
    }
    this.processing = true;

    while (this.queue.length > 0) {
      const request = this.queue[0];
      const now = Date.now();
      if (request.nextAttemptAt > now) {
        const waitMs = request.nextAttemptAt - now;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      try {
        if (request.requiresAuth) {
          request.tokenOverride = this.client.getToken();
        }
        await this.client.request(request);
        this.queue.shift();
        console.info(`[OfflineQueue] ${request.description ?? request.path} sent successfully`);
        await this.persist();
      } catch (error) {
        const retryable = shouldQueue(error);
        if (!retryable) {
          console.warn(
            `[OfflineQueue] dropping non-retryable request ${request.description ?? request.path}`,
            error
          );
          this.queue.shift();
          await this.persist();
          continue;
        }
        request.attempt += 1;
        const delay = Math.min(60_000, Math.pow(2, request.attempt) * 1000);
        request.nextAttemptAt = Date.now() + delay;
        console.warn(`[OfflineQueue] ${request.description ?? request.path} retry in ${delay / 1000}s`, error);
        await this.persist();
      }
    }

    this.processing = false;
  }
}

type SessionState = 'inactive' | 'active' | 'idle' | 'break' | 'lunch';

type HealthStatus =
  | { state: 'idle' }
  | { state: 'testing'; baseUrl: string }
  | { state: 'success'; baseUrl: string; version: string; time: Date }
  | { state: 'error'; baseUrl: string; detail: string };

interface PresencePrompt {
  id: string;
  expiresAt: string;
  message?: string;
}

interface AppState {
  bootstrap: BootstrapData | null;
  email: string | null;
  token: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  tokenScope: string | null;
  sessionId: string | null;
  sessionState: SessionState;
  lastHeartbeatAt: Date | null;
  currentPrompt: PresencePrompt | null;
  settings: AppSettings | null;
  systemStatus: SystemStatus | null;
  requests: TimeRequest[];
  user: { id: number; email: string; name?: string | null; role?: string | null } | null;
  timesheet: TimesheetSummary | null;
  timesheetView: TimesheetView;
  timesheetReference: string | null;
  timesheetTimezone: string | null;
  timesheetLoading: boolean;
  lastServerSkewMs: number | null;
  lastServerDate: Date | null;
  lastRequestTrace: { requestId: string; url: string; status: number } | null;
  pauseHistory: PauseRecord[];
  currentPause: PauseRecord | null;
  healthStatus: HealthStatus;
  lastHealthSuccess: { baseUrl: string; version: string; time: Date } | null;
}

const state: AppState = {
  bootstrap: null,
  email: null,
  token: null,
  refreshToken: null,
  tokenExpiresAt: null,
  tokenScope: null,
  sessionId: null,
  sessionState: 'inactive',
  lastHeartbeatAt: null,
  currentPrompt: null,
  settings: null,
  systemStatus: null,
  requests: [],
  user: null,
  timesheet: null,
  timesheetView: 'pay_period',
  timesheetReference: null,
  timesheetTimezone: null,
  timesheetLoading: false,
  lastServerSkewMs: null,
  lastServerDate: null,
  lastRequestTrace: null,
  pauseHistory: [],
  currentPause: null,
  healthStatus: { state: 'idle' },
  lastHealthSuccess: null
};

const activityBuckets = new Map<string, { keys: number; mouse: number }>();

let heartbeatTimer: number | null = null;
let presenceTimeout: number | null = null;
let pauseTimer: number | null = null;
let apiClient: ApiClient;
let offlineQueue: OfflineQueue;
let refreshInFlight: Promise<void> | null = null;
let pendingTimesheetEdit: { date: string; label: string } | null = null;

const applyAuthTokens = (tokens: AuthTokens) => {
  state.token = tokens.accessToken;
  state.refreshToken = tokens.refreshToken;
  state.tokenExpiresAt = tokens.accessTokenExpiresAt ? new Date(tokens.accessTokenExpiresAt) : null;
  state.tokenScope = tokens.scope ?? null;
  apiClient.setToken(tokens.accessToken);
  updateDiagnostics();
};

const getDeviceId = () => state.settings?.deviceId ?? state.bootstrap?.deviceId ?? '';

const statusEmailEl = document.getElementById('status-email');
const statusSessionEl = document.getElementById('status-session');
const statusHeartbeatEl = document.getElementById('status-heartbeat');
const statusPauseEl = document.getElementById('status-pause');
const statusForegroundEl = document.getElementById('status-foreground');

const loginModal = document.getElementById('login-modal') as HTMLDivElement | null;
const loginForm = document.getElementById('login-form') as HTMLFormElement | null;
const loginEmailInput = document.getElementById('login-email') as HTMLInputElement | null;
const loginErrorEl = document.getElementById('login-error') as HTMLParagraphElement | null;
const loginCancelBtn = document.getElementById('login-cancel') as HTMLButtonElement | null;

const presenceModal = document.getElementById('presence-modal') as HTMLDivElement | null;
const presenceMessageEl = document.getElementById('presence-message') as HTMLParagraphElement | null;
const presenceConfirmBtn = document.getElementById('presence-confirm') as HTMLButtonElement | null;
const presenceDismissBtn = document.getElementById('presence-dismiss') as HTMLButtonElement | null;

const settingsModal = document.getElementById('settings-modal') as HTMLDivElement | null;
const settingsForm = document.getElementById('settings-form') as HTMLFormElement | null;
const settingsEmailInput = document.getElementById('settings-email') as HTMLInputElement | null;
const settingsBaseUrlInput = document.getElementById('settings-base-url') as HTMLInputElement | null;
const settingsErrorEl = document.getElementById('settings-error') as HTMLParagraphElement | null;
const settingsSuccessEl = document.getElementById('settings-success') as HTMLParagraphElement | null;
const settingsCancelBtn = document.getElementById('settings-cancel') as HTMLButtonElement | null;
const settingsTestBtn = document.getElementById('settings-test') as HTMLButtonElement | null;
const openSettingsBtn = document.getElementById('open-settings') as HTMLButtonElement | null;
const openRequestsBtn = document.getElementById('open-requests') as HTMLButtonElement | null;
const refreshRequestsBtn = document.getElementById('refresh-requests') as HTMLButtonElement | null;
const requestsListEl = document.getElementById('requests-list') as HTMLUListElement | null;
const requestsEmptyEl = document.getElementById('requests-empty') as HTMLParagraphElement | null;

const diagnosticsPanel = document.getElementById('diagnostics') as HTMLDivElement | null;
const diagnosticsContentEl = document.getElementById('diagnostics-content') as HTMLPreElement | null;
const toastEl = document.getElementById('app-toast') as HTMLDivElement | null;

const requestModal = document.getElementById('request-modal') as HTMLDivElement | null;
const requestForm = document.getElementById('request-form') as HTMLFormElement | null;
const requestCancelBtn = document.getElementById('request-cancel') as HTMLButtonElement | null;
const requestTypeInput = document.getElementById('request-type') as HTMLSelectElement | null;
const requestStartDateInput = document.getElementById('request-start-date') as HTMLInputElement | null;
const requestEndDateInput = document.getElementById('request-end-date') as HTMLInputElement | null;
const requestHoursInput = document.getElementById('request-hours') as HTMLInputElement | null;
const requestReasonInput = document.getElementById('request-reason') as HTMLTextAreaElement | null;
const requestErrorEl = document.getElementById('request-error') as HTMLParagraphElement | null;
const requestSuccessEl = document.getElementById('request-success') as HTMLParagraphElement | null;
const openTimesheetBtn = document.getElementById('open-timesheet') as HTMLButtonElement | null;
const timesheetModal = document.getElementById('timesheet-modal') as HTMLDivElement | null;
const timesheetFilterForm = document.getElementById('timesheet-filter') as HTMLFormElement | null;
const timesheetViewSelect = document.getElementById('timesheet-view') as HTMLSelectElement | null;
const timesheetDateGroup = document.getElementById('timesheet-date-group') as HTMLLabelElement | null;
const timesheetMonthGroup = document.getElementById('timesheet-month-group') as HTMLLabelElement | null;
const timesheetDateInput = document.getElementById('timesheet-date') as HTMLInputElement | null;
const timesheetMonthInput = document.getElementById('timesheet-month') as HTMLInputElement | null;
const timesheetSummaryEl = document.getElementById('timesheet-summary') as HTMLDivElement | null;
const timesheetTable = document.getElementById('timesheet-table') as HTMLTableElement | null;
const timesheetTableBody = document.getElementById('timesheet-table-body') as HTMLTableSectionElement | null;
const timesheetEmptyEl = document.getElementById('timesheet-empty') as HTMLParagraphElement | null;
const timesheetLoadingEl = document.getElementById('timesheet-loading') as HTMLParagraphElement | null;
const timesheetCloseBtn = document.getElementById('timesheet-close') as HTMLButtonElement | null;
const timesheetRefreshBtn = document.getElementById('timesheet-refresh') as HTMLButtonElement | null;
const timesheetRequestsSection = document.getElementById('timesheet-requests-section') as HTMLElement | null;
const timesheetRequestsRefreshBtn = document.getElementById('timesheet-requests-refresh') as HTMLButtonElement | null;
const timesheetRequestsList = document.getElementById('timesheet-requests-list') as HTMLUListElement | null;
const timesheetRequestsEmpty = document.getElementById('timesheet-requests-empty') as HTMLParagraphElement | null;
const timesheetEditModal = document.getElementById('timesheet-edit-modal') as HTMLDivElement | null;
const timesheetEditForm = document.getElementById('timesheet-edit-form') as HTMLFormElement | null;
const timesheetEditDateLabel = document.getElementById('timesheet-edit-date-label') as HTMLParagraphElement | null;
const timesheetEditReasonInput = document.getElementById('timesheet-edit-reason') as HTMLTextAreaElement | null;
const timesheetEditHoursInput = document.getElementById('timesheet-edit-hours') as HTMLInputElement | null;
const timesheetEditErrorEl = document.getElementById('timesheet-edit-error') as HTMLParagraphElement | null;
const timesheetEditSuccessEl = document.getElementById('timesheet-edit-success') as HTMLParagraphElement | null;
const timesheetEditCancelBtn = document.getElementById('timesheet-edit-cancel') as HTMLButtonElement | null;

const buttons = document.querySelectorAll<HTMLButtonElement>('[data-action]');

type PresenceUiMode = 'overlay' | 'popup' | 'both';

let presenceUiMode: PresenceUiMode = 'both';
let activePromptId: string | null = null;
let presenceAckInFlight = false;

const isPopupModeEnabled = () => presenceUiMode === 'popup' || presenceUiMode === 'both';

const minutesLabel = (minutes: number) => `${Math.max(0, minutes)} min`;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderHealthStatus = () => {
  if (!settingsSuccessEl || !settingsErrorEl) {
    return;
  }

  settingsSuccessEl.textContent = '';
  settingsSuccessEl.innerHTML = '';
  settingsErrorEl.textContent = '';
  settingsErrorEl.innerHTML = '';

  const status = state.healthStatus;

  switch (status.state) {
    case 'idle':
      return;
    case 'testing':
      settingsSuccessEl.textContent = 'Testing connection…';
      return;
    case 'success': {
      const formattedTime = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'short',
        timeStyle: 'short'
      }).format(status.time);
      const html = `<span class="settings-status-badge settings-status-badge--success" aria-hidden="true">●</span><span> Connected • v${escapeHtml(
        status.version
      )} • ${escapeHtml(formattedTime)}</span>`;
      settingsSuccessEl.innerHTML = html;
      return;
    }
    case 'error': {
      const html = `<span class="settings-status-badge settings-status-badge--error" aria-hidden="true">!</span><span> Unable to reach server.</span><span class="settings-status-detail">${escapeHtml(
        status.detail
      )}</span>`;
      settingsErrorEl.innerHTML = html;
      return;
    }
    default:
      return;
  }
};

const parsePausePayload = (value: unknown): PauseApiPayload | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === 'break' || raw.kind === 'lunch' ? (raw.kind as PauseKind) : undefined;
  const action = raw.action === 'start' || raw.action === 'end' ? (raw.action as PauseAction) : undefined;
  if (!kind || !action) {
    return undefined;
  }
  const sequenceValue = Number(raw.sequence);
  if (!Number.isFinite(sequenceValue)) {
    return undefined;
  }
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : undefined;
  if (!startedAt) {
    return undefined;
  }
  const endedAt = typeof raw.endedAt === 'string' ? raw.endedAt : raw.endedAt === null ? null : null;
  const durationMinutes = typeof raw.durationMinutes === 'number' ? raw.durationMinutes : null;
  return {
    kind,
    action,
    sequence: Math.max(1, Math.floor(sequenceValue)),
    startedAt,
    endedAt,
    durationMinutes
  };
};

const parsePauseSnapshot = (value: unknown): PauseSnapshot | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === 'break' || raw.kind === 'lunch' ? (raw.kind as PauseKind) : undefined;
  if (!kind) {
    return undefined;
  }
  const sequenceValue = Number(raw.sequence);
  if (!Number.isFinite(sequenceValue)) {
    return undefined;
  }
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : undefined;
  if (!startedAt) {
    return undefined;
  }
  const endedAt = typeof raw.endedAt === 'string' ? raw.endedAt : raw.endedAt === null ? null : null;
  const durationMinutes = typeof raw.durationMinutes === 'number' ? raw.durationMinutes : null;
  return {
    kind,
    sequence: Math.max(1, Math.floor(sequenceValue)),
    startedAt,
    endedAt,
    durationMinutes
  };
};

const parsePauseStateResponse = (value: unknown): { current: PauseSnapshot | null; history: PauseSnapshot[] } | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const currentRaw = raw.current ?? null;
  const current = currentRaw ? parsePauseSnapshot(currentRaw) ?? null : null;
  const historyRaw = Array.isArray(raw.history) ? raw.history : [];
  const history = historyRaw
    .map((entry) => parsePauseSnapshot(entry))
    .filter((entry): entry is PauseSnapshot => Boolean(entry));
  return { current, history };
};

const updatePauseDisplay = () => {
  if (!statusPauseEl) {
    return;
  }
  if (state.currentPause) {
    const minutes = computePauseDurationHelper(state.currentPause, new Date());
    statusPauseEl.textContent = `${formatPauseLabel(state.currentPause)} · ${minutesLabel(minutes)}`;
  } else {
    statusPauseEl.textContent = 'No active pause';
  }
};

const startPauseTimer = () => {
  if (pauseTimer) {
    return;
  }
  pauseTimer = window.setInterval(() => {
    updatePauseDisplay();
  }, 1_000);
  updatePauseDisplay();
};

const stopPauseTimer = () => {
  if (pauseTimer) {
    clearInterval(pauseTimer);
    pauseTimer = null;
  }
  updatePauseDisplay();
};

const applyPauseStateFromUpdate = (pauseState: PauseState) => {
  state.currentPause = pauseState.current;
  state.pauseHistory = pauseState.history;
  if (state.currentPause) {
    state.sessionState = state.currentPause.kind;
    startPauseTimer();
  } else {
    stopPauseTimer();
    if (state.sessionId) {
      state.sessionState = 'active';
    }
  }
  updateStatus();
};

const minuteKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
};

const pruneActivityBuckets = () => {
  const cutoff = new Date();
  cutoff.setMinutes(cutoff.getMinutes() - ACTIVITY_HISTORY_MINUTES);
  const cutoffKey = minuteKey(cutoff);

  for (const key of activityBuckets.keys()) {
    if (key < cutoffKey) {
      activityBuckets.delete(key);
    }
  }
};

const getActivitySnapshot = () => {
  pruneActivityBuckets();
  const buckets = Array.from(activityBuckets.entries())
    .map(([key, counts]) => ({
      minute: key,
      keys: counts.keys,
      mouse: counts.mouse
    }))
    .sort((a, b) => a.minute.localeCompare(b.minute));

  const aggregated = buckets.reduce(
    (acc, bucket) => {
      acc.keys += bucket.keys;
      acc.mouse += bucket.mouse;
      return acc;
    },
    { keys: 0, mouse: 0 }
  );

  return { buckets, aggregated };
};

const registerActivity = (kind: 'keyboard' | 'mouse') => {
  const key = minuteKey(new Date());
  const bucket = activityBuckets.get(key) ?? { keys: 0, mouse: 0 };
  if (kind === 'keyboard') {
    bucket.keys += 1;
  } else {
    bucket.mouse += 1;
  }
  activityBuckets.set(key, bucket);
};

const initActivityTracking = () => {
  window.addEventListener('keydown', () => registerActivity('keyboard'));
  window.addEventListener('keypress', () => registerActivity('keyboard'));
  window.addEventListener('mousemove', () => registerActivity('mouse'));
  window.addEventListener('mousedown', () => registerActivity('mouse'));
  window.addEventListener('wheel', () => registerActivity('mouse'));
};

const updateStatus = () => {
  if (statusEmailEl) {
    statusEmailEl.textContent = state.email ?? 'Not logged in';
  }

  if (statusSessionEl) {
    const parts: string[] = [];
    if (!state.sessionId) {
      parts.push('No active session');
    } else {
      parts.push('Active session');
      if (state.currentPause) {
        const minutes = computePauseDurationHelper(state.currentPause, new Date());
        parts.push(`(${formatPauseLabel(state.currentPause)} · ${minutesLabel(minutes)})`);
      } else {
        const idleFromSystem = state.systemStatus
          ? state.systemStatus.idleSeconds >= IDLE_THRESHOLD_SECONDS
          : state.sessionState === 'idle';
        if (idleFromSystem) {
          parts.push('(Idle)');
        }
      }
    }
    statusSessionEl.textContent = parts.join(' ');
  }

  if (statusHeartbeatEl) {
    statusHeartbeatEl.textContent = state.lastHeartbeatAt
      ? state.lastHeartbeatAt.toLocaleTimeString()
      : 'Never';
  }

  if (statusForegroundEl) {
    if (state.systemStatus?.foregroundApp?.title) {
      const owner = state.systemStatus.foregroundApp.owner;
      statusForegroundEl.textContent = owner
        ? `${state.systemStatus.foregroundApp.title} (${owner})`
        : state.systemStatus.foregroundApp.title;
    } else {
      statusForegroundEl.textContent = 'Unknown';
    }
  }

  updateControls();
  updateDiagnostics();
  updatePauseDisplay();
};

const updateControls = () => {
  buttons.forEach((button) => {
    const action = button.dataset.action;
    if (!action) {
      return;
    }

    if (action === 'log-in') {
      button.disabled = false;
      return;
    }

    if (action === 'log-out') {
      button.disabled = !state.token;
      return;
    }

    button.disabled = !state.sessionId;
  });
};

let toastTimer: number | null = null;
const MAX_CLOCK_SKEW_WARNING_MS = 5 * 60 * 1000;

const showToast = (message: string, variant: 'info' | 'success' | 'error' = 'info', code?: string, hint?: string) => {
  if (!toastEl) {
    return;
  }
  const parts = [message];
  if (hint) {
    parts.push(`Hint: ${hint}`);
  }
  const prefix = code ? `[${code}] ` : '';
  toastEl.textContent = `${prefix}${parts.join(' – ')}`;
  toastEl.dataset.variant = variant;
  toastEl.dataset.visible = 'true';

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    if (toastEl) {
      toastEl.dataset.visible = 'false';
    }
  }, 4000);
};

const resolvePresencePrompt = (response: unknown): PresencePrompt | null => {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const payload = response as Record<string, unknown>;
  const candidate = payload.presencePrompt ?? payload.prompt;
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const prompt = candidate as PresencePrompt;
  if (typeof prompt.id !== 'string' || prompt.id.trim().length === 0) {
    return null;
  }
  if (typeof prompt.expiresAt !== 'string' || prompt.expiresAt.trim().length === 0) {
    return null;
  }
  return prompt;
};

const shouldDisplayPresencePrompt = (prompt: PresencePrompt | null) => {
  if (!prompt) {
    return false;
  }
  if (!prompt.id || !prompt.expiresAt) {
    return false;
  }
  if (activePromptId === prompt.id && presenceModal?.dataset.visible === 'true') {
    return false;
  }
  return true;
};

const presencePayload = (prompt: PresencePrompt) => ({
  id: prompt.id,
  expiresAt: prompt.expiresAt,
  message: prompt.message ?? undefined
});

const requestPresencePopup = (prompt: PresencePrompt) => {
  if (!isPopupModeEnabled()) {
    return;
  }
  window.attendance.openPresencePrompt(presencePayload(prompt));
};

function updateDiagnostics() {
  if (!diagnosticsPanel || !diagnosticsContentEl) {
    return;
  }

  const shouldShow = Boolean(state.token || state.sessionId || state.user);
  diagnosticsPanel.hidden = !shouldShow;
  if (!shouldShow) {
    diagnosticsContentEl.textContent = '';
    return;
  }

  const lines: string[] = [
    `localTime: ${new Date().toLocaleString()}`,
    `sessionId: ${state.sessionId ?? 'none'}`,
    `sessionState: ${state.sessionState}`,
    `userId: ${state.user?.id ?? 'unknown'}`,
    `role: ${state.user?.role ?? 'unknown'}`,
    `tokenScope: ${state.tokenScope ?? 'n/a'}`,
    `tokenExpires: ${state.tokenExpiresAt ? state.tokenExpiresAt.toLocaleString() : 'n/a'}`,
    `lastReqId: ${state.lastRequestTrace?.requestId ?? 'n/a'}`,
    `lastReqStatus: ${state.lastRequestTrace?.status ?? 'n/a'}`,
    `clockSkewMs: ${state.lastServerSkewMs ?? 'n/a'}`
  ];

  diagnosticsContentEl.textContent = lines.join('\n');
}

function processServerDateHeader(dateHeader: string | null, requestId: string) {
  if (!dateHeader) {
    return;
  }
  const parsed = new Date(dateHeader);
  if (Number.isNaN(parsed.getTime())) {
    return;
  }
  const skewMs = Math.abs(parsed.getTime() - Date.now());
  state.lastServerSkewMs = skewMs;
  state.lastServerDate = parsed;
  if (skewMs > MAX_CLOCK_SKEW_WARNING_MS) {
    console.warn('[diagnostics]', {
      type: 'clock_skew',
      skewMs,
      thresholdMs: MAX_CLOCK_SKEW_WARNING_MS,
      requestId,
      serverDate: parsed.toISOString()
    });
  }
  updateDiagnostics();
}

function recordRequestTrace(trace: { requestId: string; url: string; status: number }) {
  state.lastRequestTrace = trace;
  updateDiagnostics();
}

function parseApiError(error: unknown): { message: string; code?: string; hint?: string } {
  if (error instanceof ApiError) {
    const body = error.body as Record<string, unknown> | undefined;
    if (body && typeof body === 'object') {
      const code = typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : undefined;
      const message = typeof body.error === 'string' ? body.error : error.message;
      const hint = typeof body.hint === 'string' ? body.hint : undefined;
      return { message, code, hint };
    }
    return { message: error.message, code: error.status ? String(error.status) : undefined };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: 'Unknown failure' };
}

const renderRequests = () => {
  if (!requestsListEl || !requestsEmptyEl) {
    return;
  }

  requestsListEl.innerHTML = '';

  if (!state.requests || state.requests.length === 0) {
    requestsEmptyEl.style.display = 'block';
    return;
  }

  requestsEmptyEl.style.display = 'none';

  state.requests
    .slice()
    .sort((a, b) => {
      const aDate = a.createdAt ?? a.startDate;
      const bDate = b.createdAt ?? b.startDate;
      return (bDate ?? '').localeCompare(aDate ?? '');
    })
    .forEach((request) => {
      const item = document.createElement('li');
      item.className = 'requests__item';

      const title = document.createElement('strong');
      title.textContent = `${request.type} • ${formatDateRange(request.startDate, request.endDate)}`;
      item.appendChild(title);

      const hours = document.createElement('span');
      hours.textContent = `Hours: ${request.hours}`;
      item.appendChild(hours);

      if (request.reason) {
        const reason = document.createElement('span');
        reason.textContent = `Reason: ${request.reason}`;
        item.appendChild(reason);
      }

      const status = document.createElement('span');
      status.className = 'requests__status';
      status.textContent = `Status: ${request.status ?? 'pending'}`;
      item.appendChild(status);

      requestsListEl.appendChild(item);
    });
};

const formatDateRange = (start: string, end?: string | null) => {
  if (!end || end === start) {
    return start;
  }
  return `${start} → ${end}`;
};

const isoDateOnly = (value: string) => value.slice(0, 10);
const isoMonthOnly = (value: string) => value.slice(0, 7);
const minutesToHours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const formatHours = (hours: number) => (Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(2));
const formatLocalDate = (iso: string) => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const formatStatus = (value: string) => (value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value);

const updateTimesheetInputVisibility = (view: TimesheetView) => {
  const showMonth = view === 'monthly';
  if (timesheetDateGroup) {
    timesheetDateGroup.classList.toggle('hidden', showMonth);
  }
  if (timesheetMonthGroup) {
    timesheetMonthGroup.classList.toggle('hidden', !showMonth);
  }
};

const ensureTimesheetFormDefaults = () => {
  if (!timesheetViewSelect) {
    return;
  }
  const view = state.timesheetView ?? 'pay_period';
  timesheetViewSelect.value = view;
  updateTimesheetInputVisibility(view);
  const todayIso = new Date().toISOString();
  if (view === 'monthly') {
    if (timesheetMonthInput) {
      timesheetMonthInput.value = state.timesheetReference ?? isoMonthOnly(todayIso);
    }
    if (timesheetDateInput) {
      timesheetDateInput.value = '';
    }
  } else {
    if (timesheetDateInput) {
      timesheetDateInput.value = state.timesheetReference ?? isoDateOnly(todayIso);
    }
    if (timesheetMonthInput) {
      timesheetMonthInput.value = '';
    }
  }
};

const toggleTimesheetEditModal = (visible: boolean) => {
  if (!timesheetEditModal) {
    return;
  }
  timesheetEditModal.dataset.visible = visible ? 'true' : 'false';
  if (visible) {
    if (timesheetEditReasonInput) {
      timesheetEditReasonInput.value = '';
    }
    if (timesheetEditHoursInput) {
      timesheetEditHoursInput.value = '';
    }
    if (timesheetEditErrorEl) {
      timesheetEditErrorEl.textContent = '';
    }
    if (timesheetEditSuccessEl) {
      timesheetEditSuccessEl.textContent = '';
    }
  } else {
    pendingTimesheetEdit = null;
    if (timesheetEditErrorEl) {
      timesheetEditErrorEl.textContent = '';
    }
    if (timesheetEditSuccessEl) {
      timesheetEditSuccessEl.textContent = '';
    }
  }
};

const renderTimesheetRequests = (summary: TimesheetSummary | null) => {
  if (!timesheetRequestsSection || !timesheetRequestsList || !timesheetRequestsEmpty) {
    return;
  }

  if (!summary) {
    timesheetRequestsSection.style.display = 'none';
    timesheetRequestsList.innerHTML = '';
    timesheetRequestsEmpty.style.display = 'block';
    return;
  }

  timesheetRequestsSection.style.display = 'block';

  if (!summary.editRequests.length) {
    timesheetRequestsList.innerHTML = '';
    timesheetRequestsEmpty.style.display = 'block';
    return;
  }

  timesheetRequestsEmpty.style.display = 'none';
  timesheetRequestsList.innerHTML = '';

  summary.editRequests
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .forEach((request) => {
      const item = document.createElement('li');
      item.className = 'timesheet__request-item';

      const title = document.createElement('strong');
      title.textContent = `${formatLocalDate(request.targetDate)} • ${formatStatus(request.status)}`;
      item.appendChild(title);

      const reason = document.createElement('p');
      reason.textContent = request.reason;
      item.appendChild(reason);

      const meta = document.createElement('div');
      meta.className = 'timesheet__request-meta';

      const statusEl = document.createElement('span');
      statusEl.className = `timesheet__request-status ${request.status}`;
      statusEl.textContent = formatStatus(request.status);
      meta.appendChild(statusEl);

      const createdEl = document.createElement('span');
      createdEl.textContent = `Requested ${formatLocalDate(request.createdAt)}`;
      meta.appendChild(createdEl);

      if (request.reviewedAt) {
        const reviewedEl = document.createElement('span');
        reviewedEl.textContent = `Reviewed ${formatLocalDate(request.reviewedAt)}`;
        meta.appendChild(reviewedEl);
      }

      if (request.requestedMinutes && request.requestedMinutes > 0) {
        const requestedHours = formatHours(minutesToHours(request.requestedMinutes));
        const requestedEl = document.createElement('span');
        requestedEl.textContent = `Requested hours: ${requestedHours}`;
        meta.appendChild(requestedEl);
      }

      if (request.adminNote) {
        const noteEl = document.createElement('span');
        noteEl.textContent = `Admin note: ${request.adminNote}`;
        meta.appendChild(noteEl);
      }

      item.appendChild(meta);
      timesheetRequestsList.appendChild(item);
    });
};

const renderTimesheet = () => {
  if (!timesheetSummaryEl || !timesheetEmptyEl || !timesheetTableBody || !timesheetLoadingEl) {
    return;
  }

  const loading = state.timesheetLoading;
  const summary = state.timesheet;

  timesheetLoadingEl.hidden = !loading;

  if (loading) {
    timesheetSummaryEl.innerHTML = '';
    timesheetTableBody.innerHTML = '';
    if (timesheetEmptyEl) {
      timesheetEmptyEl.style.display = 'none';
    }
    if (timesheetTable) {
      timesheetTable.style.display = 'none';
    }
    renderTimesheetRequests(summary);
    return;
  }

  if (!summary) {
    timesheetSummaryEl.innerHTML = '';
    timesheetTableBody.innerHTML = '';
    if (timesheetEmptyEl) {
      timesheetEmptyEl.style.display = 'block';
      timesheetEmptyEl.textContent = 'No activity recorded for this range.';
    }
    if (timesheetTable) {
      timesheetTable.style.display = 'none';
    }
    renderTimesheetRequests(summary);
    return;
  }

  const summaryCards = [
    `<div class="timesheet__summary-item"><span>Range</span><strong>${summary.label}</strong><small>${state.timesheetTimezone ?? ''}</small></div>`,
    `<div class="timesheet__summary-item"><span>Active Hours</span><strong>${formatHours(summary.totals.activeHours)}</strong><small>${summary.totals.activeMinutes} min</small></div>`,
    `<div class="timesheet__summary-item"><span>Idle Hours</span><strong>${formatHours(summary.totals.idleHours)}</strong><small>${summary.totals.idleMinutes} min</small></div>`,
    `<div class="timesheet__summary-item"><span>Breaks</span><strong>${summary.totals.breaks}</strong></div>`,
    `<div class="timesheet__summary-item"><span>Lunches</span><strong>${summary.totals.lunches}</strong></div>`,
    `<div class="timesheet__summary-item"><span>Presence Misses</span><strong>${summary.totals.presenceMisses}</strong></div>`
  ];
  timesheetSummaryEl.innerHTML = summaryCards.join('');

  if (timesheetTable) {
    timesheetTable.style.display = summary.days.length ? 'table' : 'none';
  }
  if (timesheetEmptyEl) {
    timesheetEmptyEl.style.display = summary.days.length ? 'none' : 'block';
  }

  timesheetTableBody.innerHTML = '';
  summary.days.forEach((day) => {
    const row = document.createElement('tr');

    const dateCell = document.createElement('td');
    dateCell.textContent = day.label;
    row.appendChild(dateCell);

    const activeCell = document.createElement('td');
    activeCell.textContent = formatHours(minutesToHours(day.activeMinutes));
    row.appendChild(activeCell);

    const idleCell = document.createElement('td');
    idleCell.textContent = formatHours(minutesToHours(day.idleMinutes));
    row.appendChild(idleCell);

    const breaksCell = document.createElement('td');
    breaksCell.textContent = String(day.breaks);
    row.appendChild(breaksCell);

    const lunchesCell = document.createElement('td');
    lunchesCell.textContent = String(day.lunches);
    row.appendChild(lunchesCell);

    const presenceCell = document.createElement('td');
    presenceCell.textContent = String(day.presenceMisses);
    row.appendChild(presenceCell);

    const actionCell = document.createElement('td');
    actionCell.className = 'timesheet__action';
    const hasPending = day.editRequests.some((req) => req.status === 'pending');
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.dataset.action = 'timesheet-request-edit';
    actionButton.dataset.date = day.date;
    actionButton.dataset.label = day.label;
    actionButton.textContent = hasPending ? 'Pending' : 'Request Edit';
    actionButton.disabled = hasPending;
    actionCell.appendChild(actionButton);

    if (day.editRequests.length) {
      const note = document.createElement('div');
      note.className = 'timesheet__day-note';
      note.textContent = day.editRequests
        .map((req) => `${formatStatus(req.status)} • ${formatLocalDate(req.createdAt)}`)
        .join(', ');
      actionCell.appendChild(note);
    }

    row.appendChild(actionCell);
    timesheetTableBody.appendChild(row);
  });

  renderTimesheetRequests(summary);
};

const toggleTimesheetModal = (visible: boolean) => {
  if (!timesheetModal) {
    return;
  }
  timesheetModal.dataset.visible = visible ? 'true' : 'false';
  if (visible) {
    ensureTimesheetFormDefaults();
    renderTimesheet();
    void fetchTimesheet({
      view: (timesheetViewSelect?.value as TimesheetView | undefined) ?? state.timesheetView,
      date: timesheetDateInput?.value || undefined,
      month: timesheetMonthInput?.value || undefined,
      silent: Boolean(state.timesheet)
    });
  } else {
    toggleTimesheetEditModal(false);
  }
};

const openTimesheetEditRequest = (date: string, label: string) => {
  if (!state.timesheet) {
    return;
  }
  pendingTimesheetEdit = { date, label };
  if (timesheetEditDateLabel) {
    timesheetEditDateLabel.textContent = `Request change for ${label}`;
  }
  toggleTimesheetEditModal(true);
};

const getTimesheetRequestValues = () => {
  const view = (timesheetViewSelect?.value as TimesheetView | undefined) ?? state.timesheetView;
  const dateValue = timesheetDateInput?.value?.trim();
  const monthValue = timesheetMonthInput?.value?.trim();
  return {
    view,
    date: view === 'monthly' ? null : dateValue && dateValue.length ? dateValue : state.timesheetReference,
    month: view === 'monthly' ? (monthValue && monthValue.length ? monthValue : state.timesheetReference) : null
  };
};

const fetchTimesheet = async (options?: { view?: TimesheetView; date?: string | null; month?: string | null; silent?: boolean }) => {
  const ensureAuth = state.token ? true : await ensureAuthenticated();
  if (!ensureAuth) {
    return;
  }

  const requestValues = options ?? getTimesheetRequestValues();
  const view = requestValues.view ?? state.timesheetView ?? 'pay_period';
  const isMonthly = view === 'monthly';
  let dateParam = isMonthly ? null : (requestValues.date ?? undefined);
  let monthParam = isMonthly ? (requestValues.month ?? undefined) : null;

  const todayIso = new Date().toISOString();
  if (isMonthly && (!monthParam || monthParam.length === 0)) {
    monthParam = state.timesheetReference ?? isoMonthOnly(todayIso);
  }
  if (!isMonthly && (!dateParam || dateParam.length === 0)) {
    dateParam = state.timesheetReference ?? isoDateOnly(todayIso);
  }

  state.timesheetLoading = !options?.silent;
  renderTimesheet();

  const params = new URLSearchParams({ view });
  if (isMonthly) {
    params.set('month', monthParam!);
  } else if (dateParam) {
    params.set('date', dateParam);
  }

  const result = await sendOrQueue<{ timezone?: string; timesheet?: TimesheetSummary; view?: TimesheetView; userId?: number }>({
    path: `/api/timesheets?${params.toString()}`,
    method: 'GET',
    requiresAuth: true,
    description: 'Fetch Timesheet'
  });

  state.timesheetLoading = false;

  if (result.ok) {
    const payload = result.data ?? {};
    const summary = (payload && (payload as { timesheet?: TimesheetSummary }).timesheet) || (payload as TimesheetSummary);
    state.timesheet = summary ?? null;
    state.timesheetView = view;
    state.timesheetReference = isMonthly ? monthParam ?? null : dateParam ?? null;
    state.timesheetTimezone = (payload && (payload as { timezone?: string }).timezone) ?? state.timesheetTimezone;

    if (timesheetViewSelect) {
      timesheetViewSelect.value = view;
      updateTimesheetInputVisibility(view);
    }
    if (isMonthly) {
      if (timesheetMonthInput) {
        timesheetMonthInput.value = monthParam ?? (summary ? isoMonthOnly(summary.rangeStart) : '');
      }
      if (timesheetDateInput) {
        timesheetDateInput.value = '';
      }
    } else if (timesheetDateInput) {
      timesheetDateInput.value = dateParam ?? (summary ? isoDateOnly(summary.rangeStart) : '');
    }

    renderTimesheet();
  } else if (result.queued) {
    showToast('Offline: timesheet request queued.', 'info');
  } else {
    const parsed = parseApiError(result.error);
    showToast(`Unable to load timesheet: ${parsed.message}`, 'error', parsed.code, parsed.hint);
    renderTimesheet();
  }
};

const toggleLoginModal = (visible: boolean) => {
  if (!loginModal) {
    return;
  }
  loginModal.dataset.visible = visible ? 'true' : 'false';
  if (!visible) {
    if (loginErrorEl) {
      loginErrorEl.textContent = '';
    }
    const submitButton = loginForm?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    submitButton?.removeAttribute('disabled');
  }
};

const togglePresenceModal = (visible: boolean) => {
  if (!presenceModal) {
    return;
  }
  presenceModal.dataset.visible = visible ? 'true' : 'false';
  if (visible) {
    if (presenceConfirmBtn) {
      presenceConfirmBtn.disabled = false;
    }
    if (presenceDismissBtn) {
      presenceDismissBtn.disabled = false;
    }
  }
};

const toggleSettingsModal = (visible: boolean) => {
  if (!settingsModal) {
    return;
  }
  settingsModal.dataset.visible = visible ? 'true' : 'false';
  if (!visible) {
    if (settingsErrorEl) {
      settingsErrorEl.textContent = '';
    }
    if (settingsSuccessEl) {
      settingsSuccessEl.textContent = '';
    }
  }
};

const resetRequestForm = () => {
  requestForm?.reset();
  if (requestSuccessEl) {
    requestSuccessEl.textContent = '';
  }
  if (requestErrorEl) {
    requestErrorEl.textContent = '';
  }
};

const toggleRequestModal = (visible: boolean) => {
  if (!requestModal) {
    return;
  }
  requestModal.dataset.visible = visible ? 'true' : 'false';
  if (visible) {
    if (requestSuccessEl) {
      requestSuccessEl.textContent = '';
    }
    if (requestErrorEl) {
      requestErrorEl.textContent = '';
    }
  } else {
    resetRequestForm();
  }
};

const fetchSystemStatus = async (): Promise<SystemStatus | null> => {
  try {
    const status = await window.attendance.getSystemStatus();
    state.systemStatus = status;
    return status;
  } catch (error) {
    console.warn('Failed to fetch system status', error);
    return state.systemStatus;
  } finally {
    updateStatus();
  }
};

const buildHeartbeatPayload = (status: SystemStatus | null) => {
  if (!state.sessionId) {
    throw new Error('Cannot build heartbeat payload without session');
  }

  const { buckets, aggregated } = getActivitySnapshot();
  const idleSeconds = status?.idleSeconds ?? Number.POSITIVE_INFINITY;
  const isIdle = idleSeconds >= IDLE_THRESHOLD_SECONDS;
  const activeMinute = idleSeconds < 60;

  return {
    sessionId: state.sessionId,
    timestamp: new Date().toISOString(),
    idleFlag: isIdle,
    idleSeconds: Number.isFinite(idleSeconds) ? idleSeconds : null,
    activeMinute,
    keysCount: aggregated.keys,
    mouseCount: aggregated.mouse,
    activityBuckets: buckets,
    foregroundAppTitle: status?.foregroundApp?.title ?? null,
    foregroundAppOwner: status?.foregroundApp?.owner ?? null
  };
};

const shouldQueue = (error: unknown) => {
  if (error instanceof ApiError) {
    if (typeof error.status === 'number') {
      return error.status >= 500 || error.status === 429;
    }
    return true;
  }
  return true;
};

const refreshAuthToken = async () => {
  if (!state.refreshToken) {
    throw new Error('missing_refresh_token');
  }
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const response = await apiClient.request<AuthTokens>({
        path: '/api/sessions/refresh',
        body: { refreshToken: state.refreshToken },
        requiresAuth: false,
        description: 'Refresh Access Token'
      });
      applyAuthTokens(response);
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  await refreshInFlight;
};

const tryRefreshAuthToken = async () => {
  try {
    await refreshAuthToken();
    return true;
  } catch (error) {
    console.warn('Token refresh failed', error);
    return false;
  }
};

const sendOrQueueCore = async <T = unknown>(request: ApiRequest<T>) => {
  const execute = () => apiClient.request(request);

  try {
    const data = await execute();
    return { ok: true as const, data };
  } catch (error) {
    let finalError: unknown = error;

    if (error instanceof ApiError && error.status === 401) {
      const refreshed = await tryRefreshAuthToken();
      if (refreshed) {
        try {
          const data = await execute();
          return { ok: true as const, data };
        } catch (retryError) {
          finalError = retryError;
        }
      }

      clearAuth();
      return { ok: false as const, queued: false as const, error: finalError };
    }

    if (shouldQueue(finalError)) {
      console.warn(`[Queue] ${request.description ?? request.path} queued`, finalError);
      offlineQueue.enqueue({ ...request });
      return { ok: false as const, queued: true as const, error: finalError };
    }

    return { ok: false as const, queued: false as const, error: finalError };
  }
};

let sendOrQueueHandler: typeof sendOrQueueCore = sendOrQueueCore;

const sendOrQueue = async <T = unknown>(request: ApiRequest<T>) => sendOrQueueHandler(request);

const setSendOrQueueHandler = (handler: typeof sendOrQueueCore) => {
  sendOrQueueHandler = handler;
};

const resetSendOrQueueHandler = () => {
  sendOrQueueHandler = sendOrQueueCore;
};

const ensureAuthenticated = async (): Promise<boolean> => {
  if (state.token) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    if (!loginModal || !loginForm || !loginCancelBtn) {
      resolve(false);
      return;
    }

    let resolved = false;

    const setError = (message: string) => {
      if (loginErrorEl) {
        loginErrorEl.textContent = message;
      }
    };

    const cleanup = () => {
      loginForm.removeEventListener('submit', submitHandler);
      loginCancelBtn.removeEventListener('click', cancelHandler);
    };

    const submitHandler = async (event: SubmitEvent) => {
      event.preventDefault();
      const formData = new FormData(loginForm);
      const email = String(formData.get('email') ?? '').trim().toLowerCase();
      const deviceId = getDeviceId();

      if (!email) {
        setError('Enter your work email.');
        return;
      }

      const submitButton = loginForm.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      submitButton?.setAttribute('disabled', 'true');
      setError('');

      console.info('[ui]', { event: 'login_submit', email, deviceId });

      try {
        const response = await apiClient.request<AuthTokens>({
          path: '/api/sessions/start',
          body: {
            flow: 'email_only',
            email,
            ...(deviceId ? { deviceId } : {})
          },
          requiresAuth: false,
          description: 'Email Sign-In'
        });

        applyAuthTokens(response);
        state.email = email;
        await fetchCurrentUser();
        updateStatus();
        toggleLoginModal(false);
        cleanup();
        loginForm.reset();
        if (loginEmailInput) {
          loginEmailInput.value = email;
        }
        resolved = true;
        window.attendance.logAction('Logged in');
        await fetchRequests();
        showToast('Logged in successfully', 'success');
        console.info('[ui]', { event: 'login_success', email });
        resolve(true);
      } catch (error) {
        const message =
          error instanceof ApiError && error.status === 401
            ? 'We could not verify that email. Check with your manager.'
            : error instanceof ApiError
            ? error.message
            : 'Sign-in failed. Please try again.';
        setError(message);
        const parsed = parseApiError(error);
        showToast(`Login failed: ${parsed.message}`, 'error', parsed.code, parsed.hint);
        submitButton?.removeAttribute('disabled');
      }
    };

    const cancelHandler = () => {
      toggleLoginModal(false);
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    };

    loginForm.addEventListener('submit', submitHandler);
    loginCancelBtn.addEventListener('click', cancelHandler, { once: true });

    const observer = new MutationObserver(() => {
      if (loginModal.dataset.visible !== 'true') {
        observer.disconnect();
        cleanup();
        if (!resolved) {
          resolved = true;
          resolve(Boolean(state.token));
        }
      }
    });
    observer.observe(loginModal, { attributes: true, attributeFilter: ['data-visible'] });

    if (loginEmailInput) {
      loginEmailInput.value = state.email ?? loginEmailInput.value ?? '';
    }
    setError('');
    toggleLoginModal(true);
    loginEmailInput?.focus();
  });
};

const startSession = async () => {
  if (!state.bootstrap) {
    throw new Error('Application not initialized');
  }

  if (!state.token) {
    const authenticated = await ensureAuthenticated();
    if (!authenticated) {
      return;
    }
  }

  if (state.sessionId) {
    return;
  }

  if (!state.email) {
    const authenticated = await ensureAuthenticated();
    if (!authenticated || !state.email) {
      console.warn('No employee email available to start session');
      return;
    }
  }

  try {
    const response = await apiClient.request<{ sessionId?: string; id?: string }>({
      path: '/api/sessions/start',
      body: {
        email: state.email,
        deviceId: state.bootstrap.deviceId,
        platform: state.bootstrap.platform
      },
      requiresAuth: true,
      description: 'Start Session'
    });

    const sessionId = response.sessionId ?? response.id;
    if (!sessionId) {
      throw new ApiError('Session ID missing in response');
    }

    state.sessionId = sessionId;
    state.sessionState = 'active';
    state.lastHeartbeatAt = null;
    updateStatus();
    await hydratePauseState();
    startHeartbeatLoop();
    void offlineQueue.process();
    void fetchRequests();
    window.attendance.logAction('Session started');
    showToast('Session started', 'success');
    console.info('[ui]', { event: 'session_started', sessionId });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'Unable to start session';
    console.error(message, error);
    const parsed = parseApiError(error);
    showToast(`Unable to start session: ${parsed.message}`, 'error', parsed.code, parsed.hint);
  }
};

const stopSessionLocally = () => {
  state.sessionId = null;
  state.sessionState = 'inactive';
  state.lastHeartbeatAt = null;
  state.currentPause = null;
  state.pauseHistory = [];
  stopPauseTimer();
  updateStatus();
  stopHeartbeatLoop();
};

const clearAuth = () => {
  state.token = null;
  state.refreshToken = null;
  state.tokenExpiresAt = null;
  state.tokenScope = null;
  apiClient.setToken(null);
  state.requests = [];
  state.user = null;
  state.lastRequestTrace = null;
  state.lastServerSkewMs = null;
  state.lastServerDate = null;
  state.currentPause = null;
  state.pauseHistory = [];
  stopPauseTimer();
  renderRequests();
  updateStatus();
};

const endSession = async () => {
  if (!state.sessionId) {
    return;
  }

  const request: ApiRequest = {
    path: '/api/sessions/end',
    body: { sessionId: state.sessionId },
    description: 'End Session'
  };

  const result = await sendOrQueue(request);
  if (!result.ok && !result.queued) {
    console.error('Failed to end session', result.error);
    const parsed = parseApiError(result.error);
    showToast(`End session failed: ${parsed.message}`, 'error', parsed.code, parsed.hint);
    return;
  }

  stopSessionLocally();
  clearAuth();
  window.attendance.logAction('Session ended');
  showToast('Session ended', 'success');
};

const startHeartbeatLoop = () => {
  if (heartbeatTimer) {
    return;
  }
  heartbeatTimer = window.setInterval(() => {
    void sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  void sendHeartbeat();
};

const stopHeartbeatLoop = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

const sendHeartbeat = async () => {
  if (!state.sessionId) {
    return;
  }

  const status = await fetchSystemStatus();
  const payload = buildHeartbeatPayload(status);

  const request: ApiRequest<{ prompt?: PresencePrompt | null }> = {
    path: '/api/events/heartbeat',
    body: payload,
    description: 'Heartbeat'
  };

  const result = await sendOrQueue(request);
  if (!result.ok) {
    if (!result.queued) {
      console.warn('Heartbeat failed', result.error);
    }
    return;
  }

  state.lastHeartbeatAt = new Date();
  if (state.sessionState !== 'break' && state.sessionState !== 'lunch') {
    state.sessionState = payload.idleFlag ? 'idle' : 'active';
  }
  updateStatus();

  const response = result.data;
  const prompt = resolvePresencePrompt(response);
  if (prompt && shouldDisplayPresencePrompt(prompt)) {
    showPresencePrompt(prompt);
  }
};

const hydratePauseState = async () => {
  if (!state.sessionId) {
    state.currentPause = null;
    state.pauseHistory = [];
    stopPauseTimer();
    updatePauseDisplay();
    return;
  }

  try {
    const response = await apiClient.request<{ current: PauseSnapshot | null; history: PauseSnapshot[] } | null>({
      path: `/api/sessions/${state.sessionId}/pauses`,
      method: 'GET',
      requiresAuth: true,
      description: 'Load Session Pauses',
      transform: (data) => parsePauseStateResponse(data)
    });

    if (!response) {
      applyPauseStateFromUpdate({ current: null, history: [] });
      return;
    }

    const pauseState = buildPauseState(response, new Date());
    applyPauseStateFromUpdate(pauseState);
  } catch (error) {
    console.warn('Failed to load session pauses', error);
  }
};

const fetchRequests = async () => {
  if (!state.token) {
    return;
  }

  const result = await sendOrQueue<{ requests?: TimeRequest[] } | TimeRequest[]>({
    path: '/api/time-requests/my',
    method: 'GET',
    requiresAuth: true,
    description: 'Fetch Time Requests'
  });

  if (result.ok) {
    const response = result.data;
    const requests = Array.isArray(response) ? response : response?.requests ?? [];
    state.requests = requests;
    renderRequests();
  } else if (!result.queued) {
    console.warn('Unable to fetch requests', result.error);
    const parsed = parseApiError(result.error);
    showToast(`Unable to fetch requests: ${parsed.message}`, 'error', parsed.code, parsed.hint);
  }
};

const fetchCurrentUser = async () => {
  if (!state.token) {
    return;
  }

  const result = await sendOrQueue<{ user?: { id: number; email: string; name?: string; role?: string } }>({
    path: '/api/me',
    method: 'GET',
    requiresAuth: true,
    description: 'Fetch Current User'
  });

  if (result.ok) {
    const payload = result.data;
    if (payload && typeof payload === 'object' && 'user' in payload) {
      state.user = (payload as { user?: { id: number; email: string; name?: string; role?: string } }).user ?? null;
      updateStatus();
    }
  } else if (!result.queued) {
    console.warn('Unable to fetch current user', result.error);
    const parsed = parseApiError(result.error);
    showToast(`Unable to fetch user: ${parsed.message}`, 'error', parsed.code, parsed.hint);
  }
};

const submitRequest = async () => {
  if (!requestForm || !state.bootstrap) {
    return;
  }

  if (!state.token) {
    const authenticated = await ensureAuthenticated();
    if (!authenticated) {
      if (requestErrorEl) {
        requestErrorEl.textContent = 'Log in to submit a request.';
      }
      return;
    }
  }

  if (!state.email) {
    if (requestErrorEl) {
      requestErrorEl.textContent = 'Log in to submit a request.';
    }
    return;
  }

  const type = requestTypeInput?.value ?? '';
  const startDate = requestStartDateInput?.value ?? '';
  const endDateRaw = requestEndDateInput?.value ?? '';
  const hoursValue = requestHoursInput?.value ?? '';
  const reason = requestReasonInput?.value?.trim() ?? '';

  if (!type || !startDate || !hoursValue || !reason) {
    if (requestErrorEl) {
      requestErrorEl.textContent = 'All required fields must be completed.';
    }
    return;
  }

  const hours = Number.parseFloat(hoursValue);
  if (Number.isNaN(hours) || hours <= 0) {
    if (requestErrorEl) {
      requestErrorEl.textContent = 'Hours must be a positive number.';
    }
    return;
  }

  const endDate = endDateRaw ? endDateRaw : null;
  if (endDate && endDate < startDate) {
    if (requestErrorEl) {
      requestErrorEl.textContent = 'End date cannot be before start date.';
    }
    return;
  }

  const payload: Record<string, unknown> = {
    type,
    startDate,
    hours,
    reason,
    email: state.email,
    deviceId: state.bootstrap.deviceId
  };

  if (endDate) {
    payload.endDate = endDate;
  }

  if (requestErrorEl) {
    requestErrorEl.textContent = '';
  }
  if (requestSuccessEl) {
    requestSuccessEl.textContent = 'Submitting...';
  }

  const result = await sendOrQueue({
    path: '/api/time-requests',
    body: payload,
    requiresAuth: true,
    description: 'Submit Time Request'
  });

  if (result.ok) {
    if (requestSuccessEl) {
      requestSuccessEl.textContent = 'Request submitted.';
    }
    toggleRequestModal(false);
    await fetchRequests();
  } else if (result.queued) {
    if (requestSuccessEl) {
      requestSuccessEl.textContent = 'Offline: request queued and will submit automatically.';
    }
    return;
  } else {
    if (requestErrorEl) {
      requestErrorEl.textContent = 'Unable to submit request.';
    }
  }
};

const showPresencePrompt = (prompt: PresencePrompt) => {
  state.currentPrompt = prompt;
  activePromptId = prompt.id;

  if (presenceMessageEl) {
    presenceMessageEl.textContent = prompt.message ?? 'Please confirm your presence.';
  }

  togglePresenceModal(true);

  if (presenceTimeout) {
    clearTimeout(presenceTimeout);
  }
  presenceTimeout = window.setTimeout(() => {
    if (activePromptId === prompt.id) {
      togglePresenceModal(false);
      window.attendance.closePresencePrompt(prompt.id);
      state.currentPrompt = null;
      activePromptId = null;
    }
  }, PRESENCE_CONFIRMATION_WINDOW_MS);

  requestPresencePopup(prompt);
};

const acknowledgePresencePrompt = async (source: 'overlay' | 'popup') => {
  if (!state.currentPrompt || !state.sessionId || presenceAckInFlight) {
    return;
  }

  const prompt = state.currentPrompt;
  presenceAckInFlight = true;

  if (presenceTimeout) {
    clearTimeout(presenceTimeout);
    presenceTimeout = null;
  }

  if (source === 'popup') {
    togglePresenceModal(false);
  } else if (presenceConfirmBtn) {
    presenceConfirmBtn.disabled = true;
  }

  window.attendance.closePresencePrompt(prompt.id);

  const request: ApiRequest = {
    path: '/api/events/presence/confirm',
    body: {
      sessionId: state.sessionId,
      promptId: prompt.id,
      timestamp: new Date().toISOString()
    },
    description: 'Presence Confirmation'
  };

  const result = await sendOrQueue(request);
  presenceAckInFlight = false;

  if (!result.ok && !result.queued) {
    console.error('Presence confirmation failed', result.error);
    const parsed = parseApiError(result.error);
    showToast(`Presence confirmation failed: ${parsed.message}`, 'error', parsed.code, parsed.hint);
    if (source === 'overlay' && presenceConfirmBtn) {
      presenceConfirmBtn.disabled = false;
    }
    state.currentPrompt = prompt;
    activePromptId = prompt.id;
    requestPresencePopup(prompt);
    togglePresenceModal(true);
    return;
  }

  state.currentPrompt = null;
  activePromptId = null;
  togglePresenceModal(false);
  window.attendance.closePresencePrompt(prompt.id);
};

const confirmPresence = async () => {
  await acknowledgePresencePrompt('overlay');
};

const requireSessionAndSend = async (path: string, description: string) => {
  if (!state.token) {
    const authenticated = await ensureAuthenticated();
    if (!authenticated) {
      return;
    }
  }

  if (!state.sessionId) {
    await startSession();
    if (!state.sessionId) {
      console.warn('No active session for action');
      return;
    }
  }

  const request: ApiRequest = {
    path,
    body: { sessionId: state.sessionId, timestamp: new Date().toISOString() },
    requiresAuth: path.startsWith('/api/time-requests') ? true : false,
    description
  };

  console.info('[ui]', {
    event: 'api_attempt',
    description,
    path,
    payload: request.body,
    sessionId: state.sessionId
  });

  const result = await sendOrQueue(request);
  if (result.ok) {
    const payload = typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : undefined;
    const pausePayload = payload ? parsePausePayload(payload.pause) : undefined;
    if (pausePayload) {
      const updatedPauseState = applyPauseUpdate(
        { current: state.currentPause, history: state.pauseHistory },
        pausePayload,
        new Date()
      );
      applyPauseStateFromUpdate(updatedPauseState);
      return;
    }

    if (path === '/api/events/break/start') {
      state.sessionState = 'break';
      updateStatus();
      return;
    }
    if (path === '/api/events/break/end') {
      state.currentPause = null;
      stopPauseTimer();
      state.sessionState = 'active';
      updateStatus();
      return;
    }
    if (path === '/api/events/lunch/start') {
      state.sessionState = 'lunch';
      updateStatus();
      return;
    }
    if (path === '/api/events/lunch/end') {
      state.currentPause = null;
      stopPauseTimer();
      state.sessionState = 'active';
      updateStatus();
      return;
    }
    return;
  }
  if (!result.queued) {
    console.error(`${description} failed`, result.error);
    const parsed = parseApiError(result.error);
    showToast(`${description} failed: ${parsed.message}`, 'error', parsed.code, parsed.hint);
    return;
  }
  showToast(`${description} queued`, 'info');
};

const initPresenceHandlers = () => {
  if (presenceConfirmBtn) {
    presenceConfirmBtn.addEventListener('click', () => {
      void confirmPresence();
    });
  }

  if (presenceDismissBtn) {
    presenceDismissBtn.addEventListener('click', () => {
      togglePresenceModal(false);
    });
  }

  window.attendance.onPresenceWindowConfirm((promptId) => {
    if (!activePromptId || promptId !== activePromptId) {
      return;
    }
    void acknowledgePresencePrompt('popup');
  });

  window.attendance.onPresenceWindowDismiss((promptId) => {
    if (activePromptId && promptId === activePromptId) {
      togglePresenceModal(false);
    }
  });
};

const initSettingsHandlers = () => {
  const populate = () => {
    if (!state.settings) {
      return;
    }
    if (settingsBaseUrlInput) {
      settingsBaseUrlInput.value = state.settings.serverBaseUrl;
    }
    if (settingsEmailInput) {
      settingsEmailInput.value = state.settings.workEmail ?? '';
    }
    if (state.lastHealthSuccess) {
      state.healthStatus = {
        state: 'success',
        baseUrl: state.lastHealthSuccess.baseUrl,
        version: state.lastHealthSuccess.version,
        time: state.lastHealthSuccess.time
      };
    } else {
      state.healthStatus = { state: 'idle' };
    }
    renderHealthStatus();
  };

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', () => {
      populate();
      toggleSettingsModal(true);
    });
  }

  if (settingsCancelBtn) {
    settingsCancelBtn.addEventListener('click', () => {
      toggleSettingsModal(false);
    });
  }

  if (settingsTestBtn && settingsBaseUrlInput) {
    settingsTestBtn.addEventListener('click', async () => {
      const baseUrlValue = settingsBaseUrlInput.value.trim();
      if (!baseUrlValue) {
        if (settingsErrorEl) {
          settingsErrorEl.textContent = 'Enter a URL to test.';
        }
        return;
      }

      if (settingsErrorEl) {
        settingsErrorEl.textContent = '';
        settingsErrorEl.innerHTML = '';
      }

      state.healthStatus = { state: 'testing', baseUrl: baseUrlValue };
      renderHealthStatus();

      settingsTestBtn.disabled = true;

      const buildHealthUrl = () => {
        try {
          return new URL('/api/health', baseUrlValue).toString();
        } catch (_error) {
          return null;
        }
      };

      const healthUrl = buildHealthUrl();
      if (!healthUrl) {
        state.healthStatus = { state: 'error', baseUrl: baseUrlValue, detail: 'Invalid server URL.' };
        renderHealthStatus();
        settingsTestBtn.disabled = false;
        return;
      }

      try {
        const response = await window.fetch(healthUrl, { method: 'GET' });
        if (!response.ok) {
          const detail = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
          state.healthStatus = { state: 'error', baseUrl: baseUrlValue, detail };
          renderHealthStatus();
          return;
        }

        const data = (await response.json()) as { ok?: boolean; version?: string; time?: string };
        if (!data?.ok || typeof data.version !== 'string' || typeof data.time !== 'string') {
          state.healthStatus = {
            state: 'error',
            baseUrl: baseUrlValue,
            detail: 'Invalid health response.'
          };
          renderHealthStatus();
          return;
        }

        const parsedTime = new Date(data.time);
        if (Number.isNaN(parsedTime.getTime())) {
          state.healthStatus = {
            state: 'error',
            baseUrl: baseUrlValue,
            detail: 'Invalid timestamp in response.'
          };
          renderHealthStatus();
          return;
        }

        state.healthStatus = {
          state: 'success',
          baseUrl: baseUrlValue,
          version: data.version,
          time: parsedTime
        };
        state.lastHealthSuccess = {
          baseUrl: baseUrlValue,
          version: data.version,
          time: parsedTime
        };
        renderHealthStatus();
      } catch (error) {
        const detail = error instanceof Error ? `Network error: ${error.message}` : 'Network error.';
        state.healthStatus = { state: 'error', baseUrl: baseUrlValue, detail };
        renderHealthStatus();
      } finally {
        settingsTestBtn.disabled = false;
      }
    });
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      const baseUrlValue = settingsBaseUrlInput?.value.trim() ?? '';
      const workEmailValue = settingsEmailInput?.value.trim().toLowerCase() ?? '';
      if (!baseUrlValue) {
        if (settingsErrorEl) {
          settingsErrorEl.textContent = 'Server URL is required.';
        }
        return;
      }

      if (!workEmailValue) {
        if (settingsErrorEl) {
          settingsErrorEl.textContent = 'Work email is required.';
        }
        return;
      }

      try {
        const updatedConfig = await window.attendance.updateSettings({
          serverBaseUrl: baseUrlValue,
          workEmail: workEmailValue || null
        });
        state.settings = updatedConfig;
        if (state.bootstrap) {
          state.bootstrap.baseUrl = updatedConfig.serverBaseUrl;
        }
        apiClient.setBaseUrl(updatedConfig.serverBaseUrl);
        state.email = updatedConfig.workEmail ?? state.email;
        if (loginEmailInput && updatedConfig.workEmail) {
          loginEmailInput.value = updatedConfig.workEmail;
        }
        void offlineQueue.process();
        state.lastHealthSuccess = null;
        state.healthStatus = { state: 'idle' };
        renderHealthStatus();
        if (settingsSuccessEl) {
          settingsSuccessEl.textContent = 'Settings updated.';
        }
        if (settingsErrorEl) {
          settingsErrorEl.textContent = '';
        }
        toggleSettingsModal(false);
      } catch (error) {
        if (settingsErrorEl) {
          settingsErrorEl.textContent = 'Failed to update server URL.';
        }
        console.error('Settings update failed', error);
      }
    });
  }
};

const initRequestHandlers = () => {
  if (openRequestsBtn) {
    openRequestsBtn.addEventListener('click', async () => {
      if (!state.token) {
        const authenticated = await ensureAuthenticated();
        if (!authenticated) {
          return;
        }
      }
      await fetchRequests();
      toggleRequestModal(true);
    });
  }

  if (requestCancelBtn) {
    requestCancelBtn.addEventListener('click', () => {
      toggleRequestModal(false);
    });
  }

  if (requestForm) {
    requestForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await submitRequest();
    });
  }

  if (refreshRequestsBtn) {
    refreshRequestsBtn.addEventListener('click', () => {
      void fetchRequests();
    });
  }
};

const initTimesheetHandlers = () => {
  ensureTimesheetFormDefaults();

  if (openTimesheetBtn) {
    openTimesheetBtn.addEventListener('click', async () => {
      const authenticated = state.token ? true : await ensureAuthenticated();
      if (!authenticated) {
        return;
      }
      toggleTimesheetModal(true);
    });
  }

  if (timesheetCloseBtn) {
    timesheetCloseBtn.addEventListener('click', () => {
      toggleTimesheetModal(false);
    });
  }

  if (timesheetViewSelect) {
    timesheetViewSelect.addEventListener('change', () => {
      const view = timesheetViewSelect.value as TimesheetView;
      updateTimesheetInputVisibility(view);
      state.timesheetView = view;
      state.timesheetReference = view === 'monthly'
        ? timesheetMonthInput?.value?.trim() ?? null
        : timesheetDateInput?.value?.trim() ?? null;
    });
  }

  if (timesheetFilterForm) {
    timesheetFilterForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const { view, date, month } = getTimesheetRequestValues();
      await fetchTimesheet({ view, date: date ?? undefined, month: month ?? undefined });
    });
  }

  if (timesheetRefreshBtn) {
    timesheetRefreshBtn.addEventListener('click', async () => {
      const { view, date, month } = getTimesheetRequestValues();
      await fetchTimesheet({ view, date: date ?? undefined, month: month ?? undefined });
    });
  }

  if (timesheetRequestsRefreshBtn) {
    timesheetRequestsRefreshBtn.addEventListener('click', async () => {
      const { view, date, month } = getTimesheetRequestValues();
      await fetchTimesheet({ view, date: date ?? undefined, month: month ?? undefined, silent: true });
    });
  }

  if (timesheetTableBody) {
    timesheetTableBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.matches('[data-action="timesheet-request-edit"]')) {
        return;
      }
      const date = target.getAttribute('data-date');
      const label = target.getAttribute('data-label') ?? (date ? formatLocalDate(date) : 'Selected day');
      if (date) {
        openTimesheetEditRequest(date, label);
      }
    });
  }

  if (timesheetEditCancelBtn) {
    timesheetEditCancelBtn.addEventListener('click', () => {
      toggleTimesheetEditModal(false);
    });
  }

  if (timesheetEditForm) {
    timesheetEditForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!pendingTimesheetEdit || !state.timesheet) {
        return;
      }

      const reason = timesheetEditReasonInput?.value.trim() ?? '';
      if (!reason) {
        if (timesheetEditErrorEl) {
          timesheetEditErrorEl.textContent = 'Reason is required.';
        }
        if (timesheetEditSuccessEl) {
          timesheetEditSuccessEl.textContent = '';
        }
        return;
      }

      const hoursValueRaw = timesheetEditHoursInput?.value.trim() ?? '';
      let requestedMinutes: number | undefined;
      if (hoursValueRaw) {
        const parsed = Number.parseFloat(hoursValueRaw);
        if (Number.isNaN(parsed) || parsed < 0) {
          if (timesheetEditErrorEl) {
            timesheetEditErrorEl.textContent = 'Hours must be zero or greater.';
          }
          if (timesheetEditSuccessEl) {
            timesheetEditSuccessEl.textContent = '';
          }
          return;
        }
        if (parsed > 0) {
          requestedMinutes = Math.round(parsed * 60);
        }
      }

      if (timesheetEditErrorEl) {
        timesheetEditErrorEl.textContent = '';
      }
      if (timesheetEditSuccessEl) {
        timesheetEditSuccessEl.textContent = 'Submitting...';
      }

      const payload: Record<string, unknown> = {
        view: state.timesheet.view,
        rangeStart: state.timesheet.rangeStart,
        targetDate: pendingTimesheetEdit.date,
        reason
      };
      if (requestedMinutes && requestedMinutes > 0) {
        payload.requestedMinutes = requestedMinutes;
      }

      const result = await sendOrQueue({
        path: '/api/timesheets/edit-requests',
        body: payload,
        requiresAuth: true,
        description: 'Submit Timesheet Edit'
      });

      if (result.ok) {
        if (timesheetEditSuccessEl) {
          timesheetEditSuccessEl.textContent = 'Edit request submitted.';
        }
        showToast('Edit request submitted', 'success');
        toggleTimesheetEditModal(false);
        await fetchTimesheet({
          view: state.timesheet.view,
          date: state.timesheet.view === 'monthly' ? undefined : state.timesheetReference ?? undefined,
          month: state.timesheet.view === 'monthly' ? state.timesheetReference ?? undefined : undefined,
          silent: true
        });
      } else if (result.queued) {
        if (timesheetEditSuccessEl) {
          timesheetEditSuccessEl.textContent = 'Offline: request queued and will submit automatically.';
        }
        toggleTimesheetEditModal(false);
      } else {
        const parsed = parseApiError(result.error);
        if (timesheetEditErrorEl) {
          timesheetEditErrorEl.textContent = parsed.message;
        }
        if (timesheetEditSuccessEl) {
          timesheetEditSuccessEl.textContent = '';
        }
      }
    });
  }
};

const initActionButtons = () => {
  buttons.forEach((button) => {
    const actionKey = button.dataset.action;
    if (!actionKey) {
      return;
    }

    button.addEventListener('click', async () => {
      console.info('[ui]', {
        event: 'button_click',
        action: actionKey,
        sessionId: state.sessionId,
        tokenPresent: Boolean(state.token)
      });
      window.attendance.logAction(actionKey);
      switch (actionKey) {
        case 'log-in':
          if (await ensureAuthenticated()) {
            if (!state.sessionId) {
              await startSession();
            }
          }
          break;
        case 'start-break':
          await requireSessionAndSend('/api/events/break/start', 'Start Break');
          break;
        case 'end-break':
          await requireSessionAndSend('/api/events/break/end', 'End Break');
          break;
        case 'start-lunch':
          await requireSessionAndSend('/api/events/lunch/start', 'Start Lunch');
          break;
        case 'end-lunch':
          await requireSessionAndSend('/api/events/lunch/end', 'End Lunch');
          break;
        case 'log-out':
          await endSession();
          break;
        default:
          console.warn(`Unknown action: ${actionKey}`);
      }
    });
  });
};

const bootstrap = async () => {
  const bootstrapData = await window.attendance.getBootstrap();
  state.bootstrap = bootstrapData;

  const uiMode = bootstrapData.presenceUiMode;
  if (uiMode === 'overlay' || uiMode === 'popup' || uiMode === 'both') {
    presenceUiMode = uiMode;
  } else {
    presenceUiMode = 'both';
  }

  const settings = await window.attendance.getSettings();
  state.settings = settings;
  state.email = settings.workEmail ?? state.email;
  if (loginEmailInput && state.email) {
    loginEmailInput.value = state.email;
  }

  const baseUrl = settings.serverBaseUrl ?? bootstrapData.baseUrl;
  bootstrapData.baseUrl = baseUrl;

  apiClient = new ApiClient(baseUrl);
  offlineQueue = new OfflineQueue(apiClient);
  await offlineQueue.initialize();

  window.addEventListener('online', () => {
    void offlineQueue.process();
    void fetchRequests();
  });
};

const init = async () => {
  await bootstrap();
  initActivityTracking();
  initPresenceHandlers();
  initSettingsHandlers();
  initRequestHandlers();
  initTimesheetHandlers();
  initActionButtons();
  updateStatus();
  renderRequests();
  void fetchSystemStatus();
};

export const __test = {
  resolvePresencePrompt,
  shouldDisplayPresencePrompt,
  showPresencePrompt,
  confirmPresence,
  acknowledgePresencePrompt,
  getPresenceModal: () => presenceModal,
  getPresenceConfirmButton: () => presenceConfirmBtn,
  getState: () => state,
  setSendOrQueueHandler,
  resetSendOrQueueHandler,
  setPresenceUiMode: (mode: PresenceUiMode) => {
    presenceUiMode = mode;
  }
};

void init();

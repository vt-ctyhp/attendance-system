"use strict";
(() => {
  // src/renderer/pauseLogic.ts
  var MINUTE_MS = 6e4;
  var computePauseDuration = (record, now) => record.durationMinutes ?? Math.max(0, Math.ceil(((record.endedAt ?? now).getTime() - record.startedAt.getTime()) / MINUTE_MS));
  var createRecord = (snapshot, now) => ({
    kind: snapshot.kind,
    sequence: snapshot.sequence,
    startedAt: new Date(snapshot.startedAt),
    endedAt: snapshot.endedAt ? new Date(snapshot.endedAt) : null,
    durationMinutes: snapshot.durationMinutes
  });
  var upsertHistory = (history, entry) => {
    const next = history.filter((item) => !(item.kind === entry.kind && item.sequence === entry.sequence));
    next.push(entry);
    next.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    return next;
  };
  var applyPauseUpdate = (state2, payload, now) => {
    const existingCurrent = state2.current;
    const baseRecord = {
      kind: payload.kind,
      sequence: payload.sequence,
      startedAt: new Date(payload.startedAt),
      endedAt: payload.endedAt ? new Date(payload.endedAt) : null,
      durationMinutes: payload.durationMinutes
    };
    if (payload.action === "start") {
      if (existingCurrent && existingCurrent.kind === baseRecord.kind && existingCurrent.sequence === baseRecord.sequence && existingCurrent.startedAt.getTime() === baseRecord.startedAt.getTime()) {
        return state2;
      }
      return {
        current: { ...baseRecord, endedAt: null, durationMinutes: null },
        history: state2.history.filter(
          (item) => !(item.kind === baseRecord.kind && item.sequence === baseRecord.sequence)
        )
      };
    }
    const durationMinutes = computePauseDuration(baseRecord, now);
    const updatedHistory = upsertHistory(state2.history, {
      ...baseRecord,
      endedAt: baseRecord.endedAt,
      durationMinutes
    });
    const nextCurrent = existingCurrent && existingCurrent.kind === baseRecord.kind && existingCurrent.sequence === baseRecord.sequence ? null : existingCurrent;
    return { current: nextCurrent, history: updatedHistory };
  };
  var buildPauseState = (snapshot, now) => {
    const historyRecords = snapshot.history.map((entry) => ({
      kind: entry.kind,
      sequence: entry.sequence,
      startedAt: new Date(entry.startedAt),
      endedAt: entry.endedAt ? new Date(entry.endedAt) : null,
      durationMinutes: entry.durationMinutes ?? null
    })).map((entry) => ({
      ...entry,
      durationMinutes: entry.durationMinutes ?? computePauseDuration(entry, now)
    })).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const currentRecord = snapshot.current ? createRecord(snapshot.current, now) : null;
    const normalizedHistory = currentRecord ? historyRecords.filter(
      (item) => !(item.kind === currentRecord.kind && item.sequence === currentRecord.sequence)
    ) : historyRecords;
    return {
      current: currentRecord,
      history: normalizedHistory
    };
  };
  var formatPauseLabel = (record) => `${record.kind === "break" ? "Break" : "Lunch"} ${record.sequence}`;

  // src/renderer/index.ts
  var HEARTBEAT_INTERVAL_MS = 6e4;
  var IDLE_THRESHOLD_SECONDS = 10 * 60;
  var PRESENCE_CONFIRMATION_WINDOW_MS = 6e4;
  var ACTIVITY_HISTORY_MINUTES = 10;
  var ApiError = class extends Error {
    constructor(message, status, body, requestId) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
      this.requestId = requestId;
    }
  };
  var ApiClient = class {
    constructor(baseUrl) {
      this.baseUrl = baseUrl;
      this.token = null;
    }
    setToken(token) {
      this.token = token;
    }
    setBaseUrl(url) {
      this.baseUrl = url;
    }
    getToken() {
      return this.token;
    }
    async request(request) {
      const { path, method = "POST", body, requiresAuth = false, tokenOverride, transform } = request;
      const normalizedMethod = method.toUpperCase();
      const isGetRequest = normalizedMethod === "GET";
      const headers = { "Content-Type": "application/json" };
      const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req_${Math.random().toString(36).slice(2, 10)}`;
      headers["X-Debug-Req"] = requestId;
      const authToken = requiresAuth ? tokenOverride ?? this.token : null;
      if (requiresAuth && !authToken) {
        throw new ApiError("No authentication token available");
      }
      if (requiresAuth && authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }
      if (isGetRequest) {
        headers["Cache-Control"] = "no-cache";
        headers.Pragma = "no-cache";
      }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "if-none-match") {
          delete headers[key];
        }
      }
      const stringify = (payload) => {
        if (payload === void 0 || payload === null) {
          return "";
        }
        try {
          const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
          return raw.length > 1024 ? `${raw.slice(0, 1024)}\u2026` : raw;
        } catch (error) {
          return `[unserializable:${error.message}]`;
        }
      };
      const executeFetch = async (attempt) => {
        const url = new URL(path, this.baseUrl);
        if (isGetRequest) {
          url.searchParams.set("_t", Date.now().toString());
        }
        const fetchHeaders = { ...headers };
        const requestInit = { method: normalizedMethod, headers: fetchHeaders };
        if (isGetRequest) {
          requestInit.cache = attempt === 0 ? "no-store" : "reload";
        }
        if (body !== void 0) {
          requestInit.body = JSON.stringify(body);
        }
        console.info("[api]", {
          phase: "request",
          attempt: attempt + 1,
          method: normalizedMethod,
          url: url.toString(),
          requestId,
          body: attempt === 0 ? stringify(body) : void 0
        });
        try {
          return await fetch(url.toString(), requestInit);
        } catch (error) {
          console.error("[api]", {
            phase: "network_error",
            method: normalizedMethod,
            url: url.toString(),
            requestId,
            message: error.message
          });
          recordRequestTrace({ requestId, url: url.toString(), status: -1 });
          throw new ApiError(error.message, void 0, void 0, requestId);
        }
      };
      let response = await executeFetch(0);
      if (response.status === 304 && isGetRequest) {
        console.warn("[api]", {
          phase: "not_modified_retry",
          method: normalizedMethod,
          path,
          requestId
        });
        response = await executeFetch(1);
      }
      if (response.status === 204) {
        console.info("[api]", {
          phase: "response",
          method: normalizedMethod,
          path,
          status: 204,
          requestId
        });
        recordRequestTrace({ requestId, url: new URL(path, this.baseUrl).toString(), status: 204 });
        return void 0;
      }
      if (!response.ok) {
        let errorBody = null;
        let snippet = "";
        try {
          const raw = await response.text();
          snippet = stringify(raw);
          const contentType2 = response.headers.get("content-type");
          errorBody = contentType2 && contentType2.includes("application/json") ? JSON.parse(raw) : raw;
        } catch (error) {
          errorBody = error.message;
          snippet = stringify(errorBody);
        }
        console.warn("[api]", {
          phase: "response_error",
          method: normalizedMethod,
          path,
          status: response.status,
          requestId,
          body: snippet
        });
        recordRequestTrace({ requestId, url: `${this.baseUrl}${path}`, status: response.status });
        throw new ApiError(`Request failed with status ${response.status}`, response.status, errorBody, requestId);
      }
      const contentType = response.headers.get("content-type");
      let data;
      if (contentType && contentType.includes("application/json")) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      const serverDateHeader = response.headers.get("date");
      processServerDateHeader(serverDateHeader, requestId);
      console.info("[api]", {
        phase: "response",
        method: normalizedMethod,
        path,
        status: response.status,
        requestId
      });
      recordRequestTrace({ requestId, url: `${this.baseUrl}${path}`, status: response.status });
      return transform ? transform(data) : data;
    }
  };
  var OfflineQueue = class {
    constructor(client) {
      this.client = client;
      this.queue = [];
      this.processing = false;
      this.hydrated = false;
    }
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
        console.warn("Failed to hydrate offline queue", error);
      }
      this.hydrated = true;
      if (this.queue.length > 0) {
        void this.process();
      }
    }
    hasPending() {
      return this.queue.length > 0;
    }
    enqueue(request) {
      const { transform: _unused, ...rest } = request;
      const entry = {
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
    async persist() {
      try {
        if (this.queue.length > 0) {
          await window.attendance.saveOfflineQueue(this.queue);
        } else {
          await window.attendance.clearOfflineQueue();
        }
      } catch (error) {
        console.warn("Failed to persist offline queue", error);
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
          const delay = Math.min(6e4, Math.pow(2, request.attempt) * 1e3);
          request.nextAttemptAt = Date.now() + delay;
          console.warn(`[OfflineQueue] ${request.description ?? request.path} retry in ${delay / 1e3}s`, error);
          await this.persist();
        }
      }
      this.processing = false;
    }
  };
  var state = {
    bootstrap: null,
    email: null,
    token: null,
    refreshToken: null,
    tokenExpiresAt: null,
    tokenScope: null,
    sessionId: null,
    sessionState: "inactive",
    lastHeartbeatAt: null,
    currentPrompt: null,
    settings: null,
    systemStatus: null,
    requests: [],
    user: null,
    timesheet: null,
    timesheetView: "pay_period",
    timesheetReference: null,
    timesheetTimezone: null,
    timesheetLoading: false,
    lastServerSkewMs: null,
    lastServerDate: null,
    lastRequestTrace: null,
    pauseHistory: [],
    currentPause: null,
    healthStatus: { state: "idle" },
    lastHealthSuccess: null
  };
  var activityBuckets = /* @__PURE__ */ new Map();
  var heartbeatTimer = null;
  var presenceTimeout = null;
  var pauseTimer = null;
  var apiClient;
  var offlineQueue;
  var refreshInFlight = null;
  var pendingTimesheetEdit = null;
  var applyAuthTokens = (tokens) => {
    state.token = tokens.accessToken;
    state.refreshToken = tokens.refreshToken;
    state.tokenExpiresAt = tokens.accessTokenExpiresAt ? new Date(tokens.accessTokenExpiresAt) : null;
    state.tokenScope = tokens.scope ?? null;
    apiClient.setToken(tokens.accessToken);
    updateDiagnostics();
  };
  var getDeviceId = () => state.settings?.deviceId ?? state.bootstrap?.deviceId ?? "";
  var statusEmailEl = document.getElementById("status-email");
  var statusSessionEl = document.getElementById("status-session");
  var statusHeartbeatEl = document.getElementById("status-heartbeat");
  var statusPauseEl = document.getElementById("status-pause");
  var statusForegroundEl = document.getElementById("status-foreground");
  var loginModal = document.getElementById("login-modal");
  var loginForm = document.getElementById("login-form");
  var loginEmailInput = document.getElementById("login-email");
  var loginErrorEl = document.getElementById("login-error");
  var loginCancelBtn = document.getElementById("login-cancel");
  var presenceModal = document.getElementById("presence-modal");
  var presenceMessageEl = document.getElementById("presence-message");
  var presenceConfirmBtn = document.getElementById("presence-confirm");
  var presenceDismissBtn = document.getElementById("presence-dismiss");
  var settingsModal = document.getElementById("settings-modal");
  var settingsForm = document.getElementById("settings-form");
  var settingsEmailInput = document.getElementById("settings-email");
  var settingsBaseUrlInput = document.getElementById("settings-base-url");
  var settingsErrorEl = document.getElementById("settings-error");
  var settingsSuccessEl = document.getElementById("settings-success");
  var settingsCancelBtn = document.getElementById("settings-cancel");
  var settingsTestBtn = document.getElementById("settings-test");
  var openSettingsBtn = document.getElementById("open-settings");
  var openRequestsBtn = document.getElementById("open-requests");
  var refreshRequestsBtn = document.getElementById("refresh-requests");
  var requestsListEl = document.getElementById("requests-list");
  var requestsEmptyEl = document.getElementById("requests-empty");
  var diagnosticsPanel = document.getElementById("diagnostics");
  var diagnosticsContentEl = document.getElementById("diagnostics-content");
  var toastEl = document.getElementById("app-toast");
  var requestModal = document.getElementById("request-modal");
  var requestForm = document.getElementById("request-form");
  var requestCancelBtn = document.getElementById("request-cancel");
  var requestTypeInput = document.getElementById("request-type");
  var requestStartDateInput = document.getElementById("request-start-date");
  var requestEndDateInput = document.getElementById("request-end-date");
  var requestHoursInput = document.getElementById("request-hours");
  var requestReasonInput = document.getElementById("request-reason");
  var requestErrorEl = document.getElementById("request-error");
  var requestSuccessEl = document.getElementById("request-success");
  var openTimesheetBtn = document.getElementById("open-timesheet");
  var timesheetModal = document.getElementById("timesheet-modal");
  var timesheetFilterForm = document.getElementById("timesheet-filter");
  var timesheetViewSelect = document.getElementById("timesheet-view");
  var timesheetDateGroup = document.getElementById("timesheet-date-group");
  var timesheetMonthGroup = document.getElementById("timesheet-month-group");
  var timesheetDateInput = document.getElementById("timesheet-date");
  var timesheetMonthInput = document.getElementById("timesheet-month");
  var timesheetSummaryEl = document.getElementById("timesheet-summary");
  var timesheetTable = document.getElementById("timesheet-table");
  var timesheetTableBody = document.getElementById("timesheet-table-body");
  var timesheetEmptyEl = document.getElementById("timesheet-empty");
  var timesheetLoadingEl = document.getElementById("timesheet-loading");
  var timesheetCloseBtn = document.getElementById("timesheet-close");
  var timesheetRefreshBtn = document.getElementById("timesheet-refresh");
  var timesheetRequestsSection = document.getElementById("timesheet-requests-section");
  var timesheetRequestsRefreshBtn = document.getElementById("timesheet-requests-refresh");
  var timesheetRequestsList = document.getElementById("timesheet-requests-list");
  var timesheetRequestsEmpty = document.getElementById("timesheet-requests-empty");
  var timesheetEditModal = document.getElementById("timesheet-edit-modal");
  var timesheetEditForm = document.getElementById("timesheet-edit-form");
  var timesheetEditDateLabel = document.getElementById("timesheet-edit-date-label");
  var timesheetEditReasonInput = document.getElementById("timesheet-edit-reason");
  var timesheetEditHoursInput = document.getElementById("timesheet-edit-hours");
  var timesheetEditErrorEl = document.getElementById("timesheet-edit-error");
  var timesheetEditSuccessEl = document.getElementById("timesheet-edit-success");
  var timesheetEditCancelBtn = document.getElementById("timesheet-edit-cancel");
  var buttons = document.querySelectorAll("[data-action]");
  var presenceUiMode = "both";
  var activePromptId = null;
  var presenceAckInFlight = false;
  var isPopupModeEnabled = () => presenceUiMode === "popup" || presenceUiMode === "both";
  var minutesLabel = (minutes) => `${Math.max(0, minutes)} min`;
  var escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  var renderHealthStatus = () => {
    if (!settingsSuccessEl || !settingsErrorEl) {
      return;
    }
    settingsSuccessEl.textContent = "";
    settingsSuccessEl.innerHTML = "";
    settingsErrorEl.textContent = "";
    settingsErrorEl.innerHTML = "";
    const status = state.healthStatus;
    switch (status.state) {
      case "idle":
        return;
      case "testing":
        settingsSuccessEl.textContent = "Testing connection\u2026";
        return;
      case "success": {
        const formattedTime = new Intl.DateTimeFormat(void 0, {
          dateStyle: "short",
          timeStyle: "short"
        }).format(status.time);
        const html = `<span class="settings-status-badge settings-status-badge--success" aria-hidden="true">\u25CF</span><span> Connected \u2022 v${escapeHtml(
          status.version
        )} \u2022 ${escapeHtml(formattedTime)}</span>`;
        settingsSuccessEl.innerHTML = html;
        return;
      }
      case "error": {
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
  var parsePausePayload = (value) => {
    if (!value || typeof value !== "object") {
      return void 0;
    }
    const raw = value;
    const kind = raw.kind === "break" || raw.kind === "lunch" ? raw.kind : void 0;
    const action = raw.action === "start" || raw.action === "end" ? raw.action : void 0;
    if (!kind || !action) {
      return void 0;
    }
    const sequenceValue = Number(raw.sequence);
    if (!Number.isFinite(sequenceValue)) {
      return void 0;
    }
    const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : void 0;
    if (!startedAt) {
      return void 0;
    }
    const endedAt = typeof raw.endedAt === "string" ? raw.endedAt : raw.endedAt === null ? null : null;
    const durationMinutes = typeof raw.durationMinutes === "number" ? raw.durationMinutes : null;
    return {
      kind,
      action,
      sequence: Math.max(1, Math.floor(sequenceValue)),
      startedAt,
      endedAt,
      durationMinutes
    };
  };
  var parsePauseSnapshot = (value) => {
    if (!value || typeof value !== "object") {
      return void 0;
    }
    const raw = value;
    const kind = raw.kind === "break" || raw.kind === "lunch" ? raw.kind : void 0;
    if (!kind) {
      return void 0;
    }
    const sequenceValue = Number(raw.sequence);
    if (!Number.isFinite(sequenceValue)) {
      return void 0;
    }
    const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : void 0;
    if (!startedAt) {
      return void 0;
    }
    const endedAt = typeof raw.endedAt === "string" ? raw.endedAt : raw.endedAt === null ? null : null;
    const durationMinutes = typeof raw.durationMinutes === "number" ? raw.durationMinutes : null;
    return {
      kind,
      sequence: Math.max(1, Math.floor(sequenceValue)),
      startedAt,
      endedAt,
      durationMinutes
    };
  };
  var parsePauseStateResponse = (value) => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const raw = value;
    const currentRaw = raw.current ?? null;
    const current = currentRaw ? parsePauseSnapshot(currentRaw) ?? null : null;
    const historyRaw = Array.isArray(raw.history) ? raw.history : [];
    const history = historyRaw.map((entry) => parsePauseSnapshot(entry)).filter((entry) => Boolean(entry));
    return { current, history };
  };
  var updatePauseDisplay = () => {
    if (!statusPauseEl) {
      return;
    }
    if (state.currentPause) {
      const minutes = computePauseDuration(state.currentPause, /* @__PURE__ */ new Date());
      statusPauseEl.textContent = `${formatPauseLabel(state.currentPause)} \xB7 ${minutesLabel(minutes)}`;
    } else {
      statusPauseEl.textContent = "No active pause";
    }
  };
  var startPauseTimer = () => {
    if (pauseTimer) {
      return;
    }
    pauseTimer = window.setInterval(() => {
      updatePauseDisplay();
    }, 1e3);
    updatePauseDisplay();
  };
  var stopPauseTimer = () => {
    if (pauseTimer) {
      clearInterval(pauseTimer);
      pauseTimer = null;
    }
    updatePauseDisplay();
  };
  var applyPauseStateFromUpdate = (pauseState) => {
    state.currentPause = pauseState.current;
    state.pauseHistory = pauseState.history;
    if (state.currentPause) {
      state.sessionState = state.currentPause.kind;
      startPauseTimer();
    } else {
      stopPauseTimer();
      if (state.sessionId) {
        state.sessionState = "active";
      }
    }
    updateStatus();
  };
  var minuteKey = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hour}:${minute}`;
  };
  var pruneActivityBuckets = () => {
    const cutoff = /* @__PURE__ */ new Date();
    cutoff.setMinutes(cutoff.getMinutes() - ACTIVITY_HISTORY_MINUTES);
    const cutoffKey = minuteKey(cutoff);
    for (const key of activityBuckets.keys()) {
      if (key < cutoffKey) {
        activityBuckets.delete(key);
      }
    }
  };
  var getActivitySnapshot = () => {
    pruneActivityBuckets();
    const buckets = Array.from(activityBuckets.entries()).map(([key, counts]) => ({
      minute: key,
      keys: counts.keys,
      mouse: counts.mouse
    })).sort((a, b) => a.minute.localeCompare(b.minute));
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
  var registerActivity = (kind) => {
    const key = minuteKey(/* @__PURE__ */ new Date());
    const bucket = activityBuckets.get(key) ?? { keys: 0, mouse: 0 };
    if (kind === "keyboard") {
      bucket.keys += 1;
    } else {
      bucket.mouse += 1;
    }
    activityBuckets.set(key, bucket);
  };
  var initActivityTracking = () => {
    window.addEventListener("keydown", () => registerActivity("keyboard"));
    window.addEventListener("keypress", () => registerActivity("keyboard"));
    window.addEventListener("mousemove", () => registerActivity("mouse"));
    window.addEventListener("mousedown", () => registerActivity("mouse"));
    window.addEventListener("wheel", () => registerActivity("mouse"));
  };
  var updateStatus = () => {
    if (statusEmailEl) {
      statusEmailEl.textContent = state.email ?? "Not logged in";
    }
    if (statusSessionEl) {
      const parts = [];
      if (!state.sessionId) {
        parts.push("No active session");
      } else {
        parts.push("Active session");
        if (state.currentPause) {
          const minutes = computePauseDuration(state.currentPause, /* @__PURE__ */ new Date());
          parts.push(`(${formatPauseLabel(state.currentPause)} \xB7 ${minutesLabel(minutes)})`);
        } else {
          const idleFromSystem = state.systemStatus ? state.systemStatus.idleSeconds >= IDLE_THRESHOLD_SECONDS : state.sessionState === "idle";
          if (idleFromSystem) {
            parts.push("(Idle)");
          }
        }
      }
      statusSessionEl.textContent = parts.join(" ");
    }
    if (statusHeartbeatEl) {
      statusHeartbeatEl.textContent = state.lastHeartbeatAt ? state.lastHeartbeatAt.toLocaleTimeString() : "Never";
    }
    if (statusForegroundEl) {
      if (state.systemStatus?.foregroundApp?.title) {
        const owner = state.systemStatus.foregroundApp.owner;
        statusForegroundEl.textContent = owner ? `${state.systemStatus.foregroundApp.title} (${owner})` : state.systemStatus.foregroundApp.title;
      } else {
        statusForegroundEl.textContent = "Unknown";
      }
    }
    updateControls();
    updateDiagnostics();
    updatePauseDisplay();
  };
  var updateControls = () => {
    buttons.forEach((button) => {
      const action = button.dataset.action;
      if (!action) {
        return;
      }
      if (action === "log-in") {
        button.disabled = false;
        return;
      }
      if (action === "log-out") {
        button.disabled = !state.token;
        return;
      }
      button.disabled = !state.sessionId;
    });
  };
  var toastTimer = null;
  var MAX_CLOCK_SKEW_WARNING_MS = 5 * 60 * 1e3;
  var showToast = (message, variant = "info", code, hint) => {
    if (!toastEl) {
      return;
    }
    const parts = [message];
    if (hint) {
      parts.push(`Hint: ${hint}`);
    }
    const prefix = code ? `[${code}] ` : "";
    toastEl.textContent = `${prefix}${parts.join(" \u2013 ")}`;
    toastEl.dataset.variant = variant;
    toastEl.dataset.visible = "true";
    if (toastTimer) {
      window.clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
      if (toastEl) {
        toastEl.dataset.visible = "false";
      }
    }, 4e3);
  };
  var resolvePresencePrompt = (response) => {
    if (!response || typeof response !== "object") {
      return null;
    }
    const payload = response;
    const candidate = payload.presencePrompt ?? payload.prompt;
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const prompt = candidate;
    if (typeof prompt.id !== "string" || prompt.id.trim().length === 0) {
      return null;
    }
    if (typeof prompt.expiresAt !== "string" || prompt.expiresAt.trim().length === 0) {
      return null;
    }
    return prompt;
  };
  var shouldDisplayPresencePrompt = (prompt) => {
    if (!prompt) {
      return false;
    }
    if (!prompt.id || !prompt.expiresAt) {
      return false;
    }
    if (activePromptId === prompt.id && presenceModal?.dataset.visible === "true") {
      return false;
    }
    return true;
  };
  var presencePayload = (prompt) => ({
    id: prompt.id,
    expiresAt: prompt.expiresAt,
    message: prompt.message ?? void 0
  });
  var requestPresencePopup = (prompt) => {
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
      diagnosticsContentEl.textContent = "";
      return;
    }
    const lines = [
      `localTime: ${(/* @__PURE__ */ new Date()).toLocaleString()}`,
      `sessionId: ${state.sessionId ?? "none"}`,
      `sessionState: ${state.sessionState}`,
      `userId: ${state.user?.id ?? "unknown"}`,
      `role: ${state.user?.role ?? "unknown"}`,
      `tokenScope: ${state.tokenScope ?? "n/a"}`,
      `tokenExpires: ${state.tokenExpiresAt ? state.tokenExpiresAt.toLocaleString() : "n/a"}`,
      `lastReqId: ${state.lastRequestTrace?.requestId ?? "n/a"}`,
      `lastReqStatus: ${state.lastRequestTrace?.status ?? "n/a"}`,
      `clockSkewMs: ${state.lastServerSkewMs ?? "n/a"}`
    ];
    diagnosticsContentEl.textContent = lines.join("\n");
  }
  function processServerDateHeader(dateHeader, requestId) {
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
      console.warn("[diagnostics]", {
        type: "clock_skew",
        skewMs,
        thresholdMs: MAX_CLOCK_SKEW_WARNING_MS,
        requestId,
        serverDate: parsed.toISOString()
      });
    }
    updateDiagnostics();
  }
  function recordRequestTrace(trace) {
    state.lastRequestTrace = trace;
    updateDiagnostics();
  }
  function parseApiError(error) {
    if (error instanceof ApiError) {
      const body = error.body;
      if (body && typeof body === "object") {
        const code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : void 0;
        const message = typeof body.error === "string" ? body.error : error.message;
        const hint = typeof body.hint === "string" ? body.hint : void 0;
        return { message, code, hint };
      }
      return { message: error.message, code: error.status ? String(error.status) : void 0 };
    }
    if (error instanceof Error) {
      return { message: error.message };
    }
    return { message: "Unknown failure" };
  }
  var renderRequests = () => {
    if (!requestsListEl || !requestsEmptyEl) {
      return;
    }
    requestsListEl.innerHTML = "";
    if (!state.requests || state.requests.length === 0) {
      requestsEmptyEl.style.display = "block";
      return;
    }
    requestsEmptyEl.style.display = "none";
    state.requests.slice().sort((a, b) => {
      const aDate = a.createdAt ?? a.startDate;
      const bDate = b.createdAt ?? b.startDate;
      return (bDate ?? "").localeCompare(aDate ?? "");
    }).forEach((request) => {
      const item = document.createElement("li");
      item.className = "requests__item";
      const title = document.createElement("strong");
      title.textContent = `${request.type} \u2022 ${formatDateRange(request.startDate, request.endDate)}`;
      item.appendChild(title);
      const hours = document.createElement("span");
      hours.textContent = `Hours: ${request.hours}`;
      item.appendChild(hours);
      if (request.reason) {
        const reason = document.createElement("span");
        reason.textContent = `Reason: ${request.reason}`;
        item.appendChild(reason);
      }
      const status = document.createElement("span");
      status.className = "requests__status";
      status.textContent = `Status: ${request.status ?? "pending"}`;
      item.appendChild(status);
      requestsListEl.appendChild(item);
    });
  };
  var formatDateRange = (start, end) => {
    if (!end || end === start) {
      return start;
    }
    return `${start} \u2192 ${end}`;
  };
  var isoDateOnly = (value) => value.slice(0, 10);
  var isoMonthOnly = (value) => value.slice(0, 7);
  var minutesToHours = (minutes) => Math.round(minutes / 60 * 100) / 100;
  var formatHours = (hours) => Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(2);
  var formatLocalDate = (iso) => {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      return iso;
    }
    return parsed.toLocaleDateString(void 0, { month: "short", day: "numeric", year: "numeric" });
  };
  var formatStatus = (value) => value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
  var updateTimesheetInputVisibility = (view) => {
    const showMonth = view === "monthly";
    if (timesheetDateGroup) {
      timesheetDateGroup.classList.toggle("hidden", showMonth);
    }
    if (timesheetMonthGroup) {
      timesheetMonthGroup.classList.toggle("hidden", !showMonth);
    }
  };
  var ensureTimesheetFormDefaults = () => {
    if (!timesheetViewSelect) {
      return;
    }
    const view = state.timesheetView ?? "pay_period";
    timesheetViewSelect.value = view;
    updateTimesheetInputVisibility(view);
    const todayIso = (/* @__PURE__ */ new Date()).toISOString();
    if (view === "monthly") {
      if (timesheetMonthInput) {
        timesheetMonthInput.value = state.timesheetReference ?? isoMonthOnly(todayIso);
      }
      if (timesheetDateInput) {
        timesheetDateInput.value = "";
      }
    } else {
      if (timesheetDateInput) {
        timesheetDateInput.value = state.timesheetReference ?? isoDateOnly(todayIso);
      }
      if (timesheetMonthInput) {
        timesheetMonthInput.value = "";
      }
    }
  };
  var toggleTimesheetEditModal = (visible) => {
    if (!timesheetEditModal) {
      return;
    }
    timesheetEditModal.dataset.visible = visible ? "true" : "false";
    if (visible) {
      if (timesheetEditReasonInput) {
        timesheetEditReasonInput.value = "";
      }
      if (timesheetEditHoursInput) {
        timesheetEditHoursInput.value = "";
      }
      if (timesheetEditErrorEl) {
        timesheetEditErrorEl.textContent = "";
      }
      if (timesheetEditSuccessEl) {
        timesheetEditSuccessEl.textContent = "";
      }
    } else {
      pendingTimesheetEdit = null;
      if (timesheetEditErrorEl) {
        timesheetEditErrorEl.textContent = "";
      }
      if (timesheetEditSuccessEl) {
        timesheetEditSuccessEl.textContent = "";
      }
    }
  };
  var renderTimesheetRequests = (summary) => {
    if (!timesheetRequestsSection || !timesheetRequestsList || !timesheetRequestsEmpty) {
      return;
    }
    if (!summary) {
      timesheetRequestsSection.style.display = "none";
      timesheetRequestsList.innerHTML = "";
      timesheetRequestsEmpty.style.display = "block";
      return;
    }
    timesheetRequestsSection.style.display = "block";
    if (!summary.editRequests.length) {
      timesheetRequestsList.innerHTML = "";
      timesheetRequestsEmpty.style.display = "block";
      return;
    }
    timesheetRequestsEmpty.style.display = "none";
    timesheetRequestsList.innerHTML = "";
    summary.editRequests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).forEach((request) => {
      const item = document.createElement("li");
      item.className = "timesheet__request-item";
      const title = document.createElement("strong");
      title.textContent = `${formatLocalDate(request.targetDate)} \u2022 ${formatStatus(request.status)}`;
      item.appendChild(title);
      const reason = document.createElement("p");
      reason.textContent = request.reason;
      item.appendChild(reason);
      const meta = document.createElement("div");
      meta.className = "timesheet__request-meta";
      const statusEl = document.createElement("span");
      statusEl.className = `timesheet__request-status ${request.status}`;
      statusEl.textContent = formatStatus(request.status);
      meta.appendChild(statusEl);
      const createdEl = document.createElement("span");
      createdEl.textContent = `Requested ${formatLocalDate(request.createdAt)}`;
      meta.appendChild(createdEl);
      if (request.reviewedAt) {
        const reviewedEl = document.createElement("span");
        reviewedEl.textContent = `Reviewed ${formatLocalDate(request.reviewedAt)}`;
        meta.appendChild(reviewedEl);
      }
      if (request.requestedMinutes && request.requestedMinutes > 0) {
        const requestedHours = formatHours(minutesToHours(request.requestedMinutes));
        const requestedEl = document.createElement("span");
        requestedEl.textContent = `Requested hours: ${requestedHours}`;
        meta.appendChild(requestedEl);
      }
      if (request.adminNote) {
        const noteEl = document.createElement("span");
        noteEl.textContent = `Admin note: ${request.adminNote}`;
        meta.appendChild(noteEl);
      }
      item.appendChild(meta);
      timesheetRequestsList.appendChild(item);
    });
  };
  var renderTimesheet = () => {
    if (!timesheetSummaryEl || !timesheetEmptyEl || !timesheetTableBody || !timesheetLoadingEl) {
      return;
    }
    const loading = state.timesheetLoading;
    const summary = state.timesheet;
    timesheetLoadingEl.hidden = !loading;
    if (loading) {
      timesheetSummaryEl.innerHTML = "";
      timesheetTableBody.innerHTML = "";
      if (timesheetEmptyEl) {
        timesheetEmptyEl.style.display = "none";
      }
      if (timesheetTable) {
        timesheetTable.style.display = "none";
      }
      renderTimesheetRequests(summary);
      return;
    }
    if (!summary) {
      timesheetSummaryEl.innerHTML = "";
      timesheetTableBody.innerHTML = "";
      if (timesheetEmptyEl) {
        timesheetEmptyEl.style.display = "block";
        timesheetEmptyEl.textContent = "No activity recorded for this range.";
      }
      if (timesheetTable) {
        timesheetTable.style.display = "none";
      }
      renderTimesheetRequests(summary);
      return;
    }
    const summaryCards = [
      `<div class="timesheet__summary-item"><span>Range</span><strong>${summary.label}</strong><small>${state.timesheetTimezone ?? ""}</small></div>`,
      `<div class="timesheet__summary-item"><span>Active Hours</span><strong>${formatHours(summary.totals.activeHours)}</strong><small>${summary.totals.activeMinutes} min</small></div>`,
      `<div class="timesheet__summary-item"><span>Idle Hours</span><strong>${formatHours(summary.totals.idleHours)}</strong><small>${summary.totals.idleMinutes} min</small></div>`,
      `<div class="timesheet__summary-item"><span>Breaks</span><strong>${summary.totals.breaks}</strong></div>`,
      `<div class="timesheet__summary-item"><span>Lunches</span><strong>${summary.totals.lunches}</strong></div>`,
      `<div class="timesheet__summary-item"><span>Presence Misses</span><strong>${summary.totals.presenceMisses}</strong></div>`
    ];
    timesheetSummaryEl.innerHTML = summaryCards.join("");
    if (timesheetTable) {
      timesheetTable.style.display = summary.days.length ? "table" : "none";
    }
    if (timesheetEmptyEl) {
      timesheetEmptyEl.style.display = summary.days.length ? "none" : "block";
    }
    timesheetTableBody.innerHTML = "";
    summary.days.forEach((day) => {
      const row = document.createElement("tr");
      const dateCell = document.createElement("td");
      dateCell.textContent = day.label;
      row.appendChild(dateCell);
      const activeCell = document.createElement("td");
      activeCell.textContent = formatHours(minutesToHours(day.activeMinutes));
      row.appendChild(activeCell);
      const idleCell = document.createElement("td");
      idleCell.textContent = formatHours(minutesToHours(day.idleMinutes));
      row.appendChild(idleCell);
      const breaksCell = document.createElement("td");
      breaksCell.textContent = String(day.breaks);
      row.appendChild(breaksCell);
      const lunchesCell = document.createElement("td");
      lunchesCell.textContent = String(day.lunches);
      row.appendChild(lunchesCell);
      const presenceCell = document.createElement("td");
      presenceCell.textContent = String(day.presenceMisses);
      row.appendChild(presenceCell);
      const actionCell = document.createElement("td");
      actionCell.className = "timesheet__action";
      const hasPending = day.editRequests.some((req) => req.status === "pending");
      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.dataset.action = "timesheet-request-edit";
      actionButton.dataset.date = day.date;
      actionButton.dataset.label = day.label;
      actionButton.textContent = hasPending ? "Pending" : "Request Edit";
      actionButton.disabled = hasPending;
      actionCell.appendChild(actionButton);
      if (day.editRequests.length) {
        const note = document.createElement("div");
        note.className = "timesheet__day-note";
        note.textContent = day.editRequests.map((req) => `${formatStatus(req.status)} \u2022 ${formatLocalDate(req.createdAt)}`).join(", ");
        actionCell.appendChild(note);
      }
      row.appendChild(actionCell);
      timesheetTableBody.appendChild(row);
    });
    renderTimesheetRequests(summary);
  };
  var toggleTimesheetModal = (visible) => {
    if (!timesheetModal) {
      return;
    }
    timesheetModal.dataset.visible = visible ? "true" : "false";
    if (visible) {
      ensureTimesheetFormDefaults();
      renderTimesheet();
      void fetchTimesheet({
        view: timesheetViewSelect?.value ?? state.timesheetView,
        date: timesheetDateInput?.value || void 0,
        month: timesheetMonthInput?.value || void 0,
        silent: Boolean(state.timesheet)
      });
    } else {
      toggleTimesheetEditModal(false);
    }
  };
  var openTimesheetEditRequest = (date, label) => {
    if (!state.timesheet) {
      return;
    }
    pendingTimesheetEdit = { date, label };
    if (timesheetEditDateLabel) {
      timesheetEditDateLabel.textContent = `Request change for ${label}`;
    }
    toggleTimesheetEditModal(true);
  };
  var getTimesheetRequestValues = () => {
    const view = timesheetViewSelect?.value ?? state.timesheetView;
    const dateValue = timesheetDateInput?.value?.trim();
    const monthValue = timesheetMonthInput?.value?.trim();
    return {
      view,
      date: view === "monthly" ? null : dateValue && dateValue.length ? dateValue : state.timesheetReference,
      month: view === "monthly" ? monthValue && monthValue.length ? monthValue : state.timesheetReference : null
    };
  };
  var fetchTimesheet = async (options) => {
    const ensureAuth = state.token ? true : await ensureAuthenticated();
    if (!ensureAuth) {
      return;
    }
    const requestValues = options ?? getTimesheetRequestValues();
    const view = requestValues.view ?? state.timesheetView ?? "pay_period";
    const isMonthly = view === "monthly";
    let dateParam = isMonthly ? null : requestValues.date ?? void 0;
    let monthParam = isMonthly ? requestValues.month ?? void 0 : null;
    const todayIso = (/* @__PURE__ */ new Date()).toISOString();
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
      params.set("month", monthParam);
    } else if (dateParam) {
      params.set("date", dateParam);
    }
    const result = await sendOrQueue({
      path: `/api/timesheets?${params.toString()}`,
      method: "GET",
      requiresAuth: true,
      description: "Fetch Timesheet"
    });
    state.timesheetLoading = false;
    if (result.ok) {
      const payload = result.data ?? {};
      const summary = payload && payload.timesheet || payload;
      state.timesheet = summary ?? null;
      state.timesheetView = view;
      state.timesheetReference = isMonthly ? monthParam ?? null : dateParam ?? null;
      state.timesheetTimezone = (payload && payload.timezone) ?? state.timesheetTimezone;
      if (timesheetViewSelect) {
        timesheetViewSelect.value = view;
        updateTimesheetInputVisibility(view);
      }
      if (isMonthly) {
        if (timesheetMonthInput) {
          timesheetMonthInput.value = monthParam ?? (summary ? isoMonthOnly(summary.rangeStart) : "");
        }
        if (timesheetDateInput) {
          timesheetDateInput.value = "";
        }
      } else if (timesheetDateInput) {
        timesheetDateInput.value = dateParam ?? (summary ? isoDateOnly(summary.rangeStart) : "");
      }
      renderTimesheet();
    } else if (result.queued) {
      showToast("Offline: timesheet request queued.", "info");
    } else {
      const parsed = parseApiError(result.error);
      showToast(`Unable to load timesheet: ${parsed.message}`, "error", parsed.code, parsed.hint);
      renderTimesheet();
    }
  };
  var toggleLoginModal = (visible) => {
    if (!loginModal) {
      return;
    }
    loginModal.dataset.visible = visible ? "true" : "false";
    if (!visible) {
      if (loginErrorEl) {
        loginErrorEl.textContent = "";
      }
      const submitButton = loginForm?.querySelector('button[type="submit"]');
      submitButton?.removeAttribute("disabled");
    }
  };
  var togglePresenceModal = (visible) => {
    if (!presenceModal) {
      return;
    }
    presenceModal.dataset.visible = visible ? "true" : "false";
    if (visible) {
      if (presenceConfirmBtn) {
        presenceConfirmBtn.disabled = false;
      }
      if (presenceDismissBtn) {
        presenceDismissBtn.disabled = false;
      }
    }
  };
  var toggleSettingsModal = (visible) => {
    if (!settingsModal) {
      return;
    }
    settingsModal.dataset.visible = visible ? "true" : "false";
    if (!visible) {
      if (settingsErrorEl) {
        settingsErrorEl.textContent = "";
      }
      if (settingsSuccessEl) {
        settingsSuccessEl.textContent = "";
      }
    }
  };
  var resetRequestForm = () => {
    requestForm?.reset();
    if (requestSuccessEl) {
      requestSuccessEl.textContent = "";
    }
    if (requestErrorEl) {
      requestErrorEl.textContent = "";
    }
  };
  var toggleRequestModal = (visible) => {
    if (!requestModal) {
      return;
    }
    requestModal.dataset.visible = visible ? "true" : "false";
    if (visible) {
      if (requestSuccessEl) {
        requestSuccessEl.textContent = "";
      }
      if (requestErrorEl) {
        requestErrorEl.textContent = "";
      }
    } else {
      resetRequestForm();
    }
  };
  var fetchSystemStatus = async () => {
    try {
      const status = await window.attendance.getSystemStatus();
      state.systemStatus = status;
      return status;
    } catch (error) {
      console.warn("Failed to fetch system status", error);
      return state.systemStatus;
    } finally {
      updateStatus();
    }
  };
  var buildHeartbeatPayload = (status) => {
    if (!state.sessionId) {
      throw new Error("Cannot build heartbeat payload without session");
    }
    const { buckets, aggregated } = getActivitySnapshot();
    const idleSeconds = status?.idleSeconds ?? Number.POSITIVE_INFINITY;
    const isIdle = idleSeconds >= IDLE_THRESHOLD_SECONDS;
    const activeMinute = idleSeconds < 60;
    return {
      sessionId: state.sessionId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
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
  var shouldQueue = (error) => {
    if (error instanceof ApiError) {
      if (typeof error.status === "number") {
        return error.status >= 500 || error.status === 429;
      }
      return true;
    }
    return true;
  };
  var refreshAuthToken = async () => {
    if (!state.refreshToken) {
      throw new Error("missing_refresh_token");
    }
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const response = await apiClient.request({
          path: "/api/sessions/refresh",
          body: { refreshToken: state.refreshToken },
          requiresAuth: false,
          description: "Refresh Access Token"
        });
        applyAuthTokens(response);
      })().finally(() => {
        refreshInFlight = null;
      });
    }
    await refreshInFlight;
  };
  var tryRefreshAuthToken = async () => {
    try {
      await refreshAuthToken();
      return true;
    } catch (error) {
      console.warn("Token refresh failed", error);
      return false;
    }
  };
  var sendOrQueueCore = async (request) => {
    const execute = () => apiClient.request(request);
    try {
      const data = await execute();
      return { ok: true, data };
    } catch (error) {
      let finalError = error;
      if (error instanceof ApiError && error.status === 401) {
        const refreshed = await tryRefreshAuthToken();
        if (refreshed) {
          try {
            const data = await execute();
            return { ok: true, data };
          } catch (retryError) {
            finalError = retryError;
          }
        }
        clearAuth();
        return { ok: false, queued: false, error: finalError };
      }
      if (shouldQueue(finalError)) {
        console.warn(`[Queue] ${request.description ?? request.path} queued`, finalError);
        offlineQueue.enqueue({ ...request });
        return { ok: false, queued: true, error: finalError };
      }
      return { ok: false, queued: false, error: finalError };
    }
  };
  var sendOrQueueHandler = sendOrQueueCore;
  var sendOrQueue = async (request) => sendOrQueueHandler(request);
  var setSendOrQueueHandler = (handler) => {
    sendOrQueueHandler = handler;
  };
  var resetSendOrQueueHandler = () => {
    sendOrQueueHandler = sendOrQueueCore;
  };
  var ensureAuthenticated = async () => {
    if (state.token) {
      return true;
    }
    return new Promise((resolve) => {
      if (!loginModal || !loginForm || !loginCancelBtn) {
        resolve(false);
        return;
      }
      let resolved = false;
      const setError = (message) => {
        if (loginErrorEl) {
          loginErrorEl.textContent = message;
        }
      };
      const cleanup = () => {
        loginForm.removeEventListener("submit", submitHandler);
        loginCancelBtn.removeEventListener("click", cancelHandler);
      };
      const submitHandler = async (event) => {
        event.preventDefault();
        const formData = new FormData(loginForm);
        const email = String(formData.get("email") ?? "").trim().toLowerCase();
        const deviceId = getDeviceId();
        if (!email) {
          setError("Enter your work email.");
          return;
        }
        const submitButton = loginForm.querySelector('button[type="submit"]');
        submitButton?.setAttribute("disabled", "true");
        setError("");
        console.info("[ui]", { event: "login_submit", email, deviceId });
        try {
          const response = await apiClient.request({
            path: "/api/sessions/start",
            body: {
              flow: "email_only",
              email,
              ...deviceId ? { deviceId } : {}
            },
            requiresAuth: false,
            description: "Email Sign-In"
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
          window.attendance.logAction("Logged in");
          await fetchRequests();
          showToast("Logged in successfully", "success");
          console.info("[ui]", { event: "login_success", email });
          resolve(true);
        } catch (error) {
          const message = error instanceof ApiError && error.status === 401 ? "We could not verify that email. Check with your manager." : error instanceof ApiError ? error.message : "Sign-in failed. Please try again.";
          setError(message);
          const parsed = parseApiError(error);
          showToast(`Login failed: ${parsed.message}`, "error", parsed.code, parsed.hint);
          submitButton?.removeAttribute("disabled");
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
      loginForm.addEventListener("submit", submitHandler);
      loginCancelBtn.addEventListener("click", cancelHandler, { once: true });
      const observer = new MutationObserver(() => {
        if (loginModal.dataset.visible !== "true") {
          observer.disconnect();
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve(Boolean(state.token));
          }
        }
      });
      observer.observe(loginModal, { attributes: true, attributeFilter: ["data-visible"] });
      if (loginEmailInput) {
        loginEmailInput.value = state.email ?? loginEmailInput.value ?? "";
      }
      setError("");
      toggleLoginModal(true);
      loginEmailInput?.focus();
    });
  };
  var startSession = async () => {
    if (!state.bootstrap) {
      throw new Error("Application not initialized");
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
        console.warn("No employee email available to start session");
        return;
      }
    }
    try {
      const response = await apiClient.request({
        path: "/api/sessions/start",
        body: {
          email: state.email,
          deviceId: state.bootstrap.deviceId,
          platform: state.bootstrap.platform
        },
        requiresAuth: true,
        description: "Start Session"
      });
      const sessionId = response.sessionId ?? response.id;
      if (!sessionId) {
        throw new ApiError("Session ID missing in response");
      }
      state.sessionId = sessionId;
      state.sessionState = "active";
      state.lastHeartbeatAt = null;
      updateStatus();
      await hydratePauseState();
      startHeartbeatLoop();
      void offlineQueue.process();
      void fetchRequests();
      window.attendance.logAction("Session started");
      showToast("Session started", "success");
      console.info("[ui]", { event: "session_started", sessionId });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Unable to start session";
      console.error(message, error);
      const parsed = parseApiError(error);
      showToast(`Unable to start session: ${parsed.message}`, "error", parsed.code, parsed.hint);
    }
  };
  var stopSessionLocally = () => {
    state.sessionId = null;
    state.sessionState = "inactive";
    state.lastHeartbeatAt = null;
    state.currentPause = null;
    state.pauseHistory = [];
    stopPauseTimer();
    updateStatus();
    stopHeartbeatLoop();
  };
  var clearAuth = () => {
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
  var endSession = async () => {
    if (!state.sessionId) {
      return;
    }
    const request = {
      path: "/api/sessions/end",
      body: { sessionId: state.sessionId },
      description: "End Session"
    };
    const result = await sendOrQueue(request);
    if (!result.ok && !result.queued) {
      console.error("Failed to end session", result.error);
      const parsed = parseApiError(result.error);
      showToast(`End session failed: ${parsed.message}`, "error", parsed.code, parsed.hint);
      return;
    }
    stopSessionLocally();
    clearAuth();
    window.attendance.logAction("Session ended");
    showToast("Session ended", "success");
  };
  var startHeartbeatLoop = () => {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = window.setInterval(() => {
      void sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    void sendHeartbeat();
  };
  var stopHeartbeatLoop = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  var sendHeartbeat = async () => {
    if (!state.sessionId) {
      return;
    }
    const status = await fetchSystemStatus();
    const payload = buildHeartbeatPayload(status);
    const request = {
      path: "/api/events/heartbeat",
      body: payload,
      description: "Heartbeat"
    };
    const result = await sendOrQueue(request);
    if (!result.ok) {
      if (!result.queued) {
        console.warn("Heartbeat failed", result.error);
      }
      return;
    }
    state.lastHeartbeatAt = /* @__PURE__ */ new Date();
    if (state.sessionState !== "break" && state.sessionState !== "lunch") {
      state.sessionState = payload.idleFlag ? "idle" : "active";
    }
    updateStatus();
    const response = result.data;
    const prompt = resolvePresencePrompt(response);
    if (prompt && shouldDisplayPresencePrompt(prompt)) {
      showPresencePrompt(prompt);
    }
  };
  var hydratePauseState = async () => {
    if (!state.sessionId) {
      state.currentPause = null;
      state.pauseHistory = [];
      stopPauseTimer();
      updatePauseDisplay();
      return;
    }
    try {
      const response = await apiClient.request({
        path: `/api/sessions/${state.sessionId}/pauses`,
        method: "GET",
        requiresAuth: true,
        description: "Load Session Pauses",
        transform: (data) => parsePauseStateResponse(data)
      });
      if (!response) {
        applyPauseStateFromUpdate({ current: null, history: [] });
        return;
      }
      const pauseState = buildPauseState(response, /* @__PURE__ */ new Date());
      applyPauseStateFromUpdate(pauseState);
    } catch (error) {
      console.warn("Failed to load session pauses", error);
    }
  };
  var fetchRequests = async () => {
    if (!state.token) {
      return;
    }
    const result = await sendOrQueue({
      path: "/api/time-requests/my",
      method: "GET",
      requiresAuth: true,
      description: "Fetch Time Requests"
    });
    if (result.ok) {
      const response = result.data;
      const requests = Array.isArray(response) ? response : response?.requests ?? [];
      state.requests = requests;
      renderRequests();
    } else if (!result.queued) {
      console.warn("Unable to fetch requests", result.error);
      const parsed = parseApiError(result.error);
      showToast(`Unable to fetch requests: ${parsed.message}`, "error", parsed.code, parsed.hint);
    }
  };
  var fetchCurrentUser = async () => {
    if (!state.token) {
      return;
    }
    const result = await sendOrQueue({
      path: "/api/me",
      method: "GET",
      requiresAuth: true,
      description: "Fetch Current User"
    });
    if (result.ok) {
      const payload = result.data;
      if (payload && typeof payload === "object" && "user" in payload) {
        state.user = payload.user ?? null;
        updateStatus();
      }
    } else if (!result.queued) {
      console.warn("Unable to fetch current user", result.error);
      const parsed = parseApiError(result.error);
      showToast(`Unable to fetch user: ${parsed.message}`, "error", parsed.code, parsed.hint);
    }
  };
  var submitRequest = async () => {
    if (!requestForm || !state.bootstrap) {
      return;
    }
    if (!state.token) {
      const authenticated = await ensureAuthenticated();
      if (!authenticated) {
        if (requestErrorEl) {
          requestErrorEl.textContent = "Log in to submit a request.";
        }
        return;
      }
    }
    if (!state.email) {
      if (requestErrorEl) {
        requestErrorEl.textContent = "Log in to submit a request.";
      }
      return;
    }
    const type = requestTypeInput?.value ?? "";
    const startDate = requestStartDateInput?.value ?? "";
    const endDateRaw = requestEndDateInput?.value ?? "";
    const hoursValue = requestHoursInput?.value ?? "";
    const reason = requestReasonInput?.value?.trim() ?? "";
    if (!type || !startDate || !hoursValue || !reason) {
      if (requestErrorEl) {
        requestErrorEl.textContent = "All required fields must be completed.";
      }
      return;
    }
    const hours = Number.parseFloat(hoursValue);
    if (Number.isNaN(hours) || hours <= 0) {
      if (requestErrorEl) {
        requestErrorEl.textContent = "Hours must be a positive number.";
      }
      return;
    }
    const endDate = endDateRaw ? endDateRaw : null;
    if (endDate && endDate < startDate) {
      if (requestErrorEl) {
        requestErrorEl.textContent = "End date cannot be before start date.";
      }
      return;
    }
    const payload = {
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
      requestErrorEl.textContent = "";
    }
    if (requestSuccessEl) {
      requestSuccessEl.textContent = "Submitting...";
    }
    const result = await sendOrQueue({
      path: "/api/time-requests",
      body: payload,
      requiresAuth: true,
      description: "Submit Time Request"
    });
    if (result.ok) {
      if (requestSuccessEl) {
        requestSuccessEl.textContent = "Request submitted.";
      }
      toggleRequestModal(false);
      await fetchRequests();
    } else if (result.queued) {
      if (requestSuccessEl) {
        requestSuccessEl.textContent = "Offline: request queued and will submit automatically.";
      }
      return;
    } else {
      if (requestErrorEl) {
        requestErrorEl.textContent = "Unable to submit request.";
      }
    }
  };
  var showPresencePrompt = (prompt) => {
    state.currentPrompt = prompt;
    activePromptId = prompt.id;
    if (presenceMessageEl) {
      presenceMessageEl.textContent = prompt.message ?? "Please confirm your presence.";
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
  var acknowledgePresencePrompt = async (source) => {
    if (!state.currentPrompt || !state.sessionId || presenceAckInFlight) {
      return;
    }
    const prompt = state.currentPrompt;
    presenceAckInFlight = true;
    if (presenceTimeout) {
      clearTimeout(presenceTimeout);
      presenceTimeout = null;
    }
    if (source === "popup") {
      togglePresenceModal(false);
    } else if (presenceConfirmBtn) {
      presenceConfirmBtn.disabled = true;
    }
    window.attendance.closePresencePrompt(prompt.id);
    const request = {
      path: "/api/events/presence/confirm",
      body: {
        sessionId: state.sessionId,
        promptId: prompt.id,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      },
      description: "Presence Confirmation"
    };
    const result = await sendOrQueue(request);
    presenceAckInFlight = false;
    if (!result.ok && !result.queued) {
      console.error("Presence confirmation failed", result.error);
      const parsed = parseApiError(result.error);
      showToast(`Presence confirmation failed: ${parsed.message}`, "error", parsed.code, parsed.hint);
      if (source === "overlay" && presenceConfirmBtn) {
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
  var confirmPresence = async () => {
    await acknowledgePresencePrompt("overlay");
  };
  var requireSessionAndSend = async (path, description) => {
    if (!state.token) {
      const authenticated = await ensureAuthenticated();
      if (!authenticated) {
        return;
      }
    }
    if (!state.sessionId) {
      await startSession();
      if (!state.sessionId) {
        console.warn("No active session for action");
        return;
      }
    }
    const request = {
      path,
      body: { sessionId: state.sessionId, timestamp: (/* @__PURE__ */ new Date()).toISOString() },
      requiresAuth: path.startsWith("/api/time-requests") ? true : false,
      description
    };
    console.info("[ui]", {
      event: "api_attempt",
      description,
      path,
      payload: request.body,
      sessionId: state.sessionId
    });
    const result = await sendOrQueue(request);
    if (result.ok) {
      const payload = typeof result.data === "object" && result.data !== null ? result.data : void 0;
      const pausePayload = payload ? parsePausePayload(payload.pause) : void 0;
      if (pausePayload) {
        const updatedPauseState = applyPauseUpdate(
          { current: state.currentPause, history: state.pauseHistory },
          pausePayload,
          /* @__PURE__ */ new Date()
        );
        applyPauseStateFromUpdate(updatedPauseState);
        return;
      }
      if (path === "/api/events/break/start") {
        state.sessionState = "break";
        updateStatus();
        return;
      }
      if (path === "/api/events/break/end") {
        state.currentPause = null;
        stopPauseTimer();
        state.sessionState = "active";
        updateStatus();
        return;
      }
      if (path === "/api/events/lunch/start") {
        state.sessionState = "lunch";
        updateStatus();
        return;
      }
      if (path === "/api/events/lunch/end") {
        state.currentPause = null;
        stopPauseTimer();
        state.sessionState = "active";
        updateStatus();
        return;
      }
      return;
    }
    if (!result.queued) {
      console.error(`${description} failed`, result.error);
      const parsed = parseApiError(result.error);
      showToast(`${description} failed: ${parsed.message}`, "error", parsed.code, parsed.hint);
      return;
    }
    showToast(`${description} queued`, "info");
  };
  var initPresenceHandlers = () => {
    if (presenceConfirmBtn) {
      presenceConfirmBtn.addEventListener("click", () => {
        void confirmPresence();
      });
    }
    if (presenceDismissBtn) {
      presenceDismissBtn.addEventListener("click", () => {
        togglePresenceModal(false);
      });
    }
    window.attendance.onPresenceWindowConfirm((promptId) => {
      if (!activePromptId || promptId !== activePromptId) {
        return;
      }
      void acknowledgePresencePrompt("popup");
    });
    window.attendance.onPresenceWindowDismiss((promptId) => {
      if (activePromptId && promptId === activePromptId) {
        togglePresenceModal(false);
      }
    });
  };
  var initSettingsHandlers = () => {
    const populate = () => {
      if (!state.settings) {
        return;
      }
      if (settingsBaseUrlInput) {
        settingsBaseUrlInput.value = state.settings.serverBaseUrl;
      }
      if (settingsEmailInput) {
        settingsEmailInput.value = state.settings.workEmail ?? "";
      }
      if (state.lastHealthSuccess) {
        state.healthStatus = {
          state: "success",
          baseUrl: state.lastHealthSuccess.baseUrl,
          version: state.lastHealthSuccess.version,
          time: state.lastHealthSuccess.time
        };
      } else {
        state.healthStatus = { state: "idle" };
      }
      renderHealthStatus();
    };
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener("click", () => {
        populate();
        toggleSettingsModal(true);
      });
    }
    if (settingsCancelBtn) {
      settingsCancelBtn.addEventListener("click", () => {
        toggleSettingsModal(false);
      });
    }
    if (settingsTestBtn && settingsBaseUrlInput) {
      settingsTestBtn.addEventListener("click", async () => {
        const baseUrlValue = settingsBaseUrlInput.value.trim();
        if (!baseUrlValue) {
          if (settingsErrorEl) {
            settingsErrorEl.textContent = "Enter a URL to test.";
          }
          return;
        }
        if (settingsErrorEl) {
          settingsErrorEl.textContent = "";
          settingsErrorEl.innerHTML = "";
        }
        state.healthStatus = { state: "testing", baseUrl: baseUrlValue };
        renderHealthStatus();
        settingsTestBtn.disabled = true;
        const buildHealthUrl = () => {
          try {
            return new URL("/api/health", baseUrlValue).toString();
          } catch (_error) {
            return null;
          }
        };
        const healthUrl = buildHealthUrl();
        if (!healthUrl) {
          state.healthStatus = { state: "error", baseUrl: baseUrlValue, detail: "Invalid server URL." };
          renderHealthStatus();
          settingsTestBtn.disabled = false;
          return;
        }
        try {
          const response = await window.fetch(healthUrl, { method: "GET" });
          if (!response.ok) {
            const detail = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
            state.healthStatus = { state: "error", baseUrl: baseUrlValue, detail };
            renderHealthStatus();
            return;
          }
          const data = await response.json();
          if (!data?.ok || typeof data.version !== "string" || typeof data.time !== "string") {
            state.healthStatus = {
              state: "error",
              baseUrl: baseUrlValue,
              detail: "Invalid health response."
            };
            renderHealthStatus();
            return;
          }
          const parsedTime = new Date(data.time);
          if (Number.isNaN(parsedTime.getTime())) {
            state.healthStatus = {
              state: "error",
              baseUrl: baseUrlValue,
              detail: "Invalid timestamp in response."
            };
            renderHealthStatus();
            return;
          }
          state.healthStatus = {
            state: "success",
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
          const detail = error instanceof Error ? `Network error: ${error.message}` : "Network error.";
          state.healthStatus = { state: "error", baseUrl: baseUrlValue, detail };
          renderHealthStatus();
        } finally {
          settingsTestBtn.disabled = false;
        }
      });
    }
    if (settingsForm) {
      settingsForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const baseUrlValue = settingsBaseUrlInput?.value.trim() ?? "";
        const workEmailValue = settingsEmailInput?.value.trim().toLowerCase() ?? "";
        if (!baseUrlValue) {
          if (settingsErrorEl) {
            settingsErrorEl.textContent = "Server URL is required.";
          }
          return;
        }
        if (!workEmailValue) {
          if (settingsErrorEl) {
            settingsErrorEl.textContent = "Work email is required.";
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
          state.healthStatus = { state: "idle" };
          renderHealthStatus();
          if (settingsSuccessEl) {
            settingsSuccessEl.textContent = "Settings updated.";
          }
          if (settingsErrorEl) {
            settingsErrorEl.textContent = "";
          }
          toggleSettingsModal(false);
        } catch (error) {
          if (settingsErrorEl) {
            settingsErrorEl.textContent = "Failed to update server URL.";
          }
          console.error("Settings update failed", error);
        }
      });
    }
  };
  var initRequestHandlers = () => {
    if (openRequestsBtn) {
      openRequestsBtn.addEventListener("click", async () => {
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
      requestCancelBtn.addEventListener("click", () => {
        toggleRequestModal(false);
      });
    }
    if (requestForm) {
      requestForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await submitRequest();
      });
    }
    if (refreshRequestsBtn) {
      refreshRequestsBtn.addEventListener("click", () => {
        void fetchRequests();
      });
    }
  };
  var initTimesheetHandlers = () => {
    ensureTimesheetFormDefaults();
    if (openTimesheetBtn) {
      openTimesheetBtn.addEventListener("click", async () => {
        const authenticated = state.token ? true : await ensureAuthenticated();
        if (!authenticated) {
          return;
        }
        toggleTimesheetModal(true);
      });
    }
    if (timesheetCloseBtn) {
      timesheetCloseBtn.addEventListener("click", () => {
        toggleTimesheetModal(false);
      });
    }
    if (timesheetViewSelect) {
      timesheetViewSelect.addEventListener("change", () => {
        const view = timesheetViewSelect.value;
        updateTimesheetInputVisibility(view);
        state.timesheetView = view;
        state.timesheetReference = view === "monthly" ? timesheetMonthInput?.value?.trim() ?? null : timesheetDateInput?.value?.trim() ?? null;
      });
    }
    if (timesheetFilterForm) {
      timesheetFilterForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const { view, date, month } = getTimesheetRequestValues();
        await fetchTimesheet({ view, date: date ?? void 0, month: month ?? void 0 });
      });
    }
    if (timesheetRefreshBtn) {
      timesheetRefreshBtn.addEventListener("click", async () => {
        const { view, date, month } = getTimesheetRequestValues();
        await fetchTimesheet({ view, date: date ?? void 0, month: month ?? void 0 });
      });
    }
    if (timesheetRequestsRefreshBtn) {
      timesheetRequestsRefreshBtn.addEventListener("click", async () => {
        const { view, date, month } = getTimesheetRequestValues();
        await fetchTimesheet({ view, date: date ?? void 0, month: month ?? void 0, silent: true });
      });
    }
    if (timesheetTableBody) {
      timesheetTableBody.addEventListener("click", (event) => {
        const target = event.target;
        if (!target || !target.matches('[data-action="timesheet-request-edit"]')) {
          return;
        }
        const date = target.getAttribute("data-date");
        const label = target.getAttribute("data-label") ?? (date ? formatLocalDate(date) : "Selected day");
        if (date) {
          openTimesheetEditRequest(date, label);
        }
      });
    }
    if (timesheetEditCancelBtn) {
      timesheetEditCancelBtn.addEventListener("click", () => {
        toggleTimesheetEditModal(false);
      });
    }
    if (timesheetEditForm) {
      timesheetEditForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!pendingTimesheetEdit || !state.timesheet) {
          return;
        }
        const reason = timesheetEditReasonInput?.value.trim() ?? "";
        if (!reason) {
          if (timesheetEditErrorEl) {
            timesheetEditErrorEl.textContent = "Reason is required.";
          }
          if (timesheetEditSuccessEl) {
            timesheetEditSuccessEl.textContent = "";
          }
          return;
        }
        const hoursValueRaw = timesheetEditHoursInput?.value.trim() ?? "";
        let requestedMinutes;
        if (hoursValueRaw) {
          const parsed = Number.parseFloat(hoursValueRaw);
          if (Number.isNaN(parsed) || parsed < 0) {
            if (timesheetEditErrorEl) {
              timesheetEditErrorEl.textContent = "Hours must be zero or greater.";
            }
            if (timesheetEditSuccessEl) {
              timesheetEditSuccessEl.textContent = "";
            }
            return;
          }
          if (parsed > 0) {
            requestedMinutes = Math.round(parsed * 60);
          }
        }
        if (timesheetEditErrorEl) {
          timesheetEditErrorEl.textContent = "";
        }
        if (timesheetEditSuccessEl) {
          timesheetEditSuccessEl.textContent = "Submitting...";
        }
        const payload = {
          view: state.timesheet.view,
          rangeStart: state.timesheet.rangeStart,
          targetDate: pendingTimesheetEdit.date,
          reason
        };
        if (requestedMinutes && requestedMinutes > 0) {
          payload.requestedMinutes = requestedMinutes;
        }
        const result = await sendOrQueue({
          path: "/api/timesheets/edit-requests",
          body: payload,
          requiresAuth: true,
          description: "Submit Timesheet Edit"
        });
        if (result.ok) {
          if (timesheetEditSuccessEl) {
            timesheetEditSuccessEl.textContent = "Edit request submitted.";
          }
          showToast("Edit request submitted", "success");
          toggleTimesheetEditModal(false);
          await fetchTimesheet({
            view: state.timesheet.view,
            date: state.timesheet.view === "monthly" ? void 0 : state.timesheetReference ?? void 0,
            month: state.timesheet.view === "monthly" ? state.timesheetReference ?? void 0 : void 0,
            silent: true
          });
        } else if (result.queued) {
          if (timesheetEditSuccessEl) {
            timesheetEditSuccessEl.textContent = "Offline: request queued and will submit automatically.";
          }
          toggleTimesheetEditModal(false);
        } else {
          const parsed = parseApiError(result.error);
          if (timesheetEditErrorEl) {
            timesheetEditErrorEl.textContent = parsed.message;
          }
          if (timesheetEditSuccessEl) {
            timesheetEditSuccessEl.textContent = "";
          }
        }
      });
    }
  };
  var initActionButtons = () => {
    buttons.forEach((button) => {
      const actionKey = button.dataset.action;
      if (!actionKey) {
        return;
      }
      button.addEventListener("click", async () => {
        console.info("[ui]", {
          event: "button_click",
          action: actionKey,
          sessionId: state.sessionId,
          tokenPresent: Boolean(state.token)
        });
        window.attendance.logAction(actionKey);
        switch (actionKey) {
          case "log-in":
            if (await ensureAuthenticated()) {
              if (!state.sessionId) {
                await startSession();
              }
            }
            break;
          case "start-break":
            await requireSessionAndSend("/api/events/break/start", "Start Break");
            break;
          case "end-break":
            await requireSessionAndSend("/api/events/break/end", "End Break");
            break;
          case "start-lunch":
            await requireSessionAndSend("/api/events/lunch/start", "Start Lunch");
            break;
          case "end-lunch":
            await requireSessionAndSend("/api/events/lunch/end", "End Lunch");
            break;
          case "log-out":
            await endSession();
            break;
          default:
            console.warn(`Unknown action: ${actionKey}`);
        }
      });
    });
  };
  var bootstrap = async () => {
    const bootstrapData = await window.attendance.getBootstrap();
    state.bootstrap = bootstrapData;
    const uiMode = bootstrapData.presenceUiMode;
    if (uiMode === "overlay" || uiMode === "popup" || uiMode === "both") {
      presenceUiMode = uiMode;
    } else {
      presenceUiMode = "both";
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
    window.addEventListener("online", () => {
      void offlineQueue.process();
      void fetchRequests();
    });
  };
  var init = async () => {
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
  var __test = {
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
    setPresenceUiMode: (mode) => {
      presenceUiMode = mode;
    }
  };
  void init();
})();
//# sourceMappingURL=index.js.map

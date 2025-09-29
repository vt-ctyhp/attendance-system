"use strict";
(() => {
  // src/renderer/index.ts
  var MINUTE = 6e4;
  var addDays = (date, amount) => {
    const copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + amount);
    return copy;
  };
  var addMinutes = (date, minutes) => new Date(date.getTime() + minutes * MINUTE);
  var startOfWeek = (date) => {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = copy.getDay();
    const mondayIndex = (day + 6) % 7;
    copy.setDate(copy.getDate() - mondayIndex);
    return copy;
  };
  var isoDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  var parseIsoDate = (value) => /* @__PURE__ */ new Date(`${value}T00:00:00`);
  var formatDayLabel = (date) => new Intl.DateTimeFormat(void 0, { weekday: "short", month: "short", day: "numeric" }).format(date);
  var formatDateLong = (date) => new Intl.DateTimeFormat(void 0, { month: "long", day: "numeric", year: "numeric" }).format(date);
  var formatMonthLabel = (date) => new Intl.DateTimeFormat(void 0, { month: "long", year: "numeric" }).format(date);
  var formatRelative = (date) => {
    if (!date) {
      return "\u2014";
    }
    const diffMs = Date.now() - date.getTime();
    const diffMinutes = Math.round(diffMs / MINUTE);
    if (diffMinutes < 1) {
      return "just now";
    }
    if (diffMinutes < 60) {
      return `${diffMinutes} min ago`;
    }
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours} hr${diffHours === 1 ? "" : "s"} ago`;
    }
    return formatDateLong(date);
  };
  var formatCountdown = (target) => {
    if (!target) {
      return "\u2014";
    }
    const diffMs = target.getTime() - Date.now();
    if (diffMs <= 0) {
      return "due now";
    }
    const minutes = Math.floor(diffMs / MINUTE);
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      if (remainder === 0) {
        return `${hours} hr${hours === 1 ? "" : "s"}`;
      }
      return `${hours} hr ${remainder} min`;
    }
    return `${minutes} min`;
  };
  var formatDurationMinutes = (minutes) => {
    if (minutes <= 0) {
      return "0m";
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
  var formatHours = (hours) => {
    const rounded = Math.round(hours * 100) / 100;
    return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
  };
  var minutesBetween = (start, end = /* @__PURE__ */ new Date()) => {
    if (!start) {
      return 0;
    }
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / MINUTE));
  };
  var escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  var createDay = (date, data) => ({
    date: isoDate(date),
    label: formatDayLabel(date),
    activeHours: data.active,
    idleHours: data.idle,
    breaks: data.breaks,
    lunches: data.lunches,
    presenceMisses: data.presence,
    note: data.note
  });
  var recomputeTotals = (days) => days.reduce(
    (totals, day) => {
      totals.activeHours += day.activeHours;
      totals.idleHours += day.idleHours;
      totals.breaks += day.breaks;
      totals.lunches += day.lunches;
      totals.presenceMisses += day.presenceMisses;
      return totals;
    },
    { activeHours: 0, idleHours: 0, breaks: 0, lunches: 0, presenceMisses: 0 }
  );
  var greeting = (date) => {
    const hour = date.getHours();
    if (hour < 12) {
      return "Good morning";
    }
    if (hour < 17) {
      return "Good afternoon";
    }
    return "Good evening";
  };
  var requestLabel = (type) => {
    switch (type) {
      case "make_up":
        return "Make-up hours";
      case "time_off":
        return "Time off";
      case "edit":
        return "Timesheet edit";
      default:
        return type.replace("_", " ");
    }
  };
  var requestStatusClass = (status) => {
    if (status === "pending") {
      return "pill pill--pending";
    }
    if (status === "approved") {
      return "pill pill--approved";
    }
    return "pill pill--denied";
  };
  var categoryIcon = (category) => {
    switch (category) {
      case "session":
        return "\u{1F551}";
      case "presence":
        return "\u{1F44B}";
      case "break":
        return "\u2615";
      case "lunch":
        return "\u{1F371}";
      case "request":
        return "\u{1F4DD}";
      default:
        return "\u2022";
    }
  };
  var logAction = (action) => {
    try {
      window.attendance?.logAction(action);
    } catch (error) {
      console.warn("logAction failed", error);
    }
  };
  var showToast = (message, variant = "success") => {
    const toast = document.getElementById("toast");
    if (!toast) {
      return;
    }
    toast.textContent = message;
    if (variant === "info") {
      toast.removeAttribute("data-variant");
    } else {
      toast.dataset.variant = variant;
    }
    toast.setAttribute("data-visible", "true");
    window.setTimeout(() => toast.removeAttribute("data-visible"), 2500);
  };
  var now = /* @__PURE__ */ new Date();
  var weekStart = startOfWeek(now);
  var weeklyTemplate = [
    { active: 7.8, idle: 0.4, breaks: 2, lunches: 1, presence: 0, note: "Floor reset complete." },
    { active: 7.6, idle: 0.5, breaks: 2, lunches: 1, presence: 0 },
    { active: 7.9, idle: 0.6, breaks: 3, lunches: 1, presence: 1, note: "Missed presence check at 2:10\u202Fpm." },
    { active: 8.2, idle: 0.3, breaks: 2, lunches: 1, presence: 0 },
    { active: 7.4, idle: 0.5, breaks: 2, lunches: 1, presence: 0 },
    { active: 5, idle: 0.7, breaks: 2, lunches: 1, presence: 0, note: "Partial shift for inventory count." },
    { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0, note: "Scheduled day off." }
  ];
  var weeklyDays = weeklyTemplate.map((data, index) => createDay(addDays(weekStart, index), data));
  var previousWeekTemplate = [
    { active: 7.5, idle: 0.6, breaks: 2, lunches: 1, presence: 0 },
    { active: 7.9, idle: 0.4, breaks: 2, lunches: 1, presence: 0 },
    { active: 8.1, idle: 0.5, breaks: 3, lunches: 1, presence: 0 },
    { active: 7.7, idle: 0.6, breaks: 2, lunches: 1, presence: 0 },
    { active: 7.3, idle: 0.6, breaks: 2, lunches: 1, presence: 0 },
    { active: 4.5, idle: 0.5, breaks: 1, lunches: 1, presence: 0 },
    { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0 }
  ];
  var previousWeekStart = addDays(weekStart, -7);
  var previousWeekDays = previousWeekTemplate.map((data, index) => createDay(addDays(previousWeekStart, index), data));
  var earlyWeekTemplate = [
    { active: 7.2, idle: 0.5, breaks: 2, lunches: 1, presence: 0 },
    { active: 7.8, idle: 0.4, breaks: 2, lunches: 1, presence: 0 },
    { active: 7.6, idle: 0.5, breaks: 2, lunches: 1, presence: 0 },
    { active: 8, idle: 0.4, breaks: 2, lunches: 1, presence: 0 },
    { active: 7.1, idle: 0.6, breaks: 2, lunches: 1, presence: 0 },
    { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0 },
    { active: 0, idle: 0, breaks: 0, lunches: 0, presence: 0 }
  ];
  var earlyWeekStart = addDays(previousWeekStart, -7);
  var earlyWeekDays = earlyWeekTemplate.map((data, index) => createDay(addDays(earlyWeekStart, index), data));
  var payPeriodDays = [...previousWeekDays, ...weeklyDays];
  var monthlyDays = [...earlyWeekDays, ...previousWeekDays, ...weeklyDays];
  var weeklyPeriod = {
    label: `${formatDayLabel(parseIsoDate(weeklyDays[0].date))} \u2013 ${formatDayLabel(
      parseIsoDate(weeklyDays[weeklyDays.length - 1].date)
    )}`,
    range: `${formatDateLong(parseIsoDate(weeklyDays[0].date))} \u2013 ${formatDateLong(
      parseIsoDate(weeklyDays[weeklyDays.length - 1].date)
    )}`,
    days: weeklyDays,
    totals: recomputeTotals(weeklyDays)
  };
  var payPeriod = {
    label: `Pay Period ${formatDateLong(parseIsoDate(payPeriodDays[0].date))} \u2013 ${formatDateLong(
      parseIsoDate(payPeriodDays[payPeriodDays.length - 1].date)
    )}`,
    range: `${formatDayLabel(parseIsoDate(payPeriodDays[0].date))} \u2013 ${formatDayLabel(
      parseIsoDate(payPeriodDays[payPeriodDays.length - 1].date)
    )}`,
    days: payPeriodDays,
    totals: recomputeTotals(payPeriodDays)
  };
  var monthStart = parseIsoDate(monthlyDays[0].date);
  var monthEnd = parseIsoDate(monthlyDays[monthlyDays.length - 1].date);
  var monthlyPeriod = {
    label: `${formatMonthLabel(monthStart)} \u2022 ${formatDayLabel(monthStart)} \u2013 ${formatDayLabel(monthEnd)}`,
    range: `${formatDateLong(monthStart)} \u2013 ${formatDateLong(monthEnd)}`,
    days: monthlyDays,
    totals: recomputeTotals(monthlyDays)
  };
  var todayIso = isoDate(now);
  var todayEntry = weeklyDays.find((day) => day.date === todayIso) ?? weeklyDays[0];
  var todaySnapshot = {
    date: todayEntry.date,
    label: todayEntry.label,
    activeMinutes: Math.round(todayEntry.activeHours * 60),
    idleMinutes: Math.round(todayEntry.idleHours * 60),
    breakMinutes: todayEntry.breaks * 10,
    lunchMinutes: todayEntry.lunches > 0 ? todayEntry.lunches * 45 : 0,
    breaksCount: todayEntry.breaks,
    lunchCount: todayEntry.lunches,
    presenceMisses: todayEntry.presenceMisses
  };
  var state = {
    user: {
      name: "Chloe Sanchez",
      role: "Retail Associate",
      location: "San Francisco Retail Floor"
    },
    session: {
      status: "clocked_out",
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
      view: "weekly",
      periods: {
        weekly: weeklyPeriod,
        pay_period: payPeriod,
        monthly: monthlyPeriod
      }
    },
    requests: [
      {
        id: "req-pto-001",
        type: "time_off",
        status: "approved",
        startDate: addDays(now, -3).toISOString(),
        endDate: addDays(now, -2).toISOString(),
        hours: 16,
        reason: "Family visit in Sacramento.",
        submittedAt: addDays(now, -12).toISOString()
      },
      {
        id: "req-make-up-002",
        type: "make_up",
        status: "pending",
        startDate: addDays(now, 2).toISOString(),
        endDate: addDays(now, 2).toISOString(),
        hours: 3,
        reason: "Cover for inventory audit.",
        submittedAt: addDays(now, -1).toISOString()
      },
      {
        id: "req-edit-003",
        type: "edit",
        status: "denied",
        startDate: addDays(now, -7).toISOString(),
        endDate: addDays(now, -7).toISOString(),
        hours: 0,
        reason: "Adjustment already applied by manager.",
        submittedAt: addDays(now, -5).toISOString()
      }
    ],
    schedule: {
      defaults: [
        { label: "Mon \u2013 Fri", start: "09:00", end: "17:30" },
        { label: "Sat", start: "10:00", end: "18:00" }
      ],
      upcoming: [
        {
          id: "shift-today",
          date: todayIso,
          label: "Today",
          start: "09:00",
          end: "17:30",
          location: "Retail Floor",
          status: "in_progress",
          note: "Coverage with Marcus during lunch rush."
        },
        {
          id: "shift-tomorrow",
          date: isoDate(addDays(now, 1)),
          label: "Tomorrow",
          start: "11:00",
          end: "19:30",
          location: "Outlet \u2013 Union Square",
          status: "upcoming",
          note: "Swap approved for evening coverage."
        },
        {
          id: "shift-weekend",
          date: isoDate(addDays(now, 3)),
          label: formatDayLabel(addDays(now, 3)),
          start: "10:00",
          end: "16:00",
          location: "Pop-up Kiosk",
          status: "upcoming"
        },
        {
          id: "shift-prev",
          date: isoDate(addDays(now, -1)),
          label: "Yesterday",
          start: "09:30",
          end: "17:00",
          location: "Retail Floor",
          status: "completed"
        }
      ]
    },
    activity: [
      {
        id: "activity-1",
        timestamp: addMinutes(now, -12).toISOString(),
        message: "Presence check confirmed from desktop app.",
        category: "presence"
      },
      {
        id: "activity-2",
        timestamp: addMinutes(now, -38).toISOString(),
        message: "Lunch ended \u2013 42 minutes.",
        category: "lunch"
      },
      {
        id: "activity-3",
        timestamp: addMinutes(now, -96).toISOString(),
        message: "Break recorded \u2013 10 minutes.",
        category: "break"
      },
      {
        id: "activity-4",
        timestamp: addMinutes(now, -130).toISOString(),
        message: "Clocked in from store kiosk.",
        category: "session"
      },
      {
        id: "activity-5",
        timestamp: addMinutes(now, -280).toISOString(),
        message: "Approved time-off request for Oct 3 \u2013 Oct 4.",
        category: "request"
      }
    ],
    makeUpCap: {
      used: 6,
      cap: 20
    }
  };
  var dom = {
    heroTitle: document.getElementById("hero-title"),
    heroStatus: document.getElementById("hero-status"),
    heroDuration: document.getElementById("hero-duration"),
    heroPresence: document.getElementById("hero-presence"),
    clockToggle: document.getElementById("clock-toggle"),
    breakToggle: document.getElementById("break-toggle"),
    lunchToggle: document.getElementById("lunch-toggle"),
    presenceButton: document.getElementById("presence-button"),
    downloadButton: document.getElementById("download-report"),
    snapshotLabel: document.getElementById("snapshot-label"),
    statsList: document.getElementById("stats-list"),
    timesheetLabel: document.getElementById("timesheet-label"),
    timesheetBody: document.getElementById("timesheet-body"),
    timesheetView: document.getElementById("timesheet-view"),
    requestList: document.getElementById("request-list"),
    requestForm: document.getElementById("request-form"),
    requestType: document.getElementById("request-type"),
    requestHours: document.getElementById("request-hours"),
    requestReason: document.getElementById("request-reason"),
    requestHint: document.getElementById("request-hint"),
    scheduleList: document.getElementById("schedule-list"),
    activityList: document.getElementById("activity-list"),
    makeupProgress: document.getElementById("makeup-progress")
  };
  dom.timesheetView.value = state.timesheet.view;
  var updateTimesheetFromToday = () => {
    const hours = state.today.activeMinutes / 60;
    const idleHours = state.today.idleMinutes / 60;
    Object.values(state.timesheet.periods).forEach((period) => {
      const day = period.days.find((entry) => entry.date === state.today.date);
      if (day) {
        day.activeHours = Math.round(hours * 100) / 100;
        day.idleHours = Math.round(idleHours * 100) / 100;
        day.breaks = state.today.breaksCount;
        day.lunches = state.today.lunchCount;
        day.presenceMisses = state.today.presenceMisses;
        period.totals = recomputeTotals(period.days);
      }
    });
  };
  var renderHero = () => {
    dom.heroTitle.textContent = `${greeting(/* @__PURE__ */ new Date())}, ${state.user.name}`;
    dom.heroStatus.textContent = state.session.status === "working" ? "Working" : state.session.status === "break" ? "On Break" : state.session.status === "lunch" ? "At Lunch" : "Clocked Out";
    const duration = (() => {
      switch (state.session.status) {
        case "working":
          return `Working for ${formatDurationMinutes(minutesBetween(state.session.startedAt))}`;
        case "break":
          return `On break for ${formatDurationMinutes(minutesBetween(state.session.breakStartedAt))}`;
        case "lunch":
          return `On lunch for ${formatDurationMinutes(minutesBetween(state.session.lunchStartedAt))}`;
        default:
          return state.session.lastClockedOutAt ? `Last clock out ${formatRelative(state.session.lastClockedOutAt)}` : "No session yet";
      }
    })();
    dom.heroDuration.textContent = duration;
    dom.heroPresence.textContent = `Presence check in ${formatCountdown(
      state.session.status === "clocked_out" ? null : state.session.nextPresenceCheck
    )}`;
  };
  var renderSnapshot = () => {
    dom.snapshotLabel.textContent = `${state.today.label} \u2022 ${state.user.location}`;
    dom.makeupProgress.textContent = `${state.makeUpCap.used} / ${state.makeUpCap.cap} make-up hours used`;
    dom.makeupProgress.title = `${Math.max(state.makeUpCap.cap - state.makeUpCap.used, 0)} hours remaining this month`;
    const stats = [
      {
        label: "Active hours",
        value: formatHours(state.today.activeMinutes / 60),
        meta: `Idle ${formatHours(state.today.idleMinutes / 60)} h`
      },
      {
        label: "Break time",
        value: formatDurationMinutes(state.today.breakMinutes),
        meta: `${state.today.breaksCount} break${state.today.breaksCount === 1 ? "" : "s"}`
      },
      {
        label: "Lunch",
        value: formatDurationMinutes(state.today.lunchMinutes),
        meta: state.today.lunchCount ? `${state.today.lunchCount} lunch` : "No lunch logged"
      },
      {
        label: "Presence misses",
        value: `${state.today.presenceMisses}`,
        meta: state.session.lastPresenceCheck ? `Last check ${formatRelative(state.session.lastPresenceCheck)}` : "Awaiting check"
      }
    ];
    dom.statsList.innerHTML = stats.map(
      (item) => `
        <div class="stats__item">
          <span class="stats__label">${escapeHtml(item.label)}</span>
          <span class="stats__value">${escapeHtml(item.value)}</span>
          <span class="stats__meta">${escapeHtml(item.meta)}</span>
        </div>
      `
    ).join("\n");
  };
  var renderTimesheet = () => {
    const period = state.timesheet.periods[state.timesheet.view];
    dom.timesheetLabel.textContent = period.label;
    dom.timesheetBody.innerHTML = period.days.map((day) => {
      const presence = day.presenceMisses > 0 ? `${day.presenceMisses} miss` : "On track";
      const presenceClass = day.presenceMisses > 0 ? "pill pill--pending" : "pill";
      const noteRow = day.note ? `<div class="form-hint">${escapeHtml(day.note)}</div>` : "";
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
          <td><span class="${presenceClass}">${escapeHtml(presence)}</span></td>
        </tr>
      `;
    }).join("\n");
  };
  var renderRequests = () => {
    const items = state.requests.slice().sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()).map((request) => {
      const start = new Date(request.startDate);
      const end = request.endDate ? new Date(request.endDate) : start;
      const rangeLabel = start.getTime() === end.getTime() ? formatDateLong(start) : `${formatDateLong(start)} \u2013 ${formatDateLong(end)}`;
      const hoursLabel = request.hours ? `${request.hours}h` : "\u2014";
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
    dom.requestList.innerHTML = items.join("") || '<li class="form-hint">No requests submitted yet.</li>';
    const remaining = Math.max(state.makeUpCap.cap - state.makeUpCap.used, 0);
    dom.requestHint.textContent = `${state.makeUpCap.used} of ${state.makeUpCap.cap} make-up hours used this month \u2022 ${remaining} remaining.`;
  };
  var renderSchedule = () => {
    const defaults = state.schedule.defaults.map(
      (entry) => `
        <li class="schedule__item">
          <div>
            <strong>${escapeHtml(entry.label)}</strong>
            <div class="schedule__meta">Default \u2022 ${escapeHtml(entry.start)} \u2013 ${escapeHtml(entry.end)}</div>
          </div>
          <span class="pill">Default</span>
        </li>
      `
    ).join("\n");
    const shifts = state.schedule.upcoming.slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((entry) => {
      const timeLabel = `${entry.start} \u2013 ${entry.end}`;
      const statusClass = entry.status === "completed" ? "pill pill--approved" : entry.status === "in_progress" ? "pill pill--pending" : "pill";
      const noteRow = entry.note ? `<div class="schedule__meta">${escapeHtml(entry.note)}</div>` : "";
      return `
        <li class="schedule__item">
          <div>
            <strong>${escapeHtml(entry.label)}</strong>
            <div class="schedule__meta">${escapeHtml(timeLabel)} \u2022 ${escapeHtml(entry.location)}</div>
            ${noteRow}
          </div>
          <span class="${statusClass}">${escapeHtml(entry.status.replace("_", " "))}</span>
        </li>
      `;
    }).join("\n");
    dom.scheduleList.innerHTML = defaults + shifts;
  };
  var renderActivity = () => {
    dom.activityList.innerHTML = state.activity.slice().sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 10).map(
      (item) => `
        <li class="timeline__item">
          <span class="timeline__label">${categoryIcon(item.category)} ${escapeHtml(item.message)}</span>
          <span class="timeline__time">${escapeHtml(formatRelative(new Date(item.timestamp)))}</span>
        </li>
      `
    ).join("\n");
  };
  var updateControls = () => {
    dom.clockToggle.textContent = state.session.status === "clocked_out" ? "Clock In" : "Clock Out";
    dom.breakToggle.textContent = state.session.status === "break" ? "End Break" : "Start Break";
    dom.lunchToggle.textContent = state.session.status === "lunch" ? "End Lunch" : "Start Lunch";
    const disabled = state.session.status === "clocked_out";
    dom.breakToggle.disabled = disabled;
    dom.lunchToggle.disabled = disabled;
    dom.presenceButton.disabled = disabled;
  };
  var pushActivity = (message, category) => {
    state.activity.unshift({
      id: `activity-${Date.now()}`,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message,
      category
    });
    state.activity = state.activity.slice(0, 20);
    renderActivity();
  };
  var render = () => {
    renderHero();
    renderSnapshot();
    renderTimesheet();
    renderRequests();
    renderSchedule();
    renderActivity();
    updateControls();
  };
  var completeBreakIfNeeded = () => {
    if (state.session.status === "break" && state.session.breakStartedAt) {
      const minutes = minutesBetween(state.session.breakStartedAt);
      state.today.breakMinutes += minutes;
      state.today.breaksCount += 1;
      state.session.breakStartedAt = null;
      pushActivity(`Break ended (${formatDurationMinutes(minutes)})`, "break");
      logAction("break_end");
    }
  };
  var completeLunchIfNeeded = () => {
    if (state.session.status === "lunch" && state.session.lunchStartedAt) {
      const minutes = minutesBetween(state.session.lunchStartedAt);
      state.today.lunchMinutes += minutes;
      state.today.lunchCount += 1;
      state.session.lunchStartedAt = null;
      pushActivity(`Lunch ended (${formatDurationMinutes(minutes)})`, "lunch");
      logAction("lunch_end");
    }
  };
  var handleClockToggle = () => {
    if (state.session.status === "clocked_out") {
      state.session.status = "working";
      state.session.startedAt = /* @__PURE__ */ new Date();
      state.session.lastClockedInAt = state.session.startedAt;
      state.session.nextPresenceCheck = addMinutes(state.session.startedAt, 45);
      pushActivity("Clocked in", "session");
      showToast("Clocked in. Have a great shift!", "success");
      logAction("clock_in");
    } else {
      completeBreakIfNeeded();
      completeLunchIfNeeded();
      const minutes = minutesBetween(state.session.startedAt);
      if (minutes > 0) {
        state.today.activeMinutes += minutes;
      }
      state.session.status = "clocked_out";
      state.session.lastClockedOutAt = /* @__PURE__ */ new Date();
      state.session.startedAt = null;
      showToast("Clocked out. Rest well!", "info");
      pushActivity("Clocked out", "session");
      logAction("clock_out");
    }
    updateTimesheetFromToday();
    render();
  };
  var handleBreakToggle = () => {
    if (state.session.status === "clocked_out") {
      showToast("Clock in before starting a break.", "warning");
      return;
    }
    if (state.session.status === "break") {
      completeBreakIfNeeded();
      state.session.status = "working";
    } else {
      completeLunchIfNeeded();
      state.session.status = "break";
      state.session.breakStartedAt = /* @__PURE__ */ new Date();
      pushActivity("Break started", "break");
      showToast("Enjoy your break.", "success");
      logAction("break_start");
    }
    updateTimesheetFromToday();
    render();
  };
  var handleLunchToggle = () => {
    if (state.session.status === "clocked_out") {
      showToast("Clock in before starting lunch.", "warning");
      return;
    }
    if (state.session.status === "lunch") {
      completeLunchIfNeeded();
      state.session.status = "working";
    } else {
      completeBreakIfNeeded();
      state.session.status = "lunch";
      state.session.lunchStartedAt = /* @__PURE__ */ new Date();
      pushActivity("Lunch started", "lunch");
      showToast("Lunch started.", "success");
      logAction("lunch_start");
    }
    updateTimesheetFromToday();
    render();
  };
  var handlePresence = () => {
    if (state.session.status === "clocked_out") {
      showToast("Start a session before confirming presence.", "warning");
      return;
    }
    state.session.lastPresenceCheck = /* @__PURE__ */ new Date();
    state.session.nextPresenceCheck = addMinutes(state.session.lastPresenceCheck, 45);
    state.today.presenceMisses = Math.max(0, state.today.presenceMisses - 1);
    pushActivity("Presence confirmed", "presence");
    showToast("Presence confirmed.", "success");
    logAction("presence_confirm");
    updateTimesheetFromToday();
    render();
  };
  var handleRequestSubmit = (event) => {
    event.preventDefault();
    const type = dom.requestType.value;
    const hours = Number(dom.requestHours.value) || 0;
    const reason = dom.requestReason.value.trim();
    if (!reason) {
      showToast("Share a short reason for the request.", "warning");
      return;
    }
    const submittedAt = /* @__PURE__ */ new Date();
    const defaultEnd = type === "time_off" ? addDays(submittedAt, 1) : submittedAt;
    const request = {
      id: `req-${Date.now()}`,
      type,
      status: "pending",
      startDate: submittedAt.toISOString(),
      endDate: defaultEnd.toISOString(),
      hours,
      reason,
      submittedAt: submittedAt.toISOString()
    };
    state.requests.unshift(request);
    if (type === "make_up") {
      state.makeUpCap.used = Math.min(state.makeUpCap.cap, Math.round((state.makeUpCap.used + hours) * 100) / 100);
    }
    dom.requestForm.reset();
    dom.requestHours.value = "1";
    showToast("Request submitted.", "success");
    pushActivity(`Submitted ${requestLabel(type)}`, "request");
    renderRequests();
    renderSnapshot();
    logAction("request_submit");
  };
  var handleTimesheetChange = () => {
    state.timesheet.view = dom.timesheetView.value;
    renderTimesheet();
  };
  var handleDownload = () => {
    const period = state.timesheet.periods[state.timesheet.view];
    const header = ["Date", "Active Hours", "Idle Hours", "Breaks", "Lunches", "Presence Misses", "Note"];
    const rows = period.days.map((day) => [
      day.label,
      formatHours(day.activeHours),
      formatHours(day.idleHours),
      `${day.breaks}`,
      `${day.lunches}`,
      `${day.presenceMisses}`,
      day.note ?? ""
    ]);
    const csv = [header, ...rows].map((line) => line.map((value) => `"${value.replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const slug = period.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    link.download = `timesheet-${slug}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Timesheet exported.", "info");
  };
  var initialize = () => {
    updateTimesheetFromToday();
    render();
    dom.clockToggle.addEventListener("click", handleClockToggle);
    dom.breakToggle.addEventListener("click", handleBreakToggle);
    dom.lunchToggle.addEventListener("click", handleLunchToggle);
    dom.presenceButton.addEventListener("click", handlePresence);
    dom.requestForm.addEventListener("submit", handleRequestSubmit);
    dom.timesheetView.addEventListener("change", handleTimesheetChange);
    dom.downloadButton.addEventListener("click", handleDownload);
    window.setInterval(renderHero, 3e4);
    window.addEventListener("focus", renderHero);
  };
  initialize();
})();
//# sourceMappingURL=index.js.map

# Attendance System – Product Requirements Document (PRD)

*Last updated: Sep 28, 2025 (PT)*
*Owner: Vivianne Tran (PM)*
*Target Platform: Render (Web Service + Managed PostgreSQL)*

---

## 1. Summary

The Attendance System is a web-based tool to track and manage employee work hours across retail and manufacturing teams. Core workflows include **clock in/out, presence checks, break/lunch tracking, make-up hours, time-off requests, timesheet reviews, and an admin dashboard**.

* **Hosting:** Render Web Service (Dockerfile/Nixpacks).
* **Database:** Render Managed PostgreSQL.
* **Access:** Web dashboard (desktop-friendly, mobile-responsive).
* **DNS/TLS:** Custom domain `attendance.vvsjewelco.com` CNAME → Render; HTTPS auto-managed.

---

## 2. Goals & Non-Goals

### Goals

* Accurate recording of hours and breaks.
* Real-time visibility for managers (who’s working, who’s on break, who missed a check).
* Simple timesheet review and correction process.
* Enforce company policies (presence cadence, break/lunch rules, make-up hour caps).
* Safe, simple deployments on Render with staging → production flow.

### Non-Goals

* No payroll export (CSV only).
* No email, SMS, Slack notifications.
* No Calendly or Google Sheets integration.
* No native mobile apps (responsive web only).

---

## 3. Users & Personas

* **Employee:** Clock in/out, respond to presence checks, log breaks/lunch, request timesheet edits or make-up hours, view timesheets.
* **Manager:** Monitor live roster, approve/deny requests, review timesheets, view reports.
* **Admin:** Manage employees, policies, and locations; audit data.
* **Owner/Executive:** Consume summary dashboards and exports.

---

## 4. Scope & Features

### 4.1 Authentication & Roles

* Email/password login (JWT).
* Roles: `employee`, `manager`, `admin`.
* Bootstrap admin set via Render environment variables.

---

### 4.2 Employee Management

* Admin UI to add, edit, and deactivate employees.
* Bulk employee import via CSV.

---

### 4.3 Clock In/Out & Sessions

* Clock-in creates a session record; clock-out finalizes it.
* Track device/IP metadata.
* **Presence checks:** Random or scheduled prompts to confirm presence.

  * Delivered as in-app modal plus optional pop-up window (backup for remote desktops).
  * Missed presence = exception record.
* **Breaks & Lunches:** Start/stop tracking; aggregate durations daily.

---

### 4.4 Make-Up Hours & Time-Off Requests

* Employees request additional hours or time off (with reason).
* System enforces **monthly make-up cap**.
* Managers/admins approve/deny; audit trail recorded.

---

### 4.5 Timesheets & Edit Requests

* Views: Weekly, Pay Period (1–15, 16–end), Monthly.
* Employees can view totals and submit edit requests with reasons.
* Managers/admins can approve/deny edits; approved edits adjust canonical record.
* Immutable audit trail.

---

### 4.6 Scheduling

* Per-employee default weekly schedule.
* One-off overrides.
* Dashboard highlights lateness or absences vs. expected schedule.

---

### 4.7 Dashboard

* **Overview:** Live roster (working, break, lunch, offline).
* **Daily view:** Breaks & Lunches table.
* **Requests:** Approvals inbox (make-up, time-off, edit requests).
* **Reports:** Export CSV by date range, employee, or location.

---

### 4.8 Settings & Policies

* Configure presence cadence, grace periods, allowed channels.
* Define break/lunch rules (paid/unpaid, min/max durations).
* Set monthly make-up cap.
* Manage locations and time zones.

---

## 5. API Requirements (Sketch)

**Base URL:** `/api`
**Auth:** Bearer JWT

* **Auth**: `POST /auth/login`, `GET /me`
* **Users**: CRUD, CSV import
* **Sessions**: clock in/out, start/stop breaks, presence checks
* **Timesheets**: employee/admin views, edit requests lifecycle
* **Requests**: make-up, time-off lifecycle
* **Schedules**: defaults, overrides
* **Reports**: CSV export
* **Settings**: get/patch
* **Health**: `/heartbeat`, `/sessions/heartbeat`

---

## 6. Data Model (Postgres)

* `User(id, name, email, role, active, location_id, created_at, updated_at)`
* `Session(id, user_id, start_at, end_at, device, ip, location_id)`
* `SessionPause(id, session_id, type ENUM('break','lunch'), start_at, end_at)`
* `PresenceCheck(id, session_id, issued_at, due_at, responded_at, status ENUM('pending','passed','missed'))`
* `TimesheetEditRequest(id, user_id, target_date, payload, reason, status, reviewer_id, reviewed_at)`
* `TimeRequest(id, user_id, type ENUM('make_up','time_off'), start_date, end_date, hours, reason, status, reviewer_id, reviewed_at)`
* `MakeUpCapUsage(user_id, month, year, used_hours)`
* `ScheduleDefault(user_id, weekday, start_time, end_time)`
* `ScheduleOverride(user_id, date, start_time, end_time)`
* `Location(id, name, timezone)`
* `Setting(key, value, version, updated_at, updated_by)`

---

## 7. UX & Screens

**Employee:**

* Clock In/Out card with current status.
* Presence check modal/popup.
* Break/Lunch buttons with timer.
* Timesheets (tabs for weekly/pay period/monthly).
* Request forms for edits or make-up/time-off.

**Manager/Admin:**

* Live roster dashboard.
* Daily view + Break/Lunch table.
* Approvals inbox.
* Employee list + import.
* Schedule editor.
* Settings & policies.
* Reports export.

---

## 8. Policy Engine

* Presence check frequency (randomized intervals).
* Grace periods for presence response.
* Break/lunch paid/unpaid settings.
* Monthly make-up cap enforcement.
* Late/absent thresholds based on schedule.

---

## 9. Analytics & KPIs

* Presence compliance %
* Average lateness per employee per week
* Break/lunch overages
* Monthly make-up usage vs cap
* Request approval turnaround time

---

## 10. Security

* JWT HS256 (1-day expiry).
* Bcrypt password hashing.
* RBAC enforced.
* Input validation (Zod/Joi).
* CORS restricted to production and staging domains.
* TLS auto-provisioned by Render.

---

## 11. Architecture (Render)

* **Web Service:** Node.js + Express + TypeScript (Dockerfile).
* **Database:** Render Managed PostgreSQL.
* **Health Checks:** `/api/heartbeat`.
* **DNS:** `attendance.vvsjewelco.com` → CNAME to Render service.
* **Environments:**

  * **Staging:** staging DB, staging domain (optional).
  * **Production:** prod DB, `attendance.vvsjewelco.com`.

---

## 12. Deployment & CI/CD

* GitHub Actions: lint, test, typecheck, integration tests (Postgres).
* On main merge → auto deploy to staging (Render deploy hook).
* On tag → deploy to production.
* Prisma migrations run at deploy.
* Rollback = redeploy prior build in Render.

---

## 13. Testing Strategy

* **Unit:** Policy engine, validators.
* **Integration:** API + Postgres (schema reset between tests).
* **E2E smoke:** Clock in/out, presence check, breaks, make-up caps, approvals.
* **Load:** Timesheet aggregation.
* **Regression:** Fix for Add Employee form refresh bug.

---

## 14. Rollout Plan

1. **Staging**: Deploy Render Web Service + Managed PG; QA features.
2. **Production**: Deploy clean PG, run migrations, seed initial users.
3. **DNS**: Point `attendance.vvsjewelco.com` → Render service.
4. **Cutover**: Verify health checks, smoke test, then onboard employees.

---

## 15. Risks & Mitigations

* **Popup blockers** → Provide both modal and popup for presence checks.
* **Remote desktop instability** → Use grace periods and retries.
* **DNS conflicts** → Use dedicated subdomain (`attendance.vvsjewelco.com`).
* **Policy changes** → Store versioned settings; effective timestamps.

---

## 16. Acceptance Criteria (v1)

* Employees can reliably clock in/out, take breaks/lunches, and respond to presence checks.
* Presence policy enforced; misses logged as exceptions.
* Make-up and time-off requests capped, approved/denied, and audited.
* Timesheets show correct totals; edit requests workflow complete.
* Dashboard live roster updates within 5s.
* CSV export available for reports.
* Admins can manage employees (add/edit/deactivate/import).
* Settings versioned; updates effective within 1 min.
* CI/CD pipeline green; staging and production on Render healthy.

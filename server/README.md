# Attendance Server

## Tests
- Install dependencies with `npm install` (once).
- Ensure Prisma client is generated: `npx prisma generate`.
- Start a Postgres instance locally. A quick option is
  ```bash
  docker run --rm -d \
    --name attendance-postgres \
    -e POSTGRES_USER=attendance \
    -e POSTGRES_PASSWORD=attendance \
    -e POSTGRES_DB=attendance_test \
    -p 5432:5432 \
    postgres:15-alpine
  ```
- Run the suite with `npm test`. The script automatically points `DATABASE_URL` and `TEST_DATABASE_URL` at
  `postgresql://attendance:attendance@127.0.0.1:5432/attendance_test?schema=public` unless you override them.

Vitest runs sequentially, truncates the Postgres schema between tests, and now includes a health check that
performs a write/read round-trip.

## Migrations & Seeds

- Apply the current schema with `npm run ensure:migrations`. This wraps `prisma migrate deploy` and regenerates the client.
- Seed demo shift assignments for dashboards with `npm run seed:shifts`. The script is safe to re-run and skips automatically when `NODE_ENV`/`APP_ENV` is production (unless you pass `--allow-prod`).
- For lightweight post-deploy smoke checks, run `npm run postdeploy:schedule -- schedule-user@example.com https://env-base-url` to verify that seeded accounts still have upcoming shifts.

## Deployment

- Copy `deploy/env.prod.example` to `deploy/env.prod` and keep the `DATABASE_URL` pointing at the Postgres service (`postgresql://attendance:attendance@postgres:5432/attendance?schema=public`).
- The Postgres container reads credentials from `deploy/env.postgres`; adjust as needed for your environment.
- Run `npm run cutover:prod` from the workspace root to provision Postgres, build the server image, apply migrations (falling back to `db:push`), and probe `/api/health` and the dashboard overview.
- After cutover, verify externally with `npm run smoke:prod`; set `ADMIN_TOKEN` and optionally `SMOKE_USER_ID` when you need authenticated probes.
- If you must return to the legacy SQLite stack, execute `npm run rollback:sqlite`; this restores the pre-cutover compose/env files from `deploy/backup-pre-cutover` and rebuilds the old container.

## Sample data

Populate the dashboard with demo activity by running:

```
npm run seed:sample
```

This seeds two employees (`chloe.sanchez@example.com`, `marcus.lee@example.com`) with the password `SamplePass123!`, recent sessions, and a PTO request so dashboard views have realistic information immediately.

## Smoke Test
Run the end-to-end smoke script to exercise critical APIs:

```
./scripts/smoke.sh
```

The script loads environment variables from `.env` when present, builds the project, starts the server on `PORT` (default `4100`), performs a health check, creates a session and heartbeat, submits a PTO request, approves it as the seeded admin, and prints the resulting PTO balances.

## Email-Only Session Sign-In (Opt-In)

Employees can request access tokens with just their email when the `START_SESSION_BY_EMAIL_ENABLED` flag is on. The flow is **disabled by default** and continues to exist alongside the admin email+password login.

### Enabling the feature

- Toggle the flag from the dashboard: `Dashboard → Settings → Email Sign-In`.
- Or set via environment/config:
  - `START_SESSION_BY_EMAIL_ENABLED=true` (default `false`).
  - Optional IP allowlist: `START_SESSION_BY_EMAIL_ALLOWED_IPS=203.0.113.5,203.0.113.6`.
  - Optional internal header gate: set `START_SESSION_BY_EMAIL_CLIENT_HEADER` (header name) and `START_SESSION_BY_EMAIL_CLIENT_SECRET` (expected value).

### Endpoints

`POST /api/sessions/start`

```json
{
  "flow": "email_only",
  "email": "employee@example.com",
  "deviceId": "optional-device"
}
```

Returns short-lived access tokens (~10 minutes) and rotating refresh tokens (~24 hours) scoped to `employee_session`. Tokens are logged in the audit trail and stored for rotation checks.

`POST /api/sessions/refresh`

```json
{ "refreshToken": "<token>" }
```

Refresh requests rotate tokens and invalidate the previous refresh token. Reuse triggers revocation of the token family and is logged for investigation.

### Token behaviour

- Access tokens include scope `employee_session` and cannot satisfy admin/manager role checks.
- Refresh tokens are stored hashed, rotated on every exchange, and replay attempts revoke remaining tokens.
- Admin login (`/api/auth/login`) still issues `scope: full` tokens and is unaffected by this feature.

### Auditing & dashboard tools

- All attempts (success/failure) are written to `AuthAuditLog` with email, reason, IP, user agent, and optional device id.
- A new dashboard Settings page lists employee roster (with active toggles and an add-employee form), the audit feed, and the feature flag state.
- Lightweight in-memory counters feed log noise for rate-limit and abuse signals.

### Network considerations

- Combine the allowlist/header hooks with perimeter controls (VPN, reverse proxy) in production.
- Keep the feature disabled until rollout plans cover employee onboarding, device trust, and incident response.

# Payroll Module Overview

This payroll module introduces server-side services, database schema, and an administrator console for managing compensation, attendance-driven bonuses, and semi-monthly payroll periods. The implementation is built around Prisma models in `server/prisma/schema.prisma` and TypeScript services under `server/src/payroll`.

## Key Capabilities

- **Employee Configuration** – Capture semi-monthly base pay, attendance bonus targets, KPI bonus defaults, PTO/non-PTO balances, accrual settings, and per-weekday schedules with effective dates.
- **Holiday Calendar** – Admins can curate a holiday list via the dashboard and REST APIs (`/api/payroll/holidays`).
- **Attendance Facts** – Monthly attendance computation folds in schedules, session data, PTO/non-PTO requests, tardiness, and capped make-up hours. Results persist in `PayrollAttendanceFact`.
- **Bonus Lifecycle** – Monthly, quarterly, and KPI bonuses flow through `PayrollBonus`, with deferral logic, approvals, audit logging, and pay date allocation helpers.
- **Payroll Periods** – Semi-monthly payroll periods resolve automatically, aggregate approved bonuses, and produce payroll checks with JSON snapshots for exports.
- **Exports** – `/api/payroll/paydates/:date/export` generates CSV exports containing employee, base, bonus, and total amounts for a pay date.
- **Admin Console** – `/dashboard/payroll` offers controls to manage employee configs, holidays, attendance recalculation, KPI approvals, and payroll period status.

## Services

| File | Purpose |
| --- | --- |
| `server/src/payroll/config.ts` | CRUD helpers with audit logging for employee compensation schedules. |
| `server/src/payroll/holidays.ts` | Holiday list management (create/list/delete). |
| `server/src/payroll/attendance.ts` | Monthly attendance recomputation and persistence. |
| `server/src/payroll/bonus.ts` | Bonus allocation, KPI decisions, payable-date queries. |
| `server/src/payroll/payrollPeriods.ts` | Payroll period recalculation, check creation, and status flow helpers. |
| `server/src/payroll/audit.ts` | Lightweight wrapper around the new payroll audit log table. |
| `server/src/routes/payroll.ts` | JSON API surface for admin tooling, exports, and recalculation endpoints. |
| `server/src/routes/dashboard.ts` | Server-rendered dashboard for payroll management (`/dashboard/payroll`). |

## Database Changes

The migration `20250929181312_payroll_module` adds enums and tables that back the payroll module: employee configs, schedules, holidays, attendance facts, bonuses, periods, checks, and audit logs. Run `npx prisma generate` after updating the schema to refresh Prisma client types.

## Testing

Unit and integration tests are not included yet. The command `npm run test` currently fails because no harness is defined under `scripts/run-tests.cjs`. Smoke tests have been performed via `npm run build` to ensure compilation.


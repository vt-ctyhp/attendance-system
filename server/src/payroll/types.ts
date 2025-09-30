export const PAYROLL_TIME_ZONE = process.env.PAYROLL_TIME_ZONE ?? process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';

export const PAYROLL_ACCUMULATOR_WINDOW_DAYS = 14;
export const PAYROLL_MAX_MAKEUP_HOURS_PER_MONTH = 8;

export const PAYROLL_ACCRUAL_METHODS = ['NONE', 'MANUAL', 'MONTHLY_HOURS'] as const;
export type PayrollAccrualMethod = (typeof PAYROLL_ACCRUAL_METHODS)[number];

export const PAYROLL_FACT_STATUSES = ['PENDING', 'FINALIZED'] as const;
export type PayrollFactStatus = (typeof PAYROLL_FACT_STATUSES)[number];

export const PAYROLL_BONUS_TYPES = ['MONTHLY_ATTENDANCE', 'QUARTERLY_ATTENDANCE', 'KPI'] as const;
export type PayrollBonusType = (typeof PAYROLL_BONUS_TYPES)[number];

export const PAYROLL_BONUS_STATUSES = ['PENDING', 'ELIGIBLE', 'APPROVED', 'DENIED', 'PAID'] as const;
export type PayrollBonusStatus = (typeof PAYROLL_BONUS_STATUSES)[number];

export const PAYROLL_PERIOD_STATUSES = ['DRAFT', 'APPROVED', 'PAID'] as const;
export type PayrollPeriodStatus = (typeof PAYROLL_PERIOD_STATUSES)[number];

export const PAYROLL_CHECK_STATUSES = ['DRAFT', 'APPROVED', 'PAID'] as const;
export type PayrollCheckStatus = (typeof PAYROLL_CHECK_STATUSES)[number];

export const PAYROLL_AUDIT_EVENTS = [
  'CONFIG_UPDATED',
  'HOLIDAY_UPDATED',
  'ATTENDANCE_RECALC',
  'BONUS_DECISION',
  'PAYROLL_STATUS_CHANGED'
] as const;
export type PayrollAuditEvent = (typeof PAYROLL_AUDIT_EVENTS)[number];

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface PayrollScheduleEntry {
  weekday: Weekday;
  isEnabled: boolean;
  startMinutes: number | null;
  endMinutes: number | null;
  expectedHours: number | null;
}

export interface PayrollScheduleWithMeta extends PayrollScheduleEntry {
  configEffectiveOn: Date;
}

export interface AttendanceDaySnapshot {
  date: string;
  assignedHours: number;
  workedHours: number;
  ptoHours: number;
  nonPtoHours: number;
  makeUpHours: number;
  tardyMinutes: number;
  isHoliday: boolean;
  schedule?: PayrollScheduleEntry;
  notes: string[];
}

export interface MonthlyAttendanceComputation {
  userId: number;
  month: Date;
  assignedHours: number;
  workedHours: number;
  ptoHours: number;
  nonPtoAbsenceHours: number;
  tardyMinutes: number;
  matchedMakeUpHours: number;
  isPerfect: boolean;
  reasons: string[];
  days: AttendanceDaySnapshot[];
}

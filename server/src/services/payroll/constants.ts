export const PAYROLL_TIME_ZONE = 'America/Los_Angeles';

export const MONTH_KEY_FORMAT = 'yyyy-MM';
export const DATE_KEY_FORMAT = 'yyyy-MM-dd';

export const MAX_MAKEUP_HOURS_PER_MONTH = 8;
export const MAX_TARDY_MINUTES_FOR_BONUS = 90;

export const BONUS_TYPE_MONTHLY = 'monthly_attendance' as const;
export const BONUS_TYPE_QUARTERLY = 'quarterly_attendance' as const;
export const BONUS_TYPE_KPI = 'kpi' as const;

export type BonusTypeConst =
  | typeof BONUS_TYPE_MONTHLY
  | typeof BONUS_TYPE_QUARTERLY
  | typeof BONUS_TYPE_KPI;

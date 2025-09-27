export const USER_ROLES = ['admin', 'manager', 'employee'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const SESSION_STATUSES = ['active', 'ended'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const EVENT_TYPES = [
  'heartbeat',
  'break_start',
  'break_end',
  'lunch_start',
  'lunch_end',
  'presence_check',
  'presence_miss',
  'login',
  'logout'
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const PRESENCE_STATUSES = ['scheduled', 'triggered', 'confirmed', 'missed'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const isPresenceStatus = (value: string): value is PresenceStatus =>
  (PRESENCE_STATUSES as readonly string[]).includes(value);

export const isEventType = (value: string): value is EventType =>
  (EVENT_TYPES as readonly string[]).includes(value);

export const TIME_REQUEST_TYPES = ['pto', 'non_pto', 'make_up'] as const;
export type TimeRequestType = (typeof TIME_REQUEST_TYPES)[number];

export const TIME_REQUEST_STATUSES = ['pending', 'approved', 'denied'] as const;
export type TimeRequestStatus = (typeof TIME_REQUEST_STATUSES)[number];

export const TIMESHEET_VIEWS = ['weekly', 'pay_period', 'monthly'] as const;
export type TimesheetView = (typeof TIMESHEET_VIEWS)[number];

export const TIMESHEET_EDIT_STATUSES = ['pending', 'approved', 'denied'] as const;
export type TimesheetEditStatus = (typeof TIMESHEET_EDIT_STATUSES)[number];

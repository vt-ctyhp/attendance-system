"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIMESHEET_EDIT_STATUSES = exports.TIMESHEET_VIEWS = exports.TIME_REQUEST_STATUSES = exports.TIME_REQUEST_TYPES = exports.isEventType = exports.isPresenceStatus = exports.PRESENCE_STATUSES = exports.EVENT_TYPES = exports.SESSION_STATUSES = exports.USER_ROLES = void 0;
exports.USER_ROLES = ['admin', 'manager', 'employee'];
exports.SESSION_STATUSES = ['active', 'ended'];
exports.EVENT_TYPES = [
    'heartbeat',
    'break_start',
    'break_end',
    'lunch_start',
    'lunch_end',
    'presence_check',
    'presence_miss',
    'login',
    'logout'
];
exports.PRESENCE_STATUSES = ['scheduled', 'triggered', 'confirmed', 'missed'];
const isPresenceStatus = (value) => exports.PRESENCE_STATUSES.includes(value);
exports.isPresenceStatus = isPresenceStatus;
const isEventType = (value) => exports.EVENT_TYPES.includes(value);
exports.isEventType = isEventType;
exports.TIME_REQUEST_TYPES = ['pto', 'non_pto', 'make_up'];
exports.TIME_REQUEST_STATUSES = ['pending', 'approved', 'denied'];
exports.TIMESHEET_VIEWS = ['weekly', 'pay_period', 'monthly'];
exports.TIMESHEET_EDIT_STATUSES = ['pending', 'approved', 'denied'];

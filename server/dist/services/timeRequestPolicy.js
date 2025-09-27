"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.remainingHoursWithinCap = exports.exceedsMonthlyCap = exports.getApprovedMakeupHoursThisMonth = exports.getApprovedMakeupHoursThisMonthByUser = exports.getMakeupCapHoursPerMonth = exports.getCurrentMonthRange = exports.DEFAULT_MAKEUP_CAP_HOURS_PER_MONTH = exports.MAKEUP_CAP_CONFIG_KEY = void 0;
const date_fns_1 = require("date-fns");
const date_fns_tz_1 = require("date-fns-tz");
const config_1 = require("./config");
exports.MAKEUP_CAP_CONFIG_KEY = 'makeup_cap_hours_per_month';
exports.DEFAULT_MAKEUP_CAP_HOURS_PER_MONTH = 8;
const TIME_REQUEST_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE ?? 'America/Los_Angeles';
const HOURS_COMPARISON_EPSILON = 1e-6;
const parseCapValue = (value) => {
    if (value === null) {
        return null;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }
    return parsed;
};
const getCurrentMonthRange = (reference = new Date()) => {
    const zonedReference = (0, date_fns_tz_1.utcToZonedTime)(reference, TIME_REQUEST_TIME_ZONE);
    const start = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.startOfMonth)(zonedReference), TIME_REQUEST_TIME_ZONE);
    const end = (0, date_fns_tz_1.zonedTimeToUtc)((0, date_fns_1.endOfMonth)(zonedReference), TIME_REQUEST_TIME_ZONE);
    return { start, end };
};
exports.getCurrentMonthRange = getCurrentMonthRange;
const getMakeupCapHoursPerMonth = async () => {
    const stored = await (0, config_1.getConfigValue)(exports.MAKEUP_CAP_CONFIG_KEY);
    const parsed = parseCapValue(stored);
    return parsed ?? exports.DEFAULT_MAKEUP_CAP_HOURS_PER_MONTH;
};
exports.getMakeupCapHoursPerMonth = getMakeupCapHoursPerMonth;
const getApprovedMakeupHoursThisMonthByUser = async (client, userIds, reference = new Date()) => {
    if (userIds.length === 0) {
        return new Map();
    }
    const { start, end } = (0, exports.getCurrentMonthRange)(reference);
    const rows = await client.timeRequest.groupBy({
        by: ['userId'],
        where: {
            userId: { in: userIds },
            type: 'make_up',
            status: 'approved',
            approvedAt: {
                gte: start,
                lte: end
            }
        },
        _sum: { hours: true }
    });
    const map = new Map();
    for (const row of rows) {
        map.set(row.userId, row._sum.hours ?? 0);
    }
    return map;
};
exports.getApprovedMakeupHoursThisMonthByUser = getApprovedMakeupHoursThisMonthByUser;
const getApprovedMakeupHoursThisMonth = async (client, userId, reference = new Date()) => {
    const map = await (0, exports.getApprovedMakeupHoursThisMonthByUser)(client, [userId], reference);
    return map.get(userId) ?? 0;
};
exports.getApprovedMakeupHoursThisMonth = getApprovedMakeupHoursThisMonth;
const exceedsMonthlyCap = (approvedThisMonth, requestedHours, cap) => approvedThisMonth + requestedHours - cap > HOURS_COMPARISON_EPSILON;
exports.exceedsMonthlyCap = exceedsMonthlyCap;
const remainingHoursWithinCap = (approvedThisMonth, cap) => Math.max(cap - approvedThisMonth, 0);
exports.remainingHoursWithinCap = remainingHoursWithinCap;

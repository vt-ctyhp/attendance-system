"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectMonthKeysFromEffectiveDate = exports.triggerAttendanceRecalcForMonths = exports.triggerAttendanceRecalcForUserRange = exports.triggerAttendanceRecalcForUser = void 0;
const date_fns_1 = require("date-fns");
const logger_1 = require("../../logger");
const attendance_1 = require("./attendance");
const uniqueMonthKeysForRange = (start, end) => {
    const orderedStart = (0, date_fns_1.min)([start, end]);
    const orderedEnd = (0, date_fns_1.max)([start, end]);
    const days = (0, date_fns_1.eachDayOfInterval)({ start: orderedStart, end: orderedEnd });
    const keys = new Set();
    for (const day of days) {
        keys.add((0, attendance_1.getMonthKeyForDate)(day));
    }
    return Array.from(keys);
};
const logSkip = (monthKey, reason) => {
    logger_1.logger.debug({ monthKey, reason }, 'attendance.recalc.skipped');
};
const runRecalc = async (monthKey, userIds, actorId) => {
    try {
        await (0, attendance_1.recalcMonthlyAttendanceFacts)(monthKey, actorId, userIds);
    }
    catch (error) {
        logger_1.logger.error({ error, monthKey, userIds }, 'attendance.recalc.failed');
        throw error;
    }
};
const triggerAttendanceRecalcForUser = async (userId, referenceDate, options) => {
    const monthKey = (0, attendance_1.getMonthKeyForDate)(referenceDate);
    if (await (0, attendance_1.isAttendanceMonthLocked)(monthKey)) {
        logSkip(monthKey, 'month_locked');
        return;
    }
    const execute = () => runRecalc(monthKey, [userId], options?.actorId);
    if (options?.awaitCompletion) {
        await execute();
    }
    else {
        void execute();
    }
};
exports.triggerAttendanceRecalcForUser = triggerAttendanceRecalcForUser;
const triggerAttendanceRecalcForUserRange = async (userId, start, end, options) => {
    const monthKeys = uniqueMonthKeysForRange(start, end);
    for (const monthKey of monthKeys) {
        if (await (0, attendance_1.isAttendanceMonthLocked)(monthKey)) {
            logSkip(monthKey, 'month_locked');
            continue;
        }
        await runRecalc(monthKey, [userId], options?.actorId);
    }
};
exports.triggerAttendanceRecalcForUserRange = triggerAttendanceRecalcForUserRange;
const triggerAttendanceRecalcForMonths = async (monthKeys, options) => {
    for (const monthKey of monthKeys) {
        if (await (0, attendance_1.isAttendanceMonthLocked)(monthKey)) {
            logSkip(monthKey, 'month_locked');
            continue;
        }
        await runRecalc(monthKey, options?.userIds, options?.actorId);
    }
};
exports.triggerAttendanceRecalcForMonths = triggerAttendanceRecalcForMonths;
const collectMonthKeysFromEffectiveDate = (effectiveOn, reference = new Date()) => {
    const orderedStart = (0, date_fns_1.min)([effectiveOn, reference]);
    const orderedEnd = (0, date_fns_1.max)([effectiveOn, reference]);
    return uniqueMonthKeysForRange(orderedStart, orderedEnd);
};
exports.collectMonthKeysFromEffectiveDate = collectMonthKeysFromEffectiveDate;

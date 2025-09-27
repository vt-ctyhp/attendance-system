"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isClientHeaderValid = exports.isIpAllowed = exports.resetEmailSessionCache = exports.setEmailSessionEnabled = exports.isEmailSessionEnabled = void 0;
const env_1 = require("../env");
const config_1 = require("./config");
const FLAG_KEY = 'start_session_by_email_enabled';
let cachedFlag = null;
const CACHE_TTL_MS = 5000;
const allowedIps = env_1.env.START_SESSION_BY_EMAIL_ALLOWED_IPS
    ? env_1.env.START_SESSION_BY_EMAIL_ALLOWED_IPS.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
const clientHeaderName = env_1.env.START_SESSION_BY_EMAIL_CLIENT_HEADER?.trim();
const clientHeaderSecret = env_1.env.START_SESSION_BY_EMAIL_CLIENT_SECRET?.trim();
const normalizeIp = (ip) => {
    if (!ip)
        return '';
    if (ip.startsWith('::ffff:'))
        return ip.slice(7);
    return ip;
};
const isEmailSessionEnabled = async () => {
    const now = Date.now();
    if (cachedFlag && now - cachedFlag.fetchedAt < CACHE_TTL_MS) {
        return cachedFlag.value;
    }
    const configValue = await (0, config_1.getConfigValue)(FLAG_KEY);
    const value = configValue === null ? env_1.env.START_SESSION_BY_EMAIL_ENABLED : configValue === 'true';
    cachedFlag = { value, fetchedAt: now };
    return value;
};
exports.isEmailSessionEnabled = isEmailSessionEnabled;
const setEmailSessionEnabled = async (enabled) => {
    await (0, config_1.setConfigValue)(FLAG_KEY, enabled ? 'true' : 'false');
    cachedFlag = { value: enabled, fetchedAt: Date.now() };
};
exports.setEmailSessionEnabled = setEmailSessionEnabled;
const resetEmailSessionCache = () => {
    cachedFlag = null;
};
exports.resetEmailSessionCache = resetEmailSessionCache;
const isIpAllowed = (req) => {
    if (!allowedIps.length) {
        return true;
    }
    const ip = normalizeIp(req.ip);
    return allowedIps.includes(ip);
};
exports.isIpAllowed = isIpAllowed;
const isClientHeaderValid = (req) => {
    if (!clientHeaderName || !clientHeaderSecret) {
        return true;
    }
    const headerValue = req.get(clientHeaderName);
    return headerValue === clientHeaderSecret;
};
exports.isClientHeaderValid = isClientHeaderValid;

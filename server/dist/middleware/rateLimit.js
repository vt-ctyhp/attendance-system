"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRateLimiter = void 0;
const errors_1 = require("../errors");
const createRateLimiter = (options) => {
    const store = new Map();
    const keyResolver = options.keyResolver ?? ((req) => req.ip ?? 'unknown');
    return (req, _res, next) => {
        const now = Date.now();
        const key = keyResolver(req);
        const entry = store.get(key);
        if (entry && entry.expiresAt > now) {
            entry.count += 1;
            if (entry.count > options.max) {
                const error = errors_1.HttpError.rateLimited(options.retryAfterSeconds ?? Math.ceil(options.windowMs / 1000), options.message);
                return next(error);
            }
            store.set(key, entry);
            return next();
        }
        store.set(key, { count: 1, expiresAt: now + options.windowMs });
        // Cleanup periodically to avoid unbounded memory usage
        if (store.size > 1000) {
            const threshold = Date.now();
            for (const [k, v] of store.entries()) {
                if (v.expiresAt <= threshold) {
                    store.delete(k);
                }
            }
        }
        return next();
    };
};
exports.createRateLimiter = createRateLimiter;

import type { RequestHandler } from 'express';
import { HttpError } from '../errors';

type KeyResolver = (req: Parameters<RequestHandler>[0]) => string;

interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyResolver?: KeyResolver;
  message?: string;
  retryAfterSeconds?: number;
}

type Entry = {
  expiresAt: number;
  count: number;
};

export const createRateLimiter = (options: RateLimiterOptions): RequestHandler => {
  const store = new Map<string, Entry>();
  const keyResolver = options.keyResolver ?? ((req) => req.ip ?? 'unknown');

  return (req, _res, next) => {
    const now = Date.now();
    const key = keyResolver(req);
    const entry = store.get(key);

    if (entry && entry.expiresAt > now) {
      entry.count += 1;
      if (entry.count > options.max) {
        const error = HttpError.rateLimited(options.retryAfterSeconds ?? Math.ceil(options.windowMs / 1000), options.message);
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


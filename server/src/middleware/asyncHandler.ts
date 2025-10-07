import type { RequestHandler } from 'express';

export const asyncHandler = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };

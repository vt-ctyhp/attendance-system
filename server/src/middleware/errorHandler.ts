import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError, HttpErrorWithRetry, formatZodError } from '../errors';
import { logger } from '../logger';

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  let httpError: HttpError;

  if (err instanceof HttpError) {
    httpError = err;
  } else if (err instanceof ZodError) {
    httpError = HttpError.badRequest('Validation failed', { issues: formatZodError(err) });
  } else {
    httpError = new HttpError(500, 'internal_error', 'Internal server error');
    logger.error({ err, path: req.path }, 'Unhandled error');
  }

  const retryAware = httpError as HttpErrorWithRetry;
  if (retryAware.retryAfter) {
    res.setHeader('Retry-After', retryAware.retryAfter.toString());
  }

  const details = httpError.details;
  let field: string | undefined;
  let hint: string | undefined;
  let remainingDetails: unknown = details;

  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const meta = { ...(details as Record<string, unknown>) };
    if (typeof meta.field === 'string') {
      field = meta.field;
      delete meta.field;
    }
    if (typeof meta.hint === 'string') {
      hint = meta.hint;
      delete meta.hint;
    }
    remainingDetails = Object.keys(meta).length > 0 ? meta : undefined;
  }

  const responseBody: Record<string, unknown> = {
    error: httpError.message,
    code: httpError.code,
    requestId: (req as { debugReqId?: string }).debugReqId ?? null
  };

  if (field) {
    responseBody.field = field;
  }
  if (hint) {
    responseBody.hint = hint;
  }
  if (remainingDetails !== undefined) {
    responseBody.details = remainingDetails;
  }

  res.status(httpError.statusCode).json(responseBody);
};

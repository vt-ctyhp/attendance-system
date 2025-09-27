import { ZodError, type ZodIssue } from 'zod';

export type ErrorDetail = {
  path: string;
  message: string;
  code?: string;
};

const formatIssuePath = (issue: ZodIssue) => (issue.path.length ? issue.path.join('.') : '');

export const formatZodError = (error: ZodError): ErrorDetail[] =>
  error.issues.map((issue) => ({
    path: formatIssuePath(issue),
    message: issue.message,
    code: issue.code
  }));

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new HttpError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'Unauthorized', details?: unknown) {
    return new HttpError(401, 'unauthorized', message, details);
  }

  static forbidden(message = 'Forbidden', details?: unknown) {
    return new HttpError(403, 'forbidden', message, details);
  }

  static notFound(message = 'Not found', details?: unknown) {
    return new HttpError(404, 'not_found', message, details);
  }

  static conflict(message = 'Conflict', details?: unknown) {
    return new HttpError(409, 'conflict', message, details);
  }

  static rateLimited(retryAfterSeconds?: number, message = 'Rate limit exceeded') {
    const error = new HttpError(429, 'rate_limited', message);
    if (retryAfterSeconds) {
      (error as HttpError & { retryAfter?: number }).retryAfter = retryAfterSeconds;
    }
    return error;
  }

  static fromZod(error: ZodError, message = 'Invalid request') {
    return HttpError.badRequest(message, { issues: formatZodError(error) });
  }
}

export type HttpErrorWithRetry = HttpError & { retryAfter?: number };

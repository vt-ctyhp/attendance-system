"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpError = exports.formatZodError = void 0;
const formatIssuePath = (issue) => (issue.path.length ? issue.path.join('.') : '');
const formatZodError = (error) => error.issues.map((issue) => ({
    path: formatIssuePath(issue),
    message: issue.message,
    code: issue.code
}));
exports.formatZodError = formatZodError;
class HttpError extends Error {
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
    static badRequest(message, details) {
        return new HttpError(400, 'bad_request', message, details);
    }
    static unauthorized(message = 'Unauthorized', details) {
        return new HttpError(401, 'unauthorized', message, details);
    }
    static forbidden(message = 'Forbidden', details) {
        return new HttpError(403, 'forbidden', message, details);
    }
    static notFound(message = 'Not found', details) {
        return new HttpError(404, 'not_found', message, details);
    }
    static conflict(message = 'Conflict', details) {
        return new HttpError(409, 'conflict', message, details);
    }
    static rateLimited(retryAfterSeconds, message = 'Rate limit exceeded') {
        const error = new HttpError(429, 'rate_limited', message);
        if (retryAfterSeconds) {
            error.retryAfter = retryAfterSeconds;
        }
        return error;
    }
    static fromZod(error, message = 'Invalid request') {
        return HttpError.badRequest(message, { issues: (0, exports.formatZodError)(error) });
    }
}
exports.HttpError = HttpError;

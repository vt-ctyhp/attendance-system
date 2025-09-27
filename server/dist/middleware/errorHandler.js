"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = void 0;
const zod_1 = require("zod");
const errors_1 = require("../errors");
const logger_1 = require("../logger");
const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }
    let httpError;
    if (err instanceof errors_1.HttpError) {
        httpError = err;
    }
    else if (err instanceof zod_1.ZodError) {
        httpError = errors_1.HttpError.badRequest('Validation failed', { issues: (0, errors_1.formatZodError)(err) });
    }
    else {
        httpError = new errors_1.HttpError(500, 'internal_error', 'Internal server error');
        logger_1.logger.error({ err, path: req.path }, 'Unhandled error');
    }
    const retryAware = httpError;
    if (retryAware.retryAfter) {
        res.setHeader('Retry-After', retryAware.retryAfter.toString());
    }
    const details = httpError.details;
    let field;
    let hint;
    let remainingDetails = details;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
        const meta = { ...details };
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
    const responseBody = {
        error: httpError.message,
        code: httpError.code,
        requestId: req.debugReqId ?? null
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
exports.errorHandler = errorHandler;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncHandler = void 0;
const asyncHandler = (handler) => (req, res, next) => {
    return Promise.resolve(handler(req, res, next)).catch(next);
};
exports.asyncHandler = asyncHandler;

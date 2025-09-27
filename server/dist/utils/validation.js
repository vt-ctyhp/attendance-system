"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWithSchema = void 0;
const errors_1 = require("../errors");
const parseWithSchema = (schema, payload, message = 'Invalid request payload') => {
    const result = schema.safeParse(payload);
    if (!result.success) {
        throw errors_1.HttpError.fromZod(result.error, message);
    }
    return result.data;
};
exports.parseWithSchema = parseWithSchema;

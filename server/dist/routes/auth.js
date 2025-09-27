"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../prisma");
const auth_1 = require("../auth");
const asyncHandler_1 = require("../middleware/asyncHandler");
const validation_1 = require("../utils/validation");
const errors_1 = require("../errors");
const rateLimit_1 = require("../middleware/rateLimit");
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1)
});
exports.authRouter = (0, express_1.Router)();
const loginRateLimiter = (0, rateLimit_1.createRateLimiter)({
    windowMs: 60000,
    max: 8,
    message: 'Too many login attempts'
});
exports.authRouter.post('/login', loginRateLimiter, (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email, password } = (0, validation_1.parseWithSchema)(loginSchema, req.body, 'Invalid credentials');
    const user = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (!user) {
        throw errors_1.HttpError.unauthorized('Invalid credentials');
    }
    const valid = await (0, auth_1.verifyPassword)(password, user.passwordHash);
    if (!valid) {
        throw errors_1.HttpError.unauthorized('Invalid credentials');
    }
    const token = (0, auth_1.generateToken)(user);
    return res.json({
        token,
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            createdAt: user.createdAt
        }
    });
}));

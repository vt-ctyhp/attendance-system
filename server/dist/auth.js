"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = exports.authenticate = exports.generateToken = exports.verifyPassword = exports.hashPassword = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("./env");
const prisma_1 = require("./prisma");
const types_1 = require("./types");
const errors_1 = require("./errors");
const tokenService_1 = require("./services/tokenService");
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const hashPassword = async (password) => bcryptjs_1.default.hash(password, 12);
exports.hashPassword = hashPassword;
const verifyPassword = async (password, hash) => bcryptjs_1.default.compare(password, hash);
exports.verifyPassword = verifyPassword;
const generateToken = (user) => jsonwebtoken_1.default.sign({ sub: user.id, role: user.role, scope: 'full', typ: 'access' }, env_1.env.JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS
});
exports.generateToken = generateToken;
const authenticate = async (req, res, next) => {
    try {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            return next(errors_1.HttpError.unauthorized('Missing token'));
        }
        const token = header.slice(7);
        const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
        if (!decoded || typeof decoded !== 'object' || !('sub' in decoded) || !('role' in decoded)) {
            return next(errors_1.HttpError.unauthorized());
        }
        const payload = decoded;
        const user = await prisma_1.prisma.user.findUnique({ where: { id: payload.sub } });
        if (!user) {
            return next(errors_1.HttpError.unauthorized('User not found'));
        }
        if (!user.active) {
            return next(errors_1.HttpError.unauthorized('User not active'));
        }
        req.user = user;
        req.tokenScope = payload.scope ?? 'full';
        req.tokenType = payload.typ ?? 'access';
        req.tokenId = payload.jti;
        return next();
    }
    catch (err) {
        return next(errors_1.HttpError.unauthorized());
    }
};
exports.authenticate = authenticate;
const requireRole = (roles) => (req, res, next) => {
    const { user } = req;
    if (!user) {
        return next(errors_1.HttpError.unauthorized());
    }
    const role = types_1.USER_ROLES.find((value) => value === user.role) ?? user.role;
    if (!roles.includes(role)) {
        return next(errors_1.HttpError.forbidden());
    }
    if (req.tokenScope === tokenService_1.EMPLOYEE_SESSION_SCOPE && roles.some((allowed) => allowed !== 'employee')) {
        return next(errors_1.HttpError.forbidden());
    }
    return next();
};
exports.requireRole = requireRole;

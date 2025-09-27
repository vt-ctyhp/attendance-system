"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = exports.authenticate = exports.generateToken = exports.verifyPassword = exports.hashPassword = exports.resolveUserFromToken = exports.extractTokenFromRequest = exports.DASHBOARD_TOKEN_COOKIE_NAME = exports.TOKEN_TTL_SECONDS = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("./env");
const prisma_1 = require("./prisma");
const types_1 = require("./types");
const errors_1 = require("./errors");
const tokenService_1 = require("./services/tokenService");
const DASHBOARD_TOKEN_COOKIE = 'attendance_dashboard_token';
const parseCookies = (cookieHeader) => {
    if (!cookieHeader) {
        return {};
    }
    return cookieHeader.split(';').reduce((acc, part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) {
            return acc;
        }
        const key = part.slice(0, separatorIndex).trim();
        if (!key) {
            return acc;
        }
        const value = part.slice(separatorIndex + 1).trim();
        acc[key] = decodeURIComponent(value);
        return acc;
    }, {});
};
exports.TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours
exports.DASHBOARD_TOKEN_COOKIE_NAME = DASHBOARD_TOKEN_COOKIE;
const extractTokenFromRequest = (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        const token = header.slice(7).trim();
        return token || null;
    }
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[DASHBOARD_TOKEN_COOKIE];
    return cookieToken ? cookieToken : null;
};
exports.extractTokenFromRequest = extractTokenFromRequest;
const resolveTokenPayload = (token) => {
    const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
    if (!decoded || typeof decoded !== 'object' || !('sub' in decoded) || !('role' in decoded)) {
        throw errors_1.HttpError.unauthorized();
    }
    return decoded;
};
const resolveUserFromToken = async (token) => {
    const payload = resolveTokenPayload(token);
    const user = await prisma_1.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
        throw errors_1.HttpError.unauthorized('User not found');
    }
    if (!user.active) {
        throw errors_1.HttpError.unauthorized('User not active');
    }
    return { user, payload };
};
exports.resolveUserFromToken = resolveUserFromToken;
const hashPassword = async (password) => bcryptjs_1.default.hash(password, 12);
exports.hashPassword = hashPassword;
const verifyPassword = async (password, hash) => bcryptjs_1.default.compare(password, hash);
exports.verifyPassword = verifyPassword;
const generateToken = (user) => jsonwebtoken_1.default.sign({ sub: user.id, role: user.role, scope: 'full', typ: 'access' }, env_1.env.JWT_SECRET, {
    expiresIn: exports.TOKEN_TTL_SECONDS
});
exports.generateToken = generateToken;
const authenticate = async (req, res, next) => {
    try {
        const token = (0, exports.extractTokenFromRequest)(req);
        if (!token) {
            return next(errors_1.HttpError.unauthorized('Missing token'));
        }
        const { user, payload } = await (0, exports.resolveUserFromToken)(token);
        req.user = user;
        req.tokenScope = payload.scope ?? 'full';
        req.tokenType = payload.typ ?? 'access';
        req.tokenId = payload.jti;
        return next();
    }
    catch (err) {
        if (err instanceof errors_1.HttpError) {
            return next(err);
        }
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

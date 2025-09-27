"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.revokeAllEmployeeTokens = exports.rotateEmployeeTokens = exports.issueEmployeeTokens = exports.EMPLOYEE_SESSION_SCOPE = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../env");
const prisma_1 = require("../prisma");
const audit_1 = require("./audit");
const metrics_1 = require("./metrics");
exports.EMPLOYEE_SESSION_SCOPE = 'employee_session';
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60; // 10 minutes
const REFRESH_TOKEN_TTL_MINUTES = 60 * 24; // 24 hours
const hashToken = (token) => node_crypto_1.default.createHash('sha256').update(token).digest('hex');
const generateTokenString = () => node_crypto_1.default.randomBytes(48).toString('base64url');
const createTokenError = (code, meta) => Object.assign(new Error(code), { code, meta });
const generateAccessToken = (userId, scope) => jsonwebtoken_1.default.sign({
    sub: userId,
    role: 'employee',
    scope,
    typ: 'access'
}, env_1.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
const revokeTokenRecord = async (tokenId, reason) => {
    await prisma_1.prisma.refreshToken.update({
        where: { id: tokenId },
        data: {
            revokedAt: new Date(),
            revokedReason: reason
        }
    });
};
const revokeAllTokensForUser = async (userId, reason) => {
    await prisma_1.prisma.refreshToken.updateMany({
        where: {
            userId,
            revokedAt: null
        },
        data: {
            revokedAt: new Date(),
            revokedReason: reason
        }
    });
};
const issueEmployeeTokens = async ({ userId, email, deviceId, ipAddress, userAgent }) => {
    const accessToken = generateAccessToken(userId, exports.EMPLOYEE_SESSION_SCOPE);
    const refreshToken = generateTokenString();
    const tokenHash = hashToken(refreshToken);
    const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MINUTES * 60 * 1000);
    const record = await prisma_1.prisma.refreshToken.create({
        data: {
            userId,
            tokenHash,
            scope: exports.EMPLOYEE_SESSION_SCOPE,
            deviceId,
            ipAddress,
            userAgent,
            expiresAt: refreshTokenExpiresAt
        }
    });
    await (0, audit_1.recordAuthEvent)({
        event: 'email_session_token_issued',
        email,
        userId,
        scope: exports.EMPLOYEE_SESSION_SCOPE,
        accessExpiresAt: accessTokenExpiresAt,
        refreshExpiresAt: refreshTokenExpiresAt,
        ipAddress,
        userAgent,
        deviceId
    });
    return {
        accessToken,
        refreshToken,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        scope: record.scope
    };
};
exports.issueEmployeeTokens = issueEmployeeTokens;
const rotateEmployeeTokens = async ({ refreshToken, ipAddress, userAgent, deviceId }) => {
    const tokenHash = hashToken(refreshToken);
    const existing = await prisma_1.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) {
        (0, metrics_1.incrementMetric)('email_session_refresh_missing');
        throw createTokenError('invalid_refresh_token');
    }
    if (existing.revokedAt) {
        (0, metrics_1.incrementMetric)('email_session_refresh_reuse');
        await revokeAllTokensForUser(existing.userId, 'reused_refresh_token');
        throw createTokenError('reused_refresh_token', { userId: existing.userId });
    }
    if (existing.expiresAt <= new Date()) {
        await revokeTokenRecord(existing.id, 'expired');
        (0, metrics_1.incrementMetric)('email_session_refresh_expired');
        throw createTokenError('expired_refresh_token', { userId: existing.userId });
    }
    const accessToken = generateAccessToken(existing.userId, existing.scope);
    const nextRefreshToken = generateTokenString();
    const nextTokenHash = hashToken(nextRefreshToken);
    const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MINUTES * 60 * 1000);
    const nextRecord = await prisma_1.prisma.refreshToken.create({
        data: {
            userId: existing.userId,
            tokenHash: nextTokenHash,
            scope: existing.scope,
            deviceId: deviceId ?? existing.deviceId,
            ipAddress: ipAddress ?? existing.ipAddress,
            userAgent: userAgent ?? existing.userAgent,
            expiresAt: refreshTokenExpiresAt
        }
    });
    await prisma_1.prisma.refreshToken.update({
        where: { id: existing.id },
        data: {
            revokedAt: new Date(),
            revokedReason: 'rotated',
            replacedByTokenId: nextRecord.id
        }
    });
    const user = await prisma_1.prisma.user.findUnique({ where: { id: existing.userId } });
    const emailForLog = user?.email ?? 'unknown';
    await (0, audit_1.recordAuthEvent)({
        event: 'email_session_token_issued',
        email: emailForLog,
        userId: existing.userId,
        scope: nextRecord.scope,
        accessExpiresAt: accessTokenExpiresAt,
        refreshExpiresAt: refreshTokenExpiresAt,
        ipAddress: ipAddress ?? existing.ipAddress ?? undefined,
        userAgent: userAgent ?? existing.userAgent ?? undefined,
        deviceId: deviceId ?? existing.deviceId ?? undefined
    });
    return {
        result: {
            accessToken,
            refreshToken: nextRefreshToken,
            accessTokenExpiresAt,
            refreshTokenExpiresAt,
            scope: nextRecord.scope
        },
        userId: existing.userId,
        email: emailForLog
    };
};
exports.rotateEmployeeTokens = rotateEmployeeTokens;
const revokeAllEmployeeTokens = async (userId, reason) => {
    await revokeAllTokensForUser(userId, reason);
};
exports.revokeAllEmployeeTokens = revokeAllEmployeeTokens;

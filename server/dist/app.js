"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = exports.buildApp = void 0;
const express_1 = __importStar(require("express"));
const cors_1 = __importDefault(require("cors"));
const pino_http_1 = __importDefault(require("pino-http"));
const crypto_1 = require("crypto");
const logger_1 = require("./logger");
const auth_1 = require("./routes/auth");
const sessions_1 = require("./routes/sessions");
const events_1 = require("./routes/events");
const reports_1 = require("./routes/reports");
const me_1 = require("./routes/me");
const dashboard_1 = require("./routes/dashboard");
const timeRequests_1 = require("./routes/timeRequests");
const balances_1 = require("./routes/balances");
const adminSettings_1 = require("./routes/adminSettings");
const timesheets_1 = require("./routes/timesheets");
const health_1 = require("./routes/health");
const appData_1 = require("./routes/appData");
const errorHandler_1 = require("./middleware/errorHandler");
const extractSessionId = (req) => {
    const body = req.body;
    if (body && typeof body.sessionId === 'string') {
        return body.sessionId;
    }
    if (body && typeof body.session_id === 'string') {
        return body.session_id;
    }
    const paramsSession = req.params?.sessionId;
    if (typeof paramsSession === 'string') {
        return paramsSession;
    }
    const querySession = req.query?.sessionId;
    if (typeof querySession === 'string') {
        return querySession;
    }
    return null;
};
const buildApp = () => {
    const app = (0, express_1.default)();
    const allowAnonDashboard = process.env.DASHBOARD_ALLOW_ANON === 'true';
    app.use((0, cors_1.default)());
    app.use(express_1.default.json({ limit: '1mb' }));
    app.use(express_1.default.urlencoded({ extended: true }));
    app.use((req, res, next) => {
        const headerId = req.get('X-Debug-Req');
        const debugReqId = headerId && headerId.trim().length > 0 ? headerId.trim() : (0, crypto_1.randomUUID)();
        req.debugReqId = debugReqId;
        res.setHeader('X-Debug-Req', debugReqId);
        res.on('finish', () => {
            const authReq = req;
            const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
            logger_1.logger[level]({
                ts: new Date().toISOString(),
                reqId: debugReqId,
                method: req.method,
                url: req.originalUrl ?? req.url,
                status: res.statusCode,
                userId: authReq.user?.id ?? null,
                sessionId: extractSessionId(req)
            }, 'request_trace');
        });
        next();
    });
    app.use((0, pino_http_1.default)({
        logger: logger_1.logger,
        genReqId: (req) => {
            const existing = req.id;
            if (existing) {
                return existing;
            }
            const id = (0, crypto_1.randomUUID)();
            req.id = id;
            return id;
        },
        customLogLevel: (_, res, err) => {
            if (res.statusCode >= 500 || err)
                return 'error';
            if (res.statusCode >= 400)
                return 'warn';
            return 'info';
        },
        customProps: (req) => {
            const authReq = req;
            return {
                reqId: req.id,
                userId: authReq.user?.id ?? null,
                sessionId: extractSessionId(req)
            };
        }
    }));
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });
    app.get('/', (_req, res) => {
        if (allowAnonDashboard) {
            return res.redirect('/dashboard/overview');
        }
        return res.redirect('/dashboard/login');
    });
    const apiRouter = (0, express_1.Router)();
    apiRouter.use('/', health_1.healthRouter);
    apiRouter.use('/auth', auth_1.authRouter);
    apiRouter.use('/sessions', sessions_1.sessionsRouter);
    apiRouter.use('/events', events_1.eventsRouter);
    apiRouter.use('/reports', reports_1.reportsRouter);
    apiRouter.use('/me', me_1.meRouter);
    apiRouter.use('/time-requests', timeRequests_1.timeRequestsRouter);
    apiRouter.use('/balances', balances_1.balancesRouter);
    apiRouter.use('/timesheets', timesheets_1.timesheetsRouter);
    apiRouter.use('/admin', adminSettings_1.adminSettingsRouter);
    apiRouter.use('/app', appData_1.appDataRouter);
    app.use('/api', apiRouter);
    app.use('/dashboard', dashboard_1.dashboardRouter);
    app.use(errorHandler_1.errorHandler);
    return app;
};
exports.buildApp = buildApp;
exports.app = (0, exports.buildApp)();

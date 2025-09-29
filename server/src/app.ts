import express, { Router } from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import { logger } from './logger';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { eventsRouter } from './routes/events';
import { reportsRouter } from './routes/reports';
import { meRouter } from './routes/me';
import { dashboardRouter } from './routes/dashboard';
import { timeRequestsRouter } from './routes/timeRequests';
import { balancesRouter } from './routes/balances';
import { adminSettingsRouter } from './routes/adminSettings';
import { timesheetsRouter } from './routes/timesheets';
import { healthRouter } from './routes/health';
import { appDataRouter } from './routes/appData';
import type { AuthenticatedRequest } from './auth';
import { errorHandler } from './middleware/errorHandler';

const extractSessionId = (req: express.Request): string | null => {
  const body = req.body as Record<string, unknown> | undefined;
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

export const buildApp = () => {
  const app = express();

  const allowAnonDashboard = process.env.DASHBOARD_ALLOW_ANON === 'true';

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    const headerId = req.get('X-Debug-Req');
    const debugReqId = headerId && headerId.trim().length > 0 ? headerId.trim() : randomUUID();
    (req as AuthenticatedRequest & { debugReqId?: string }).debugReqId = debugReqId;
    res.setHeader('X-Debug-Req', debugReqId);

    res.on('finish', () => {
      const authReq = req as AuthenticatedRequest & { debugReqId?: string };
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level](
        {
          ts: new Date().toISOString(),
          reqId: debugReqId,
          method: req.method,
          url: req.originalUrl ?? req.url,
          status: res.statusCode,
          userId: authReq.user?.id ?? null,
          sessionId: extractSessionId(req)
        },
        'request_trace'
      );
    });

    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => {
        const existing = (req as unknown as { id?: string }).id;
        if (existing) {
          return existing;
        }
        const id = randomUUID();
        (req as unknown as { id?: string }).id = id;
        return id;
      },
      customLogLevel: (_, res, err) => {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customProps: (req) => {
        const authReq = req as AuthenticatedRequest;
        return {
          reqId: (req as unknown as { id?: string }).id,
          userId: authReq.user?.id ?? null,
          sessionId: extractSessionId(req)
        };
      }
    })
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/', (_req, res) => {
    if (allowAnonDashboard) {
      return res.redirect('/dashboard/overview');
    }
    return res.redirect('/dashboard/login');
  });

  const apiRouter = Router();
  apiRouter.use('/', healthRouter);
  apiRouter.use('/auth', authRouter);
  apiRouter.use('/sessions', sessionsRouter);
  apiRouter.use('/events', eventsRouter);
  apiRouter.use('/reports', reportsRouter);
  apiRouter.use('/me', meRouter);
  apiRouter.use('/time-requests', timeRequestsRouter);
  apiRouter.use('/balances', balancesRouter);
  apiRouter.use('/timesheets', timesheetsRouter);
  apiRouter.use('/admin', adminSettingsRouter);
  apiRouter.use('/app', appDataRouter);

  app.use('/api', apiRouter);
  app.use('/dashboard', dashboardRouter);

  app.use(errorHandler);

  return app;
};

export const app = buildApp();

import { Router, type RequestHandler } from 'express';
import { version } from '../../package.json';

export const healthRouter = Router();

export const getHealth: RequestHandler = (_req, res) => {
  res.json({ ok: true, version, time: new Date().toISOString() });
};

healthRouter.get('/health', getHealth);

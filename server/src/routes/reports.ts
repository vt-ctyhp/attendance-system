import { Router } from 'express';
import { z } from 'zod';
import { startOfDay, endOfDay } from 'date-fns';
import { authenticate, requireRole, AuthenticatedRequest } from '../auth';
import { prisma } from '../prisma';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { HttpError } from '../errors';

const summaryQuerySchema = z.object({
  date: z.string().optional()
});

const sanitizeDate = (dateString?: string) => {
  if (!dateString) return new Date();
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) {
    throw HttpError.badRequest('Invalid date');
  }
  return parsed;
};

export const reportsRouter = Router();

reportsRouter.get(
  '/summary',
  authenticate,
  requireRole(['admin', 'manager']),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { date } = parseWithSchema(summaryQuerySchema, req.query, 'Invalid query');
    const targetDate = sanitizeDate(date as string | undefined);
    const from = startOfDay(targetDate);
    const to = endOfDay(targetDate);

    const sessions = await prisma.session.findMany({
      where: {
        startedAt: {
          gte: from,
          lte: to
        }
      },
      include: {
        user: true,
        minuteStats: true,
        events: true
      }
    });

    const summaries = new Map<number, ReturnType<typeof buildSummary>>();

    for (const session of sessions) {
      const summary = summaries.get(session.userId) ?? buildSummary(session.userId, session.user.name, session.user.email);
      const activeMinutes = session.minuteStats.filter((m) => m.active).length;
      const idleMinutes = session.minuteStats.filter((m) => m.idle).length;
      const presenceMisses = session.events.filter((e) => e.type === 'presence_miss').length;
      const breaks = session.events.filter((e) => e.type === 'break_start').length;
      const lunches = session.events.filter((e) => e.type === 'lunch_start').length;
      summary.sessions.push({
        sessionId: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? null,
        status: session.status,
        activeMinutes,
        idleMinutes,
        breaks,
        lunches,
        presenceMisses
      });
      summary.totalActiveMinutes += activeMinutes;
      summary.totalIdleMinutes += idleMinutes;
      summary.totalPresenceMisses += presenceMisses;
      summaries.set(session.userId, summary);
    }

    return res.json({
      date: from.toISOString(),
      summaries: Array.from(summaries.values())
    });
  })
);

type SummarySession = {
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
  activeMinutes: number;
  idleMinutes: number;
  breaks: number;
  lunches: number;
  presenceMisses: number;
};

type SummaryResponse = {
  userId: number;
  name: string;
  email: string;
  totalActiveMinutes: number;
  totalIdleMinutes: number;
  totalPresenceMisses: number;
  sessions: SummarySession[];
};

const buildSummary = (userId: number, name: string, email: string): SummaryResponse => ({
  userId,
  name,
  email,
  totalActiveMinutes: 0,
  totalIdleMinutes: 0,
  totalPresenceMisses: 0,
  sessions: []
});

import { prisma } from '../prisma';

export const getSessionState = async (sessionId: string) => {
  const [breakPause, lunchPause] = await Promise.all([
    prisma.sessionPause.findFirst({
      where: { sessionId, type: 'break', endedAt: null },
      orderBy: { startedAt: 'desc' }
    }),
    prisma.sessionPause.findFirst({
      where: { sessionId, type: 'lunch', endedAt: null },
      orderBy: { startedAt: 'desc' }
    })
  ]);

  return {
    onBreak: Boolean(breakPause),
    onLunch: Boolean(lunchPause)
  };
};

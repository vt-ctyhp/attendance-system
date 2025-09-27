"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSessionState = void 0;
const prisma_1 = require("../prisma");
const getSessionState = async (sessionId) => {
    const [breakPause, lunchPause] = await Promise.all([
        prisma_1.prisma.sessionPause.findFirst({
            where: { sessionId, type: 'break', endedAt: null },
            orderBy: { startedAt: 'desc' }
        }),
        prisma_1.prisma.sessionPause.findFirst({
            where: { sessionId, type: 'lunch', endedAt: null },
            orderBy: { startedAt: 'desc' }
        })
    ]);
    return {
        onBreak: Boolean(breakPause),
        onLunch: Boolean(lunchPause)
    };
};
exports.getSessionState = getSessionState;

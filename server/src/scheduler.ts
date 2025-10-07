import schedule from 'node-schedule';
import { applyAccrualsForAllUsers } from './services/accruals';
import { logger } from './logger';
import { ensureUpcomingShiftsForAllUsers } from './services/shiftPlanner';

export const startSchedulers = () => {
  schedule.scheduleJob('0 0 2 1 * *', async () => {
    try {
      await applyAccrualsForAllUsers();
    } catch (error) {
      logger.error({ err: error }, 'Monthly accrual job failed');
    }
  });

  schedule.scheduleJob('0 30 0 * * *', async () => {
    try {
      const summary = await ensureUpcomingShiftsForAllUsers();
      logger.info({ summary }, 'Shift generation job completed');
    } catch (error) {
      logger.error({ err: error }, 'Shift generation job failed');
    }
  });
};

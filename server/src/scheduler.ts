import schedule from 'node-schedule';
import { applyAccrualsForAllUsers } from './services/accruals';
import { logger } from './logger';

export const startSchedulers = () => {
  schedule.scheduleJob('0 0 2 1 * *', async () => {
    try {
      await applyAccrualsForAllUsers();
    } catch (error) {
      logger.error({ err: error }, 'Monthly accrual job failed');
    }
  });
};

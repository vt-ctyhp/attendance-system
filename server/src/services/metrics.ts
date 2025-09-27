import { logger } from '../logger';

const counters = new Map<string, number>();

export const incrementMetric = (name: string, increment = 1) => {
  const current = counters.get(name) ?? 0;
  const next = current + increment;
  counters.set(name, next);
  if (next % 50 === 0) {
    logger.warn({ metric: name, count: next }, 'Metric threshold reached');
  }
};

export const getMetricSnapshot = () =>
  Array.from(counters.entries()).reduce<Record<string, number>>((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});

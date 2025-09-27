"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMetricSnapshot = exports.incrementMetric = void 0;
const logger_1 = require("../logger");
const counters = new Map();
const incrementMetric = (name, increment = 1) => {
    const current = counters.get(name) ?? 0;
    const next = current + increment;
    counters.set(name, next);
    if (next % 50 === 0) {
        logger_1.logger.warn({ metric: name, count: next }, 'Metric threshold reached');
    }
};
exports.incrementMetric = incrementMetric;
const getMetricSnapshot = () => Array.from(counters.entries()).reduce((acc, [key, value]) => {
    acc[key] = value;
    return acc;
}, {});
exports.getMetricSnapshot = getMetricSnapshot;

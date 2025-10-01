import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.{ts,js}'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 20000,
    maxWorkers: 1,
    minWorkers: 1,
    pool: 'forks'
  }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.{ts,js}'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
<<<<<<< HEAD
    globalSetup: 'tests/globalSetup.ts',
    globalTeardown: 'tests/globalTeardown.ts',
    testTimeout: 20000,
    threads: false,
    maxConcurrency: 1,
    sequence: {
      concurrent: false
    }
=======
    globalSetup: 'tests/globalSetup.ts',
    globalTeardown: 'tests/globalTeardown.ts',
    testTimeout: 20000,
    threads: false,
    maxConcurrency: 1,
    sequence: {
      concurrent: false
    }
>>>>>>> fde8241 (test(server): add PTO/UTO coverage with Postgres harness)
  }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,ts}', '**/*.test.{js,ts}'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
    globalSetup: 'tests/globalSetup.ts',
    testTimeout: 20000,
    threads: false,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov']
    }
  }
});

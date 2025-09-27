import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['tests/setup.ts'],
    globalSetup: 'tests/globalSetup.ts',
    testTimeout: 20000,
    threads: false
  }
});

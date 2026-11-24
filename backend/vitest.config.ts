import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    // Integration test files share one database; run them one at a time.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    restoreMocks: true,
  },
});

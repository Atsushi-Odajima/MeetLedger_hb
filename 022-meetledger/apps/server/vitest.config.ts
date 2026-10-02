import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 4,
  },
});

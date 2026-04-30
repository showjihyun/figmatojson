import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000, // e2e tests run the full pipeline
    pool: 'forks',
    forks: { singleFork: true },
  },
});

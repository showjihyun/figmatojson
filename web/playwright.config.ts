import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,         // single session at a time (PoC, no concurrency target)
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5273',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5273',
    timeout: 60_000,
    reuseExistingServer: true,    // port 5173 was occupied by another app on dev machine
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // Round-23 commit 977f24c bumped NODE heap to 8 GB; the architectural
      // fix in 4xxxxxx (FsSessionStore.maxCount + SESSION_GC_* env vars)
      // makes that unnecessary and lets us run the suite at default heap
      // again. Tight settings here keep memory flat: cap at 5 sessions
      // (well above any single test's session count) and let GC reclaim
      // any 30 s-stale entry every 10 s.
      SESSION_MAX_COUNT: '5',
      SESSION_GC_AGE_MS: '30000',
      SESSION_GC_INTERVAL_MS: '10000',
    },
  },
});

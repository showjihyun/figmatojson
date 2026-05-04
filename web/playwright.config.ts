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
      // Each e2e test uploads a multi-MB .fig that the server holds in memory
      // (FsSessionStore keeps every Session indefinitely; the periodic
      // gcSessions() in server/index.ts only evicts entries older than 1 h,
      // which never fires inside a ~6-min suite). With Node's default ~4 GB
      // heap, the cumulative load of all 5 e2e spec files crashes the server
      // mid-run with "Reached heap limit Allocation failed". Bumping to 8 GB
      // moves the ceiling well above one full-suite run while leaving the
      // production process untouched. Real fix is per-test session cleanup
      // or a shorter GC age — filed for a future round.
      NODE_OPTIONS: '--max-old-space-size=8192',
    },
  },
});

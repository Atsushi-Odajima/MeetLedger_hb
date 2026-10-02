import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Run: npm run e2e   (see e2e/README.md)
// Every spec file starts its own MeetLedger server (API + built PWA) on its own port with a fresh database
// (e2e/support/server.ts); the local PostgreSQL test cluster is started by e2e/global-setup.ts.
// The sandbox ships Chromium 1194; use it when the revision Playwright expects is not installed.
const LOCAL_CHROMIUM = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './test-results',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Files run in parallel (each with its own server + DB); tests inside a file run in order.
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 3,
  retries: 0,
  reporter: [['list']],
  use: {
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: existsSync(LOCAL_CHROMIUM) ? { executablePath: LOCAL_CHROMIUM } : {},
      },
    },
  ],
});

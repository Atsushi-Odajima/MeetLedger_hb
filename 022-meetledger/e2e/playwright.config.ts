import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Run: npm run e2e   (expects a MeetLedger server — API + built PWA — at E2E_BASE_URL, default http://localhost:8787)
// The sandbox ships Chromium 1194; use it when the revision Playwright expects is not installed.
const LOCAL_CHROMIUM = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8787',
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

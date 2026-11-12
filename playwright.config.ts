import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test on demo data. Starts its own server (port 4100, fresh database) and web app
 * (port 3100, separate build folder), so it can run while your normal `pnpm dev` is running.
 * Uses your installed Google Chrome (no browser download). Set PW_CHANNEL= to use Playwright's own.
 */
const WEB_PORT = process.env.PW_WEB_PORT ?? '3900';
const API_PORT = process.env.PW_API_PORT ?? '4900';
const WEB = process.env.PW_WEB_URL ?? `http://localhost:${WEB_PORT}`;
const API = process.env.PW_API_URL ?? `http://localhost:${API_PORT}`;
const channel = process.env.PW_CHANNEL ?? '';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // one shared demo server + database
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB,
    channel: channel || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: channel || undefined, viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], channel: channel || undefined, viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: 'pnpm --filter server exec tsx scripts/e2e-server.ts',
      url: `${API}/api/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { E2E_SERVER_PORT: API_PORT, E2E_WEB_ORIGIN: WEB },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `pnpm --filter web exec next dev -p ${WEB_PORT}`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        API_URL: API,
        NEXT_PUBLIC_WS_URL: `ws://localhost:${API_PORT}/ws`,
        NEXT_DIST_DIR: '.next-e2e',
        AUTH_SECRET: 'test-secret-for-e2e-testing-minimum-32-chars',
        DEMO_MODE: 'true',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});

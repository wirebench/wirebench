/**
 * The browser client's suite (hosted edition spec §17.7): headless Chromium against the server image in
 * Docker, with PostgreSQL and an echo service (`compose.yaml`). Separate from the Electron suite in
 * `../playwright.config.ts`, whose `testDir` (`specs`) never reaches this folder.
 *
 *   pnpm test:e2e:browser
 */
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './stack.js';

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // One user's session and one stack: the spec's steps run in order on one signed-in page.
  workers: 1,
  fullyParallel: false,
  retries: process.env['CI'] !== undefined ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  globalSetup: './global-setup.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
});

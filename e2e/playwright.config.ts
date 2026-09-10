import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env['CI'] !== undefined ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  globalSetup: './global-setup.ts',
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env['CI'] !== undefined ? 2 : 0,
  workers: 1,
  // Snapshots are per-OS *and* per-project: font rasterisation and scrollbar metrics differ
  // between macOS, Linux and Windows, so a snapshot taken on one is never valid on another.
  // Only the macOS set is committed, and `a11y.spec.ts` skips the screenshot tests elsewhere.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}-{platform}/{testFilePath}/{arg}{ext}',
  projects: [{ name: 'electron' }],
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  globalSetup: './global-setup.ts',
});

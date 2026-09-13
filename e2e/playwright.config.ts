import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env['CI'] !== undefined ? 2 : 0,
  // Five app instances at a time. Every spec launches its own Electron with a throwaway
  // profile and its own test server on a free port, so nothing is shared between them. Five
  // cuts the suite's wall-clock well below two workers on a developer machine; a runner with
  // few cores (the smallest hosted macOS one has three) can starve the apps at this count, so
  // watch for timing failures there.
  workers: 5,
  // Snapshots are per-OS *and* per-project: font rasterisation and scrollbar metrics differ
  // between macOS, Linux and Windows, so a snapshot taken on one is never valid on another.
  // Only the macOS set is committed, and `a11y.spec.ts` skips the screenshot tests elsewhere.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}-{platform}/{testFilePath}/{arg}{ext}',
  projects: [
    { name: 'electron', testIgnore: /perf\.spec\.ts$/ },
    // The startup and interaction budgets are timing assertions: a second app instance on the
    // same three-core runner is enough to push a cold start past its 2 s budget. This project
    // holds only that spec and runs after everything else, so it has the machine to itself.
    { name: 'electron-perf', testMatch: /perf\.spec\.ts$/, dependencies: ['electron'] },
  ],
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  globalSetup: './global-setup.ts',
});

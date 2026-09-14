import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env['CI'] !== undefined ? 2 : 0,
  // Five app instances at a time on Linux. Every spec launches its own Electron with a throwaway
  // profile and its own test server on a free port, so nothing is shared between them — except
  // the Electron binary, and that is the catch. Five processes opening the same `electron.exe`
  // on Windows hit "The process cannot access the file because it is being used by another
  // process"; macOS (three cores on the smallest hosted runner) fails the framework load under
  // the same contention, with a `dyld` error that reads like a truncated file. Both surface as
  // `electron.launch: Process failed to launch!` on whichever specs happen to start together,
  // which is why the failures move around between runs. Lowered where it bites; Linux, which
  // has never shown it, keeps the wall-clock win.
  workers: process.platform === 'linux' ? 5 : 2,
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

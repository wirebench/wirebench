import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'packages/wire/src'),
    },
  },
  test: {
    // Vitest's default `benchmark.include` (`**/*.bench.ts`) would make every project below
    // pick up `test/bench/**` in `vitest bench` mode. Blank it here so only the project that
    // asks for benchmarks — `engine-bench` — runs them.
    benchmark: { include: [] },
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**', 'packages/protocol-*/src/**', 'packages/engine/src/**'],
      exclude: ['packages/engine/src/index.ts'],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
    projects: [
      {
        test: {
          name: 'engine-unit',
          include: ['packages/engine/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'engine-integration',
          include: ['packages/engine/test/integration/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'engine-perf',
          include: ['packages/engine/test/perf/**/*.test.ts'],
          // Perf samples are wall-clock measurements: running them alongside the rest of the
          // suite on the same cores is exactly what makes a budget flaky, so this project is
          // single-threaded and its files never run in parallel with each other.
          fileParallelism: false,
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
      {
        test: {
          name: 'engine-bench',
          // Benchmarks only ever run in `vitest bench` mode (`pnpm bench`), never as part of
          // `pnpm check`: tinybench samples each one for seconds, and the pass/fail signal is
          // `engine-perf`'s gate instead. Hence no `include` — only a `benchmark.include`,
          // which the root config blanks for every other project so `pnpm bench` does not run
          // these files once per project.
          include: [],
          benchmark: { include: ['packages/engine/test/bench/**/*.bench.ts'] },
          fileParallelism: false,
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
      {
        test: {
          name: 'engine-interop',
          include: ['packages/engine/test/interop/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'cli-unit',
          include: ['packages/cli/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'cli-integration',
          include: ['packages/cli/test/integration/**/*.test.ts'],
          // Each test spawns the built CLI as a child process against a local server.
          testTimeout: 30_000,
          globalSetup: ['packages/cli/test/integration/global-setup.ts'],
        },
      },
      {
        test: {
          name: 'ssh-unit',
          include: ['packages/ssh/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ssh-integration',
          include: ['packages/ssh/test/integration/**/*.test.ts'],
          // Sessions run against an in-process SSH server on a loopback port.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'server-unit',
          include: ['packages/server/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server-integration',
          include: ['packages/server/test/integration/**/*.test.ts'],
          // Each file boots the server against a real PostgreSQL schema; see test/helpers/database.ts.
          testTimeout: 30_000,
          globalSetup: ['packages/server/test/integration/global-setup.ts'],
        },
      },
      {
        test: {
          name: 'desktop',
          include: ['apps/desktop/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/desktop/test/renderer/setup.ts'],
        },
        // `graphql` sends a bare import to its development build but a deep one (`graphql/language`,
        // as the language service uses) to the plain build: two copies, and a schema built by one
        // fails the other's realm check. Without the `development` condition both get the plain one.
        resolve: { conditions: ['module', 'browser'] },
      },
      {
        // The main-process code moved here from the desktop app with its tests, which still run as they
        // did there: under jsdom, with the same resolve conditions (and the same `graphql` reason).
        test: {
          name: 'host',
          include: ['packages/host/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
        resolve: { conditions: ['module', 'browser'] },
      },
      {
        test: {
          name: 'agent',
          include: ['packages/agent/test/**/*.test.ts'],
          // Real sockets on 127.0.0.1 against a fake server on loopback.
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'site',
          include: ['site/test/**/*.test.ts'],
        },
      },
    ],
  },
});

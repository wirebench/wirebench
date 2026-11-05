import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { assignShards, spawnsGit, TIMINGS_PATH, timingKey, type ShardTimings } from './scripts/vitest-shards.ts';

// CI splits the coverage run across runners (`ci.yml`, the `coverage` matrix). Each shard covers only part of
// the suite, so it skips the thresholds and the reports and writes a blob instead; the `coverage-report` job
// merges the blobs and checks the thresholds against the whole suite.
const coverageShard = process.env['WIREBENCH_COVERAGE_SHARD'] === '1';

/**
 * `--shard=i/n` by recorded time instead of by file count, so CI's shards take about as long as each other
 * (`scripts/vitest-shards.ts`), with the files that spawn git spread across the shards. Only `shard` is replaced; the order within a shard is Vitest's own.
 */
class TimedShardSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return Promise.resolve(files);
    const timings = JSON.parse(readFileSync(TIMINGS_PATH, 'utf8')) as ShardTimings;
    const weights = timings[process.platform] ?? { defaultMs: 1, files: {} };
    const key = (spec: TestSpecification) => timingKey(spec.project.name, relative(root, spec.moduleId));
    const spread = new Set(files.filter((spec) => spawnsGit(readFileSync(spec.moduleId, 'utf8'))).map(key));
    const shardOf = assignShards(files.map(key), weights, shard.count, spread);
    return Promise.resolve(files.filter((spec) => shardOf.get(key(spec)) === shard.index - 1));
  }
}

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
    sequence: { sequencer: TimedShardSequencer },
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**', 'packages/protocol-*/src/**', 'packages/engine/src/**'],
      exclude: ['packages/engine/src/index.ts'],
      ...(coverageShard
        ? { reporter: [] }
        : {
            thresholds: {
              lines: 85,
              branches: 85,
              functions: 85,
              statements: 85,
            },
          }),
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
          name: 'server-perf',
          // The tenancy migration over a scaled fixture (hosted spec §19.10): minutes, against PostgreSQL.
          // Single-threaded like engine-perf, since it measures throughput; skips without a database.
          include: ['packages/server/test/perf/**/*.test.ts'],
          testTimeout: 1_800_000,
          hookTimeout: 1_800_000,
          fileParallelism: false,
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
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

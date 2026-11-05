import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assignShards,
  LISTED_FROM_MS,
  parseFileTimes,
  platformTimings,
  spawnsGit,
  TIMINGS_PATH,
  timingKey,
  type ShardTimings,
} from './vitest-shards.js';

describe('parseFileTimes', () => {
  it("reads each file's project, path and time from the default reporter's lines", () => {
    const log = [
      '2026-11-03T06:28:30.1Z  ✓  host  packages/host/test/a.test.ts (3 tests) 412ms',
      '2026-11-03T06:28:31.1Z  ×  cli-integration  packages/cli/test/integration/run.test.ts (40 tests | 2 skipped) 155000ms\r',
      '2026-11-03T06:28:32.1Z      ✓ a test inside a file 300ms',
      ' Test Files  2 passed (2)',
    ].join('\n');
    expect([...parseFileTimes(log)]).toEqual([
      ['host|packages/host/test/a.test.ts', 412],
      ['cli-integration|packages/cli/test/integration/run.test.ts', 155000],
    ]);
  });
});

describe('platformTimings', () => {
  it('lists the slow files and gives the rest their mean', () => {
    const times = new Map([
      ['p|slow.test.ts', 12_345],
      ['p|fast.test.ts', 100],
      ['p|faster.test.ts', 300],
    ]);
    expect(platformTimings(times)).toEqual({ defaultMs: 200, files: { 'p|slow.test.ts': 12_300 } });
  });
});

describe('assignShards', () => {
  const keys = ['p|a', 'p|b', 'p|c', 'p|d', 'p|e', 'p|f'];
  const files: Record<string, number> = { 'p|a': 10, 'p|b': 6, 'p|c': 5 };
  const weights = { defaultMs: 1, files };

  it('puts every file on exactly one shard', () => {
    for (const count of [1, 2, 3, 4, 10]) {
      const shardOf = assignShards(keys, weights, count);
      expect([...shardOf.keys()].sort()).toEqual(keys);
      for (const shard of shardOf.values()) {
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(count);
      }
    }
  });

  it('balances by weight, heaviest first', () => {
    const load = [0, 0];
    for (const [key, shard] of assignShards(keys, weights, 2)) load[shard]! += files[key] ?? weights.defaultMs;
    expect(load).toEqual([12, 12]);
  });

  it('answers the same whatever order the files come in', () => {
    expect(assignShards([...keys].reverse(), weights, 3)).toEqual(assignShards(keys, weights, 3));
  });

  it('spreads the files that spawn git over the shards before balancing the rest', () => {
    // By time alone the three light files d, e and f all land on the fourth shard, beside nothing else.
    expect(new Set(['p|d', 'p|e', 'p|f'].map((key) => assignShards(keys, weights, 4).get(key)))).toEqual(new Set([3]));
    const spread = new Set(['p|d', 'p|e', 'p|f']);
    const shardOf = assignShards(keys, weights, 4, spread);
    expect(new Set([...spread].map((key) => shardOf.get(key))).size).toBe(3);
    expect([...shardOf.keys()].sort()).toEqual(keys);
  });

  it('puts two git files on one shard only once every shard has one', () => {
    const many = ['p|g1', 'p|g2', 'p|g3', 'p|g4', 'p|g5', 'p|heavy'];
    const heavy = { defaultMs: 1, files: { 'p|heavy': 100, 'p|g1': 9, 'p|g2': 8, 'p|g3': 7, 'p|g4': 6, 'p|g5': 5 } };
    const spread = new Set(many.filter((key) => key !== 'p|heavy'));
    const shardOf = assignShards(many, heavy, 2, spread);
    const perShard = [0, 0];
    for (const key of spread) perShard[shardOf.get(key)!]! += 1;
    // By time alone `heavy` takes a shard and all five git files land on the other one.
    expect(perShard.sort()).toEqual([2, 3]);
  });
});

describe('spawnsGit', () => {
  it('knows a test file by its import of the git fixture', () => {
    expect(spawnsGit("import { describeGit } from './git-fixture.js';")).toBe(true);
    expect(spawnsGit("import { mkTempDir } from './sync/git-fixture.js';\n")).toBe(true);
    expect(spawnsGit("import {\n  describeGit,\n  mkTempDir,\n} from './git-fixture.js';")).toBe(true);
    expect(spawnsGit("import { describe } from 'vitest';")).toBe(false);
    expect(spawnsGit('  expect(spawnsGit("import { a } from \'./git-fixture.js\';")).toBe(true);')).toBe(false);
  });
});

describe('vitest-shard-timings.json', () => {
  it('has weights for each CI OS, in the form the sequencer reads', () => {
    const timings = JSON.parse(readFileSync(TIMINGS_PATH, 'utf8')) as ShardTimings;
    expect(Object.keys(timings)).toEqual(['darwin', 'linux', 'win32']);
    for (const { defaultMs, files: listed } of Object.values(timings)) {
      expect(defaultMs).toBeGreaterThan(0);
      for (const [key, ms] of Object.entries(listed)) {
        const [project, path] = key.split('|');
        expect(key).toBe(timingKey(project!, path!));
        expect(ms).toBeGreaterThanOrEqual(LISTED_FROM_MS);
      }
    }
  });
});

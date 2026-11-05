/**
 * Splits the Vitest suite into shards of about equal running time, for CI's `--shard` jobs.
 *
 * Vitest's own split deals out equal numbers of files by a hash of their paths, so a shard's time depends on
 * which slow files it happens to draw: on Windows one shard took twice as long as another, mostly because
 * `scripts/pack-check.test.ts` alone runs five minutes there. Instead, the root config's sequencer
 * (`vitest.config.ts`) gives each file a weight, its recorded time on the OS running it, and places the files
 * heaviest first, each on the shard with the least time so far. The files that spawn git are spread out first
 * ({@link spawnsGit}): balanced by time alone, five of them once shared one Windows shard and timed out.
 *
 * The weights live in `vitest-shard-timings.json`: per OS, the files slower than {@link LISTED_FROM_MS}, and
 * one default for every other file, the mean of the unlisted ones. A stale or missing entry only costs
 * balance, never a test: every file still lands on exactly one shard.
 *
 * To refresh them, save the logs of one CI run's shards for an OS (the default reporter's per-file lines,
 * `✓ project path (n tests) 123ms`) and run
 * `node scripts/vitest-shards.ts --platform <linux|win32|darwin> <log…>`, which rewrites that OS's entry.
 * Linux's shards are the `coverage` jobs; macOS's run on pushes to `main`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Files slower than this are listed by name; the rest share one default weight. */
export const LISTED_FROM_MS = 3000;

/** One OS's weights. Keys are `<project>|<path from the repository root, with forward slashes>`. */
export interface PlatformTimings {
  readonly defaultMs: number;
  readonly files: Readonly<Record<string, number>>;
}

export type ShardTimings = Readonly<Record<string, PlatformTimings>>;

/** The key a file's weight is stored under. */
export function timingKey(project: string, path: string): string {
  return `${project}|${path.replaceAll('\\', '/')}`;
}

const FILE_LINE = /[✓×]\s+(\S+)\s+(\S+\.[cm]?[jt]sx?) \(.*?\)\s+(\d+)ms\s*$/u;

/** Each file's time, from a log of the default reporter: `✓  host  packages/host/test/a.test.ts (3 tests) 412ms`. */
export function parseFileTimes(log: string): Map<string, number> {
  const times = new Map<string, number>();
  for (const line of log.split(/\r?\n/u)) {
    const match = FILE_LINE.exec(line);
    if (match) times.set(timingKey(match[1]!, match[2]!), Number(match[3]));
  }
  return times;
}

/** Reduces measured times to the weights stored for one OS. */
export function platformTimings(times: ReadonlyMap<string, number>): PlatformTimings {
  const files: Record<string, number> = {};
  let unlistedTotal = 0;
  let unlisted = 0;
  for (const key of [...times.keys()].sort()) {
    const ms = times.get(key)!;
    if (ms >= LISTED_FROM_MS) files[key] = Math.round(ms / 100) * 100;
    else {
      unlistedTotal += ms;
      unlisted += 1;
    }
  }
  return { defaultMs: unlisted === 0 ? LISTED_FROM_MS : Math.round(unlistedTotal / unlisted), files };
}

/**
 * Whether a test file spawns real git, known by its import of the sync tests' git fixture. Each such file runs
 * hundreds of git processes; on a Windows runner, where a process starts several times slower, a shard drawing
 * five of them at once ran them three times slower than alone, past their timeouts. Only an `import` statement
 * counts, so a file that merely mentions the fixture in a string does not.
 */
export function spawnsGit(source: string): boolean {
  return /^import\s[^;]*\sfrom\s+['"][^'"]*\/git-fixture\.js['"]/mu.test(source);
}

/**
 * Which shard (0-based) each key goes to. The `spread` keys (the files that spawn git) go first, heaviest first,
 * each to the shard holding the fewest of them, so no shard gets a second before every shard has one. Then the
 * rest, heaviest first, each to the shard with the least time so far. Ties go by key and then by shard number:
 * the same keys and weights always give the same answer, which is what lets every shard work out its own share
 * without talking to the others.
 */
export function assignShards(
  keys: readonly string[],
  weights: PlatformTimings,
  count: number,
  spread: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const weight = (key: string) => weights.files[key] ?? weights.defaultMs;
  const order = [...new Set(keys)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const loads = Array.from({ length: count }, () => 0);
  const spreadCounts = Array.from({ length: count }, () => 0);
  const shardOf = new Map<string, number>();
  const place = (key: string, before: (i: number, best: number) => boolean) => {
    let best = 0;
    for (let i = 1; i < count; i++) if (before(i, best)) best = i;
    loads[best]! += weight(key);
    shardOf.set(key, best);
    return best;
  };
  for (const key of order.filter((k) => spread.has(k))) {
    const shard = place(
      key,
      (i, best) =>
        spreadCounts[i]! < spreadCounts[best]! || (spreadCounts[i] === spreadCounts[best] && loads[i]! < loads[best]!),
    );
    spreadCounts[shard]! += 1;
  }
  for (const key of order.filter((k) => !spread.has(k))) place(key, (i, best) => loads[i]! < loads[best]!);
  return shardOf;
}

export const TIMINGS_PATH = fileURLToPath(new URL('vitest-shard-timings.json', import.meta.url));

async function main(args: readonly string[]): Promise<void> {
  const flag = args.indexOf('--platform');
  const platform = flag === -1 ? undefined : args[flag + 1];
  const logs = args.filter((_, i) => i !== flag && i !== flag + 1);
  if (platform === undefined || !['linux', 'win32', 'darwin'].includes(platform) || logs.length === 0) {
    throw new Error('usage: node scripts/vitest-shards.ts --platform <linux|win32|darwin> <log…>');
  }
  const times = new Map<string, number>();
  for (const log of logs) for (const [key, ms] of parseFileTimes(await readFile(log, 'utf8'))) times.set(key, ms);
  if (times.size === 0) throw new Error('no per-file lines in those logs');
  const current = JSON.parse(await readFile(TIMINGS_PATH, 'utf8')) as Record<string, PlatformTimings>;
  current[platform] = platformTimings(times);
  const sorted = Object.fromEntries(
    Object.keys(current)
      .sort()
      .map((key) => [key, current[key]]),
  );
  await writeFile(TIMINGS_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${platform}: ${times.size} files, ${Object.keys(current[platform].files).length} listed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

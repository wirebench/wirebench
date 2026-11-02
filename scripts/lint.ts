/**
 * Runs ESLint over the repository one part at a time, each part in its own process.
 *
 * The lint is type-aware: every file is checked with TypeScript's type information, so ESLint keeps a
 * type-checker for each tsconfig project it opens, and keeps it until the process exits. One `eslint .`
 * over the whole tree therefore holds every project at once; on a developer machine that passed 8 GB
 * and died of a heap overflow, while the largest single part (`apps/desktop`) peaks under 4 GB. Running
 * the parts as separate processes gives each one's memory back when it ends, so the lint fits Node's
 * default heap.
 *
 * The parts are each folder under `apps/` and `packages/`, every other top-level folder, and the
 * lintable files at the root, so together they cover exactly what `eslint .` covers; the config's own
 * ignores still decide what is skipped. Rules see one file at a time, so splitting changes no result.
 * Parts run a few at a time, as many as memory allows ({@link lintConcurrency}), largest first.
 *
 * `node scripts/lint.ts [eslint args…]` passes its arguments to every run (`--fix`, for example) and
 * exits non-zero when any part fails. Wired into `pnpm lint` and `pnpm lint:fix`.
 */
import { execFile, spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Top-level folders whose subfolders are each linted on their own. */
export const SPLIT_FOLDERS: readonly string[] = ['apps', 'packages'];

/** Top-level entries never handed to ESLint; it never lints them anyway. */
const SKIPPED_ENTRIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** Files ESLint lints by extension when it walks a folder. */
const LINTABLE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Memory budgeted for one ESLint process: the largest part peaks a little under 4 GB. */
const MEMORY_PER_RUN = 6 * 1024 ** 3;

/** Upper bound on parallel runs, so a large machine stays usable while it lints. */
const MAX_PARALLEL_RUNS = 4;

/** One top-level directory entry. */
export interface RootEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * The ESLint targets, in no particular order: each subfolder of a {@link SPLIT_FOLDERS} folder, every
 * other top-level folder, and one target holding every lintable root file. A target is a list of paths
 * passed to one ESLint run. Pure: the caller reads the directories.
 */
export function lintTargets(
  root: readonly RootEntry[],
  subfolders: Readonly<Record<string, readonly string[]>>,
): string[][] {
  const targets: string[][] = [];
  const rootFiles: string[] = [];
  for (const entry of root) {
    if (SKIPPED_ENTRIES.has(entry.name)) {
      continue;
    }
    if (!entry.isDirectory) {
      if (LINTABLE_FILE.test(entry.name)) {
        rootFiles.push(entry.name);
      }
      continue;
    }
    if (SPLIT_FOLDERS.includes(entry.name)) {
      for (const sub of subfolders[entry.name] ?? []) {
        targets.push([`${entry.name}/${sub}`]);
      }
      continue;
    }
    targets.push([entry.name]);
  }
  if (rootFiles.length > 0) {
    targets.push(rootFiles.sort());
  }
  return targets;
}

/** How many ESLint runs go at once: what memory allows, at least one, at most the cores and {@link MAX_PARALLEL_RUNS}. */
export function lintConcurrency(totalMemoryBytes: number, cores: number): number {
  return Math.max(1, Math.min(Math.floor(totalMemoryBytes / MEMORY_PER_RUN), cores, MAX_PARALLEL_RUNS));
}

/** Tracked lintable files under the target's paths, used to start the largest parts first. */
function weight(target: readonly string[], tracked: readonly string[]): number {
  return tracked.filter((file) => target.some((path) => file === path || file.startsWith(`${path}/`))).length;
}

interface RunResult {
  readonly target: readonly string[];
  readonly code: number;
  readonly output: string;
  readonly seconds: number;
}

function runEslint(repoRoot: string, target: readonly string[], extraArgs: readonly string[]): Promise<RunResult> {
  const started = Date.now();
  const args = [
    'exec',
    'eslint',
    '--max-warnings',
    '0',
    '--no-warn-ignored',
    '--no-error-on-unmatched-pattern',
    ...extraArgs,
    ...target,
  ];
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd: repoRoot, shell: process.platform === 'win32' });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => {
      resolve({ target, code: code ?? 1, output, seconds: (Date.now() - started) / 1000 });
    });
  });
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const extraArgs = process.argv.slice(2);

  const root = (await readdir(repoRoot, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));
  const subfolders: Record<string, string[]> = {};
  for (const folder of SPLIT_FOLDERS) {
    if (root.some((entry) => entry.name === folder && entry.isDirectory)) {
      subfolders[folder] = (await readdir(join(repoRoot, folder), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    }
  }

  const { stdout } = await promisify(execFile)('git', ['ls-files'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const tracked = stdout.split('\n').filter((file) => LINTABLE_FILE.test(file));
  const queue = lintTargets(root, subfolders).sort((a, b) => weight(b, tracked) - weight(a, tracked));

  const parallel = lintConcurrency(totalmem(), availableParallelism());
  const total = queue.length;
  let failed = 0;
  const worker = async (): Promise<void> => {
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      const result = await runEslint(repoRoot, target, extraArgs);
      const label = result.target.join(' ');
      if (result.code === 0) {
        process.stdout.write(`eslint ${label}: ok (${result.seconds.toFixed(0)} s)\n`);
      } else {
        failed += 1;
        process.stderr.write(`eslint ${label}: failed (exit ${String(result.code)})\n${result.output}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));

  if (failed > 0) {
    process.stderr.write(`eslint: ${String(failed)} of ${String(total)} parts failed\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`eslint: all ${String(total)} parts clean (${String(parallel)} at a time)\n`);
}

// Only run when executed directly, not when the test file imports the pure functions above.
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}

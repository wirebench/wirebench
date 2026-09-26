import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';
import { GitCli, findGit, type GitLocation } from '@wirebench/engine';

export const gitLocation: GitLocation | undefined = await findGit({});
if (gitLocation === undefined) {
  if (process.env.WIREBENCH_REQUIRE_GIT === '1')
    throw new Error('git is required (WIREBENCH_REQUIRE_GIT=1) but was not found');
  console.warn('git not found; git-backed server tests are skipped');
}

/**
 * Each test spawns git several times, and a process start on a Windows CI runner can take hundreds
 * of milliseconds: commit-store tests have taken 6.8 s there, past vitest's 5 s default.
 */
const GIT_TEST_TIMEOUT_MS = 30_000;

/**
 * Typed as the narrower `(name, factory) => void` rather than `typeof describe`, matching
 * `describeDb` in database.ts: vitest 5's `SuiteAPI` type has `describe` and `describe.skip`
 * structurally incompatible, so assigning either branch to a `typeof describe`-typed const fails
 * to typecheck under strict TS.
 */
export const describeGit: (name: string, factory: () => void) => void = (name, factory) => {
  (gitLocation === undefined ? describe.skip : describe)(name, { timeout: GIT_TEST_TIMEOUT_MS }, factory);
};

/** A `GitCli` whose global and system config are empty, so the developer's gitconfig cannot leak in. */
export function testGit(hooksDir: string): GitCli {
  return new GitCli(gitLocation!, {
    hooksDir,
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(hooksDir, '.gitconfig-none') },
  });
}

export const mkTempDir = (prefix = 'wbs-repos-'): Promise<string> => mkdtemp(join(tmpdir(), prefix));
export const removeTempDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/**
 * Shared setup for every git-backed sync test (this task's contract suite and unit tests, and
 * Task 7's `SyncService` tests): finding a real system git once, skipping loudly when this
 * machine has none (mirroring `scripts/wss-xmlsec-check.ts`'s `WIREBENCH_REQUIRE_XMLSEC`
 * precedent), and small helpers for a hermetic temp repository.
 *
 * `WIREBENCH_REQUIRE_GIT=1` (set on CI's `check`/`coverage` jobs) turns a missing git into a hard
 * failure at collection time instead of a skip, so CI can never silently skip these suites.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe } from 'vitest';
import { findGit, GitCli, type GitLocation } from '@wirebench/engine';

const REQUIRE_GIT = process.env['WIREBENCH_REQUIRE_GIT'] === '1';

/** The system git this test run will use, resolved once at module load. `undefined` when none was found. */
export const gitLocation: GitLocation | undefined = await findGit({});

if (gitLocation === undefined) {
  if (REQUIRE_GIT) {
    throw new Error(
      'git not found, and WIREBENCH_REQUIRE_GIT=1 requires a system git executable for the sync test suites.',
    );
  }
  console.warn('git not found — skipping git sync backend tests (set WIREBENCH_REQUIRE_GIT=1 to fail)');
}

/** `describe` when a usable git was found on this machine; `describe.skip` otherwise (warning already logged above). */
export const describeGit: typeof describe = gitLocation === undefined ? (describe.skip as typeof describe) : describe;

/** Creates a fresh temp directory under the OS temp root, prefixed for easy identification. */
export async function mkTempDir(prefix = 'wirebench-sync-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Recursively removes a temp directory created by {@link mkTempDir}; safe to call if already gone.
 * Retries, because Windows briefly keeps a closed watcher's or a finished git's handles open (EBUSY).
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Env for a `GitCli` under test that never reads or writes the developer's global git config:
 * `GIT_CONFIG_GLOBAL` points at an empty file inside `configDir`, and `GIT_CONFIG_NOSYSTEM=1`
 * keeps the machine's `/etc/gitconfig` out too.
 */
export async function hermeticGitEnv(configDir: string): Promise<NodeJS.ProcessEnv> {
  const configFile = join(configDir, '.gitconfig-test');
  await writeFile(configFile, '', 'utf8');
  return { GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_NOSYSTEM: '1' };
}

/** A `GitCli` wired for tests: the resolved {@link gitLocation}, an empty hooks dir, hermetic env. */
export function makeTestGitCli(hooksDir: string, env: NodeJS.ProcessEnv): GitCli {
  if (gitLocation === undefined) {
    throw new Error('makeTestGitCli called without a resolved git — guard the call with describeGit.');
  }
  return new GitCli(gitLocation, { hooksDir, env });
}

/**
 * `git init --bare` in `dir`, with HEAD set to `main` regardless of the runner's own
 * `init.defaultBranch` — clones then reliably check out `main`.
 */
export async function createBareRemote(git: GitCli, dir: string): Promise<{ dir: string; url: string }> {
  await git.run(undefined, ['init', '--bare', dir]);
  await git.run(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { dir, url: pathToFileURL(dir).href };
}

/** Sets repo-local (never global) commit identity — every temp repo needs one to commit. */
export async function setTestIdentity(
  git: GitCli,
  tree: string,
  name = 'Test User',
  email = 'test@example.com',
): Promise<void> {
  await git.run(tree, ['config', 'user.name', name]);
  await git.run(tree, ['config', 'user.email', email]);
}

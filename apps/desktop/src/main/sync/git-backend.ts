/**
 * The `SyncBackend` for a workspace shared as a git repository. Every operation runs through the
 * `GitCli` it is constructed with (which itself never imports Electron), so this file stays plain
 * Node too — the server backend of spec 2 shares no code with it, but is held to the same
 * contract by `apps/desktop/test/sync/backend-contract.test.ts`.
 */

import { access, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitShareSettings, TreeChange } from '@wirebench/engine';
import {
  GIT_ATTRIBUTES,
  GIT_ATTRIBUTES_FILE,
  WirebenchError,
  describeTreePath,
  isWirebenchError,
} from '@wirebench/engine';
import type { SyncBackend } from './backend.js';
import { assertBranchName, assertRemoteUrl, type GitCli } from './git-cli.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncState, SyncStatusWire } from './types.js';

/** Dependencies a `GitBackend` needs — never Electron, per the file-level rule. */
export interface GitBackendDeps {
  readonly git: GitCli;
  readonly tree: string;
  readonly settings: () => GitShareSettings;
  readonly now?: () => Date;
}

/** Writes `.gitattributes` into `tree` if it does not already have one — used by `init` and `clone`. */
async function ensureGitAttributes(tree: string): Promise<void> {
  const file = join(tree, GIT_ATTRIBUTES_FILE);
  try {
    await access(file);
  } catch {
    await writeFile(file, GIT_ATTRIBUTES, 'utf8');
  }
}

/** Compares two dot-separated version strings numerically (mirrors `git-cli.ts`'s private helper). */
function compareVersions(a: string, b: string): number {
  const toParts = (version: string): number[] =>
    version
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));
  const partsA = toParts(a);
  const partsB = toParts(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** git version from which `init -b <branch>` is available. */
const INIT_BRANCH_FLAG_VERSION = '2.28.0';

type TreeChangeStatus = TreeChange['status'];

/** One parsed line ("record") of `git status --porcelain=v2 -z`. */
interface StatusEntry {
  readonly path: string;
  readonly status: TreeChangeStatus;
  readonly conflict: boolean;
  /** The raw two-character `XY` code, kept only for conflict (`u `) records — `resolve` needs it
   * to tell which side (if either) deleted the path. */
  readonly xy?: string;
}

/** Combines an ordinary/rename entry's XY code into one overall status. */
function statusFromXY(xy: string): TreeChangeStatus {
  if (xy.includes('D')) {
    return 'deleted';
  }
  if (xy.includes('A')) {
    return 'added';
  }
  return 'modified';
}

/**
 * Parses `git status --porcelain=v2 -z --untracked-files=all` output — NUL-terminated records
 * with NUL-separated tokens instead of newline-terminated, C-quoted lines, so a non-ASCII path or
 * one containing a space, tab or newline round-trips as raw bytes rather than a quoted escape
 * sequence a naive newline-split would leave `resolve`/`checkout` unable to find. Record kinds:
 * ordinary changes (`1 `), renames/copies (`2 `, whose original path is a *separate* NUL-terminated
 * token immediately following — skipped here, `resolve`/`checkout` only need the new path), unmerged
 * conflicts (`u `, always reported `modified` + `conflict: true`, `xy` kept for `resolve`) and
 * untracked files (`? `, reported `added`). `!` (ignored) records are never present here (no
 * `--ignored` flag is passed), so they are simply skipped if seen.
 */
function parsePorcelainV2(stdout: string): StatusEntry[] {
  const tokens = stdout.split('\x00').filter((token) => token.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith('1 ')) {
      const fields = token.split(' ');
      const xy = fields[1] ?? '';
      const path = fields.slice(8).join(' ');
      entries.push({ path, status: statusFromXY(xy), conflict: false });
    } else if (token.startsWith('2 ')) {
      const fields = token.split(' ');
      const xy = fields[1] ?? '';
      const path = fields.slice(9).join(' ');
      entries.push({ path, status: statusFromXY(xy), conflict: false });
      i += 1; // The next token is the rename/copy's original path — not needed here.
    } else if (token.startsWith('u ')) {
      const fields = token.split(' ');
      const xy = fields[1] ?? '';
      const path = fields.slice(10).join(' ');
      entries.push({ path, status: 'modified', conflict: true, xy });
    } else if (token.startsWith('? ')) {
      entries.push({ path: token.slice(2), status: 'added', conflict: false });
    }
  }
  return entries;
}

/** Splits `-z`-terminated `diff --name-only -z` output into paths (raw bytes, never C-quoted). */
function splitNulPaths(stdout: string): string[] {
  return stdout.split('\x00').filter((path) => path.length > 0);
}

/** True when `error` is the `GitCli.run` `git-failed` mapping — a non-zero git exit. */
function isGitFailed(error: unknown): error is WirebenchError {
  return isWirebenchError(error) && error.code === 'git-failed';
}

/** `error`'s `{ exitCode, stderr }` details, when it is a `git-failed` `GitCli.run` rejection. */
function gitFailureDetails(error: unknown): { exitCode?: number; stderr?: string } | undefined {
  if (!isGitFailed(error)) {
    return undefined;
  }
  return error.details;
}

/**
 * True when `error` is exactly the *expected* non-zero exit a caller is prepared to treat as a
 * normal outcome (an unborn branch, a missing remote, and so on) — identified by both its exit
 * code and a pattern in its stderr, never by "any git-failed error", so an unrelated failure
 * (a timeout, a corrupted repository, an unexpected git version's wording) is rethrown instead of
 * silently reinterpreted. A timeout in particular carries no `exitCode` at all (see `git-cli.ts`'s
 * `run`), so it can never match here.
 */
function isExpectedGitFailure(error: unknown, exitCode: number, stderrPattern?: RegExp): boolean {
  const details = gitFailureDetails(error);
  if (details === undefined || details.exitCode !== exitCode) {
    return false;
  }
  if (stderrPattern === undefined) {
    return true;
  }
  return stderrPattern.test(details.stderr ?? '');
}

/** Matches git's refusal to merge/checkout over files with uncommitted changes. */
const WOULD_BE_OVERWRITTEN_PATTERN = /would be overwritten by (merge|checkout)/i;

export class GitBackend implements SyncBackend {
  readonly kind = 'git' as const;
  private readonly git: GitCli;
  private readonly tree: string;
  private readonly settingsFn: () => GitShareSettings;
  private readonly now: () => Date;
  private lastSyncAt: string | undefined;

  constructor(deps: GitBackendDeps) {
    this.git = deps.git;
    this.tree = deps.tree;
    this.settingsFn = deps.settings;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Initialises a brand-new repository at `tree` on branch `branch`, working around `init -b`
   * only existing from git 2.28 (`init` then `symbolic-ref HEAD` on older git), and writes
   * `.gitattributes` since the tree is empty.
   */
  static async init(git: GitCli, tree: string, branch: string): Promise<void> {
    const validBranch = assertBranchName(branch);
    if (compareVersions(git.version, INIT_BRANCH_FLAG_VERSION) < 0) {
      await git.run(undefined, ['init', tree]);
      await git.run(tree, ['symbolic-ref', 'HEAD', `refs/heads/${validBranch}`]);
    } else {
      await git.run(undefined, ['init', '-b', validBranch, tree]);
    }
    await ensureGitAttributes(tree);
  }

  /**
   * Clones `remote` (validated with {@link assertRemoteUrl}) into `into`, checking out `branch`
   * when given. `into` does not exist yet, so the clone runs with its parent directory as `cwd`.
   * Writes `.gitattributes` afterwards if the clone did not already have one.
   */
  static async clone(git: GitCli, remote: string, branch: string | undefined, into: string): Promise<void> {
    const validated = assertRemoteUrl(remote);
    const validBranch = branch !== undefined ? assertBranchName(branch) : undefined;
    const args = ['clone', ...(validBranch !== undefined ? ['--branch', validBranch] : []), '--', validated, into];
    await git.run(dirname(into), args, { timeoutMs: 600_000 });
    await ensureGitAttributes(into);
  }

  private settings(): GitShareSettings {
    return this.settingsFn();
  }

  /** `origin`'s URL, or `undefined` when there is no such remote (`remote get-url` exits 2). */
  private async getRemoteUrl(): Promise<string | undefined> {
    try {
      const { stdout } = await this.git.run(this.tree, ['remote', 'get-url', 'origin']);
      return stdout.trim();
    } catch (error) {
      if (isExpectedGitFailure(error, 2)) {
        return undefined;
      }
      throw error;
    }
  }

  /** The branch HEAD currently points at, or `undefined` on an unborn branch. */
  private async currentBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await this.git.run(this.tree, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
      return branch.length > 0 ? branch : undefined;
    } catch (error) {
      if (isExpectedGitFailure(error, 128, /ambiguous argument|unknown revision/i)) {
        return undefined;
      }
      throw error;
    }
  }

  /** Whether `ref` resolves to a commit right now (`rev-parse --verify --quiet` exits 1 when it doesn't). */
  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.run(this.tree, ['rev-parse', '--verify', '--quiet', ref]);
      return true;
    } catch (error) {
      if (isExpectedGitFailure(error, 1)) {
        return false;
      }
      throw error;
    }
  }

  /** Current `status --porcelain=v2 -z --untracked-files=all`, parsed. */
  private async status(): Promise<StatusEntry[]> {
    const { stdout } = await this.git.run(this.tree, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    return parsePorcelainV2(stdout);
  }

  async probe(): Promise<SyncStatusWire> {
    try {
      await this.git.run(this.tree, ['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      if (isExpectedGitFailure(error, 128, /not a git repository/i)) {
        return {
          kind: 'git',
          gitAvailable: true,
          state: 'error',
          ahead: 0,
          behind: 0,
          uncommitted: 0,
          error: { code: 'git-not-a-repository', message: 'This folder is not a git repository.' },
        };
      }
      throw error;
    }

    const entries = await this.status();
    const conflictEntries = entries.filter((entry) => entry.conflict);

    const remote = await this.getRemoteUrl();
    const branch = await this.currentBranch();

    let ahead = 0;
    let behind = 0;
    if (remote !== undefined && branch !== undefined) {
      try {
        const validBranch = assertBranchName(branch);
        const { stdout } = await this.git.run(this.tree, [
          'rev-list',
          '--left-right',
          '--count',
          `HEAD...origin/${validBranch}`,
        ]);
        const [left, right] = stdout.trim().split(/\s+/);
        ahead = Number.parseInt(left ?? '0', 10) || 0;
        behind = Number.parseInt(right ?? '0', 10) || 0;
      } catch (error) {
        const branchRefused = isWirebenchError(error) && error.code === 'git-branch-refused';
        if (branchRefused || isExpectedGitFailure(error, 128, /ambiguous argument|unknown revision/i)) {
          ahead = 0;
          behind = 0;
        } else {
          throw error;
        }
      }
    }

    const state: SyncState =
      conflictEntries.length > 0
        ? 'conflict'
        : ahead > 0 && behind > 0
          ? 'diverged'
          : ahead > 0
            ? 'ahead'
            : behind > 0
              ? 'behind'
              : 'clean';

    return {
      kind: 'git',
      gitAvailable: true,
      state,
      ahead,
      behind,
      uncommitted: entries.length,
      ...(remote !== undefined ? { remote } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(this.lastSyncAt !== undefined ? { lastSyncAt: this.lastSyncAt } : {}),
    };
  }

  async fetch(): Promise<SyncStatusWire> {
    const branch = assertBranchName(this.settings().branch);
    const hasRemote = (await this.getRemoteUrl()) !== undefined;
    if (hasRemote) {
      // A refspec, never a bare branch name, so the argument can never be read as a flag even if
      // `assertBranchName` somehow let one slip through. The leading `+` forces the update of
      // `refs/remotes/origin/<branch>` even when the remote's history was rewritten (e.g. a
      // force-push) — without it this is a fast-forward-only update, so a rewritten remote branch
      // would make every subsequent fetch fail with "non-fast-forward" and leave the tracking ref
      // stuck forever (the plain `fetch origin <branch>` this replaced updated it through the
      // remote's own configured `+refs/heads/*:refs/remotes/origin/*` fetch refspec instead).
      await this.git.run(this.tree, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        timeoutMs: 600_000,
      });
    }
    this.lastSyncAt = this.now().toISOString();
    return this.probe();
  }

  async merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }> {
    const branch = assertBranchName(this.settings().branch);
    const remoteRef = `origin/${branch}`;
    if (!(await this.refExists(remoteRef))) {
      return { conflicts: [], changedPaths: [] };
    }

    // A real `git merge` refuses outright — before touching anything — when the working tree has
    // uncommitted changes to a path the merge would need to update, surfacing as a raw
    // `git-failed` ("Your local changes … would be overwritten by merge"). Checking first turns
    // that into the same user-facing `sync-uncommitted` every backend reports for this situation,
    // and avoids running (and having to unwind) a merge that was never going to succeed.
    const preStatus = await this.status();
    if (preStatus.some((entry) => !entry.conflict)) {
      throw new WirebenchError('sync-uncommitted', 'Commit or discard your local changes before pulling.');
    }

    let before: string | undefined;
    try {
      before = (await this.git.run(this.tree, ['rev-parse', 'HEAD'])).stdout.trim();
    } catch {
      before = undefined;
    }

    try {
      await this.git.run(this.tree, ['merge', '--no-edit', remoteRef]);
    } catch (error) {
      const details = gitFailureDetails(error);
      if (details !== undefined && WOULD_BE_OVERWRITTEN_PATTERN.test(details.stderr ?? '')) {
        throw new WirebenchError('sync-uncommitted', 'Commit or discard your local changes before pulling.');
      }
      if (isGitFailed(error)) {
        const conflicts = await this.conflicts();
        if (conflicts.length > 0) {
          return { conflicts, changedPaths: [] };
        }
      }
      throw error;
    }

    if (before === undefined) {
      return { conflicts: [], changedPaths: [] };
    }
    const { stdout } = await this.git.run(this.tree, ['diff', '--name-only', '-z', before, 'HEAD']);
    return { conflicts: [], changedPaths: splitNulPaths(stdout) };
  }

  async commit(message: string): Promise<{ committed: boolean }> {
    await this.git.run(this.tree, ['add', '-A', '--', '.']);
    const { stdout } = await this.git.run(this.tree, ['status', '--porcelain']);
    if (stdout.trim().length === 0) {
      return { committed: false };
    }
    await this.git.run(this.tree, ['commit', '-m', message]);
    return { committed: true };
  }

  async push(): Promise<SyncStatusWire> {
    const branch = assertBranchName(this.settings().branch);
    const remote = await this.getRemoteUrl();
    if (remote === undefined) {
      throw new WirebenchError('sync-no-remote', 'This workspace has no remote to push to.');
    }
    // A refspec (`HEAD:refs/heads/<branch>`), never a bare branch name passed as its own
    // argument, so nothing here can ever be read as a flag. `-u` is dropped along with it — git
    // already updates the local `refs/remotes/origin/<branch>` tracking ref for a branch it just
    // pushed, `-u` only additionally records upstream-tracking configuration this backend does
    // not otherwise rely on.
    await this.git.run(this.tree, ['push', 'origin', `HEAD:refs/heads/${branch}`], { timeoutMs: 600_000 });
    return this.probe();
  }

  async conflicts(): Promise<SyncConflictWire[]> {
    const { stdout } = await this.git.run(this.tree, ['diff', '--name-only', '-z', '--diff-filter=U']);
    return splitNulPaths(stdout).map((path) => {
      const entity = describeTreePath(path);
      return { path, entity: { kind: entity.kind, name: entity.name } };
    });
  }

  async resolve(path: string, side: 'mine' | 'theirs'): Promise<void> {
    const entries = await this.status();
    const xy = entries.find((entry) => entry.conflict && entry.path === path)?.xy;
    const oursDeleted = xy !== undefined && xy[0] === 'D';
    const theirsDeleted = xy !== undefined && xy[1] === 'D';
    const keepDeletion = (side === 'mine' && oursDeleted) || (side === 'theirs' && theirsDeleted);

    if (keepDeletion) {
      // The side being kept deleted this path — `checkout --ours|--theirs` has nothing to check
      // out ("does not have our/their version") — so the resolution is to keep it gone instead.
      try {
        await this.git.run(this.tree, ['rm', '--quiet', '--', path]);
      } catch {
        // The working-tree file is already absent (the other side deleted it too, or removed it
        // some other way) — clear the index's conflict entry directly.
        await this.git.run(this.tree, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path]);
      }
      return;
    }

    const flag = side === 'mine' ? '--ours' : '--theirs';
    await this.git.run(this.tree, ['checkout', flag, '--', path]);
    await this.git.run(this.tree, ['add', '--', path]);
  }

  async finishMerge(): Promise<{ changedPaths: string[] }> {
    // Commits only what is staged — the resolved merge — so a file saved (and left unstaged or
    // untracked) while the conflict was open stays uncommitted and out of the list below.
    await this.git.run(this.tree, ['commit', '--no-edit']);
    const { stdout } = await this.git.run(this.tree, ['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']);
    return { changedPaths: splitNulPaths(stdout) };
  }

  async abortMerge(): Promise<void> {
    await this.git.run(this.tree, ['merge', '--abort']);
  }

  async log(limit: number): Promise<SyncLogEntryWire[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.git.run(this.tree, ['log', '--format=%H%x00%s%x00%an%x00%aI', '-n', String(limit)]));
    } catch (error) {
      if (isExpectedGitFailure(error, 128, /does not have any commits yet/i)) {
        return [];
      }
      throw error;
    }
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id, subject, author, at] = line.split('\x00');
        return { id: id ?? '', subject: subject ?? '', author: author ?? '', at: at ?? '' };
      });
  }

  async changedPaths(): Promise<TreeChange[]> {
    const entries = await this.status();
    return entries.map((entry) => ({ path: entry.path, status: entry.status }));
  }

  async identity(): Promise<{ name: string; email: string } | undefined> {
    try {
      const { stdout } = await this.git.run(this.tree, ['var', 'GIT_COMMITTER_IDENT']);
      const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(stdout.trim());
      if (match === null) {
        return undefined;
      }
      return { name: match[1] ?? '', email: match[2] ?? '' };
    } catch (error) {
      if (isExpectedGitFailure(error, 128, /empty ident|identity unknown/i)) {
        return undefined;
      }
      throw error;
    }
  }

  async setIdentity(name: string, email: string): Promise<void> {
    await this.git.run(this.tree, ['config', 'user.name', name]);
    await this.git.run(this.tree, ['config', 'user.email', email]);
  }

  subscribeRemote(): () => void {
    // Git has no push notification of its own; `SyncService` (T7) polls on a timer instead.
    return () => {};
  }
}

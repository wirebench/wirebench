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
import { assertRemoteUrl, type GitCli } from './git-cli.js';
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

/** One parsed line of `git status --porcelain=v2`. */
interface StatusEntry {
  readonly path: string;
  readonly status: TreeChangeStatus;
  readonly conflict: boolean;
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
 * Parses `git status --porcelain=v2 --untracked-files=all` output: ordinary changes (`1 `),
 * renames/copies (`2 `, taking the new path before the tab-separated original), conflicts (`u `,
 * always reported `modified` + `conflict: true`) and untracked files (`? `, reported `added`).
 * `!` (ignored) lines are never present with `--untracked-files=all`'s default `-uall` behaviour
 * here (no `--ignored` flag is passed), so they are simply skipped if seen.
 */
function parsePorcelainV2(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('1 ')) {
      const fields = line.split(' ');
      const xy = fields[1] ?? '';
      const path = fields.slice(8).join(' ');
      entries.push({ path, status: statusFromXY(xy), conflict: false });
    } else if (line.startsWith('2 ')) {
      const fields = line.split(' ');
      const xy = fields[1] ?? '';
      const rest = fields.slice(9).join(' ');
      const path = rest.split('\t')[0] ?? rest;
      entries.push({ path, status: statusFromXY(xy), conflict: false });
    } else if (line.startsWith('u ')) {
      const fields = line.split(' ');
      const path = fields.slice(10).join(' ');
      entries.push({ path, status: 'modified', conflict: true });
    } else if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), status: 'added', conflict: false });
    }
  }
  return entries;
}

/** True when `error` is the `GitCli.run` `git-failed` mapping — a non-zero git exit. */
function isGitFailed(error: unknown): boolean {
  return isWirebenchError(error) && error.code === 'git-failed';
}

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
    if (compareVersions(git.version, INIT_BRANCH_FLAG_VERSION) < 0) {
      await git.run(undefined, ['init', tree]);
      await git.run(tree, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    } else {
      await git.run(undefined, ['init', '-b', branch, tree]);
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
    const args = ['clone', ...(branch !== undefined ? ['--branch', branch] : []), '--', validated, into];
    await git.run(dirname(into), args, { timeoutMs: 600_000 });
    await ensureGitAttributes(into);
  }

  private settings(): GitShareSettings {
    return this.settingsFn();
  }

  /** `origin`'s URL, or `undefined` when there is no such remote. */
  private async getRemoteUrl(): Promise<string | undefined> {
    try {
      const { stdout } = await this.git.run(this.tree, ['remote', 'get-url', 'origin']);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  /** The branch HEAD currently points at, or `undefined` on an unborn/detached HEAD lookup failure. */
  private async currentBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await this.git.run(this.tree, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
      return branch.length > 0 ? branch : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether `ref` resolves to a commit right now. */
  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git.run(this.tree, ['rev-parse', '--verify', ref]);
      return true;
    } catch {
      return false;
    }
  }

  async probe(): Promise<SyncStatusWire> {
    try {
      await this.git.run(this.tree, ['rev-parse', '--is-inside-work-tree']);
    } catch {
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

    const { stdout: statusOut } = await this.git.run(this.tree, ['status', '--porcelain=v2', '--untracked-files=all']);
    const entries = parsePorcelainV2(statusOut);
    const conflictEntries = entries.filter((entry) => entry.conflict);

    const remote = await this.getRemoteUrl();
    const branch = await this.currentBranch();

    let ahead = 0;
    let behind = 0;
    if (remote !== undefined && branch !== undefined) {
      try {
        const { stdout } = await this.git.run(this.tree, [
          'rev-list',
          '--left-right',
          '--count',
          `HEAD...origin/${branch}`,
        ]);
        const [left, right] = stdout.trim().split(/\s+/);
        ahead = Number.parseInt(left ?? '0', 10) || 0;
        behind = Number.parseInt(right ?? '0', 10) || 0;
      } catch {
        ahead = 0;
        behind = 0;
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
    const branch = this.settings().branch;
    const hasRemote = (await this.getRemoteUrl()) !== undefined;
    if (hasRemote) {
      await this.git.run(this.tree, ['fetch', 'origin', branch], { timeoutMs: 600_000 });
    }
    this.lastSyncAt = this.now().toISOString();
    return this.probe();
  }

  async merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }> {
    const branch = this.settings().branch;
    const remoteRef = `origin/${branch}`;
    if (!(await this.refExists(remoteRef))) {
      return { conflicts: [], changedPaths: [] };
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
    const { stdout } = await this.git.run(this.tree, ['diff', '--name-only', before, 'HEAD']);
    const changedPaths = stdout.split('\n').filter((path) => path.length > 0);
    return { conflicts: [], changedPaths };
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
    const remote = await this.getRemoteUrl();
    if (remote === undefined) {
      throw new WirebenchError('sync-no-remote', 'This workspace has no remote to push to.');
    }
    const branch = this.settings().branch;
    await this.git.run(this.tree, ['push', '-u', 'origin', branch], { timeoutMs: 600_000 });
    return this.probe();
  }

  async conflicts(): Promise<SyncConflictWire[]> {
    const { stdout } = await this.git.run(this.tree, ['diff', '--name-only', '--diff-filter=U']);
    return stdout
      .split('\n')
      .filter((path) => path.length > 0)
      .map((path) => {
        const entity = describeTreePath(path);
        return { path, entity: { kind: entity.kind, name: entity.name } };
      });
  }

  async resolve(path: string, side: 'mine' | 'theirs'): Promise<void> {
    const flag = side === 'mine' ? '--ours' : '--theirs';
    await this.git.run(this.tree, ['checkout', flag, '--', path]);
    await this.git.run(this.tree, ['add', '--', path]);
  }

  async finishMerge(): Promise<void> {
    await this.git.run(this.tree, ['commit', '--no-edit']);
  }

  async abortMerge(): Promise<void> {
    await this.git.run(this.tree, ['merge', '--abort']);
  }

  async log(limit: number): Promise<SyncLogEntryWire[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.git.run(this.tree, ['log', '--format=%H%x00%s%x00%an%x00%aI', '-n', String(limit)]));
    } catch {
      // An unborn branch (`git log` fails with "does not have any commits yet").
      return [];
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
    const { stdout } = await this.git.run(this.tree, ['status', '--porcelain=v2', '--untracked-files=all']);
    return parsePorcelainV2(stdout).map((entry) => ({ path: entry.path, status: entry.status }));
  }

  async identity(): Promise<{ name: string; email: string } | undefined> {
    try {
      const { stdout } = await this.git.run(this.tree, ['var', 'GIT_COMMITTER_IDENT']);
      const match = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(stdout.trim());
      if (match === null) {
        return undefined;
      }
      return { name: match[1] ?? '', email: match[2] ?? '' };
    } catch {
      return undefined;
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

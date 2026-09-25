/**
 * An in-memory stand-in for spec 2's server `SyncBackend`, used so the contract suite
 * (`backend-contract.test.ts`) can run the exact same assertions against it and against
 * `GitBackend` — proving the interface, not any one implementation. The server backend itself
 * does not exist yet; this fake models just enough of "commits as a monotonically increasing
 * version with a `path → content` snapshot per version" to exercise probe/fetch/merge/commit/
 * push/conflict/resolve/log/identity the same way git does.
 *
 * Not a general-purpose git emulator: no branches, no history rewriting — one linear version
 * counter per shared "remote", and a three-way merge per file (reusing the desktop's own
 * `mergeUnsaved`, whose baseline/disk/unsaved shape maps directly onto a fake merge's
 * baseline/theirs/mine).
 */

import type { TreeChange } from '@wirebench/engine';
import { WirebenchError, describeTreePath } from '@wirebench/engine';
import type { SyncBackend } from '../../src/main/sync/backend.js';
import { mergeUnsaved } from '../../src/main/unsaved-store.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncState, SyncStatusWire } from '../../src/main/sync/types.js';

type FileMap = Map<string, string>;

/** One published version of the shared "remote": a full snapshot plus commit metadata. */
interface RemoteVersion {
  readonly files: FileMap;
  readonly subject: string;
  readonly author: string;
  readonly at: string;
}

/** The shared "remote" two (or more) `FakeServerBackend`s push to and fetch from. */
export class FakeRemote {
  readonly history: RemoteVersion[] = [];
}

/** A commit made locally but not yet pushed. */
interface PendingCommit {
  readonly id: string;
  readonly files: FileMap;
  readonly subject: string;
  readonly author: string;
  readonly at: string;
}

/** State kept while a merge has unresolved conflicts. */
interface MergeState {
  readonly conflicts: Set<string>;
  readonly mine: FileMap;
  readonly theirs: FileMap;
  readonly preMergeFiles: FileMap;
  /** Every path the merge itself wrote or left conflicted — what `finishMerge` commits (git's "staged"). */
  readonly mergePaths: ReadonlySet<string>;
}

let nextCommitId = 0;

/** Counts paths whose content differs between two file maps (present-vs-absent counts too). */
function countDiff(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): number {
  const paths = new Set([...a.keys(), ...b.keys()]);
  let count = 0;
  for (const path of paths) {
    if (a.get(path) !== b.get(path)) {
      count += 1;
    }
  }
  return count;
}

/** Paths present in `after` but absent, or different, from `before` — used for merge `changedPaths`. */
function diffPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const path of paths) {
    if (before.get(path) !== after.get(path)) {
      changed.push(path);
    }
  }
  return changed;
}

export class FakeServerBackend implements SyncBackend {
  readonly kind = 'server' as const;
  private readonly remote: FakeRemote;
  /** The client's current working files (committed + any uncommitted edits from `write`). */
  private files: FileMap;
  /** How many of `remote.history`'s entries this client's `files` is built on. */
  private baseVersion: number;
  /** The highest `remote.history.length` this client knows about — updated only by `fetch()`. */
  private knownRemoteVersion: number;
  private pending: PendingCommit[] = [];
  private mergeState: MergeState | undefined;
  private identityValue: { name: string; email: string } | undefined;

  constructor(remote: FakeRemote, baseVersion = remote.history.length) {
    this.remote = remote;
    this.baseVersion = baseVersion;
    this.knownRemoteVersion = baseVersion;
    this.files = new Map(this.remoteFilesAt(baseVersion));
  }

  /** Test-only hook: reads one file from this client's current working tree. */
  read(path: string): string | undefined {
    return this.files.get(path);
  }

  /** Test-only hook: writes (or overwrites) one file in this client's working tree, uncommitted. */
  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** Test-only hook: deletes one file from this client's working tree, uncommitted. */
  delete(path: string): void {
    this.files.delete(path);
  }

  private remoteFilesAt(version: number): FileMap {
    if (version === 0) {
      return new Map();
    }
    return this.remote.history[version - 1]!.files;
  }

  /** The last fully-committed snapshot: the newest pending commit, or the remote base otherwise. */
  private lastCommittedFiles(): FileMap {
    const top = this.pending[this.pending.length - 1];
    return top !== undefined ? top.files : this.remoteFilesAt(this.baseVersion);
  }

  /**
   * Records the current working tree as a new local (unpushed) commit — what a real non-fast-
   * forward `git merge`/`commit --no-edit` does when it creates a merge commit. Called only when
   * there was something local to merge with (`pending` non-empty, or a conflict was just
   * resolved) — a plain fast-forward merge needs no synthetic commit, `lastCommittedFiles()`
   * already equals the merged tree via the advanced `baseVersion`.
   */
  private recordMergeCommit(files: FileMap = this.files): void {
    nextCommitId += 1;
    this.pending.push({
      id: `local-${nextCommitId}`,
      files: new Map(files),
      subject: 'Merge',
      author: this.identityValue !== undefined ? `${this.identityValue.name} <${this.identityValue.email}>` : 'unknown',
      at: new Date().toISOString(),
    });
  }

  probe(): Promise<SyncStatusWire> {
    const uncommitted = countDiff(this.files, this.lastCommittedFiles());
    const conflictCount = this.mergeState?.conflicts.size ?? 0;
    const ahead = this.pending.length;
    const behind = Math.max(0, this.knownRemoteVersion - this.baseVersion);
    const state: SyncState =
      conflictCount > 0
        ? 'conflict'
        : ahead > 0 && behind > 0
          ? 'diverged'
          : ahead > 0
            ? 'ahead'
            : behind > 0
              ? 'behind'
              : 'clean';
    // `gitAvailable` means "sync works" for a server share (server-sync assumption 6), as ServerBackend reports it.
    return Promise.resolve({ kind: 'server', gitAvailable: true, state, ahead, behind, uncommitted });
  }

  fetch(): Promise<SyncStatusWire> {
    this.knownRemoteVersion = this.remote.history.length;
    return this.probe();
  }

  merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }> {
    if (this.knownRemoteVersion <= this.baseVersion) {
      return Promise.resolve({ conflicts: [], changedPaths: [] });
    }
    // Mirrors real git refusing to merge over uncommitted changes: this fake only ever applies a
    // merge on top of a client's last *committed* snapshot, never on top of dirty `write()`s.
    if (countDiff(this.files, this.lastCommittedFiles()) > 0) {
      return Promise.reject(
        new WirebenchError('sync-uncommitted', 'Commit or discard your local changes before pulling.'),
      );
    }
    const baseline = this.remoteFilesAt(this.baseVersion);
    const theirs = this.remoteFilesAt(this.knownRemoteVersion);
    const mine = this.files;
    const merged = mergeUnsaved(baseline, theirs, mine);

    // `mergeUnsaved` was designed for "unsaved local edits vs. disk", where a path deleted on
    // disk silently drops a stale unsaved edit to it (`merged.dropped`) — right for that case,
    // wrong for ours: real git treats "I modified it, they deleted it" as a genuine conflict
    // (`UD`), not a silent loss of my change. Folding `dropped` into `conflicts` here, keeping
    // "mine" in the working tree until resolved, is what makes this agree with `GitBackend` on a
    // modify/delete conflict in either direction.
    const conflictPaths = [...merged.conflicts, ...merged.dropped];
    if (conflictPaths.length > 0) {
      const files = new Map(merged.files);
      for (const path of merged.dropped) {
        const mineValue = mine.get(path);
        if (mineValue !== undefined) {
          files.set(path, mineValue);
        }
      }
      this.mergeState = {
        conflicts: new Set(conflictPaths),
        mine: new Map(mine),
        theirs: new Map(theirs),
        preMergeFiles: new Map(mine),
        mergePaths: new Set([...diffPaths(mine, files), ...conflictPaths]),
      };
      this.files = files;
      const conflicts = conflictPaths.map((path) => {
        const entity = describeTreePath(path);
        return { path, entity: { kind: entity.kind, name: entity.name } };
      });
      return Promise.resolve({ conflicts, changedPaths: [] });
    }

    const before = new Map(this.files);
    const hadPendingCommits = this.pending.length > 0;
    this.files = new Map(merged.files);
    this.baseVersion = this.knownRemoteVersion;
    if (hadPendingCommits) {
      this.recordMergeCommit();
    }
    return Promise.resolve({ conflicts: [], changedPaths: diffPaths(before, this.files) });
  }

  commit(message: string): Promise<{ committed: boolean }> {
    if (countDiff(this.files, this.lastCommittedFiles()) === 0) {
      return Promise.resolve({ committed: false });
    }
    nextCommitId += 1;
    this.pending.push({
      id: `local-${nextCommitId}`,
      files: new Map(this.files),
      subject: message.split('\n')[0] ?? message,
      author: this.identityValue !== undefined ? `${this.identityValue.name} <${this.identityValue.email}>` : 'unknown',
      at: new Date().toISOString(),
    });
    return Promise.resolve({ committed: true });
  }

  push(): Promise<SyncStatusWire> {
    for (const commit of this.pending) {
      this.remote.history.push({ files: commit.files, subject: commit.subject, author: commit.author, at: commit.at });
    }
    this.pending = [];
    this.baseVersion = this.remote.history.length;
    this.knownRemoteVersion = this.remote.history.length;
    return this.probe();
  }

  conflicts(): Promise<SyncConflictWire[]> {
    if (this.mergeState === undefined) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      [...this.mergeState.conflicts].map((path) => {
        const entity = describeTreePath(path);
        return { path, entity: { kind: entity.kind, name: entity.name } };
      }),
    );
  }

  resolve(path: string, side: 'mine' | 'theirs'): Promise<void> {
    if (this.mergeState === undefined) {
      return Promise.resolve();
    }
    const value = side === 'mine' ? this.mergeState.mine.get(path) : this.mergeState.theirs.get(path);
    if (value === undefined) {
      this.files.delete(path);
    } else {
      this.files.set(path, value);
    }
    this.mergeState.conflicts.delete(path);
    return Promise.resolve();
  }

  finishMerge(): Promise<{ changedPaths: string[] }> {
    if (this.mergeState === undefined) {
      return Promise.resolve({ changedPaths: [] });
    }
    // Mirrors a real `git commit --no-edit` after resolving conflicts: only what the merge itself
    // staged (the paths it wrote plus the resolved conflicts) becomes the new (unpushed) commit;
    // anything else edited in the working tree meanwhile stays uncommitted, as unstaged edits do
    // in git. `changedPaths` is that commit against its first parent (`diff HEAD~1 HEAD`).
    const before = this.lastCommittedFiles();
    const committed = new Map(before);
    for (const path of this.mergeState.mergePaths) {
      const value = this.files.get(path);
      if (value === undefined) {
        committed.delete(path);
      } else {
        committed.set(path, value);
      }
    }
    this.recordMergeCommit(committed);
    this.baseVersion = this.knownRemoteVersion;
    this.mergeState = undefined;
    return Promise.resolve({ changedPaths: diffPaths(before, committed) });
  }

  abortMerge(): Promise<void> {
    if (this.mergeState === undefined) {
      return Promise.resolve();
    }
    this.files = new Map(this.mergeState.preMergeFiles);
    this.mergeState = undefined;
    return Promise.resolve();
  }

  log(limit: number): Promise<SyncLogEntryWire[]> {
    const fromPending: SyncLogEntryWire[] = [...this.pending]
      .reverse()
      .map((commit) => ({ id: commit.id, subject: commit.subject, author: commit.author, at: commit.at }));
    const known = this.remote.history.slice(0, this.baseVersion);
    const fromRemote: SyncLogEntryWire[] = [...known].reverse().map((commit, index) => ({
      id: `remote-${known.length - index}`,
      subject: commit.subject,
      author: commit.author,
      at: commit.at,
    }));
    return Promise.resolve([...fromPending, ...fromRemote].slice(0, limit));
  }

  changedPaths(): Promise<TreeChange[]> {
    const committed = this.lastCommittedFiles();
    const paths = new Set([...this.files.keys(), ...committed.keys()]);
    const changes: TreeChange[] = [];
    for (const path of paths) {
      const before = committed.get(path);
      const after = this.files.get(path);
      if (before === after) {
        continue;
      }
      const status: TreeChange['status'] =
        after === undefined ? 'deleted' : before === undefined ? 'added' : 'modified';
      changes.push({ path, status });
    }
    return Promise.resolve(changes);
  }

  identity(): Promise<{ name: string; email: string } | undefined> {
    return Promise.resolve(this.identityValue);
  }

  setIdentity(name: string, email: string): Promise<void> {
    this.identityValue = { name, email };
    return Promise.resolve();
  }

  subscribeRemote(): () => void {
    return () => {};
  }
}

/** Test-only pair sharing one `FakeRemote`, mirroring a git bare remote plus two clones. */
export function createFakeServerPair(): { remote: FakeRemote; a: FakeServerBackend; b: FakeServerBackend } {
  const remote = new FakeRemote();
  return { remote, a: new FakeServerBackend(remote), b: new FakeServerBackend(remote) };
}

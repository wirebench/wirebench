/**
 * The interface every share kind implements: `GitBackend` and `FolderBackend` here, the server
 * backend of spec 2 (plain Node, same shape), and `FakeServerBackend` in the test suite (an
 * in-memory stand-in the contract suite runs the same assertions against). `SyncService` (T7) is
 * the only caller; it never branches on `kind` beyond what the wire needs.
 *
 * Electron-free by construction — same rule as `packages/engine/src/sync/git-cli.ts`.
 */

import type { TreeChange } from '@wirebench/engine';
import { WirebenchError } from '@wirebench/engine';
import type { SyncConflictWire, SyncLogEntryWire, SyncStatusWire } from './types.js';

/** A workspace share's sync backend: probe/fetch/merge/commit/push plus conflict handling. */
export interface SyncBackend {
  readonly kind: 'folder' | 'git' | 'server';
  /** Current status without talking to the remote. Never throws for "not a repository", a
   * missing remote or an unborn branch — those are reported through `state`/`error`, not thrown. */
  probe(): Promise<SyncStatusWire>;
  /** Fetches from the remote (a no-op without one), then re-`probe`s. */
  fetch(): Promise<SyncStatusWire>;
  /** Merges the fetched remote state into the local branch. */
  merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }>;
  /** Commits everything currently changed in the tree, if anything is. */
  commit(message: string): Promise<{ committed: boolean }>;
  /** Pushes the local branch to the remote, then re-`probe`s.
   * @throws WirebenchError `sync-no-remote` when there is nothing to push to. */
  push(): Promise<SyncStatusWire>;
  /** The paths currently in conflict, each described by the entity it belongs to. */
  conflicts(): Promise<SyncConflictWire[]>;
  /** Resolves one conflicted path by keeping either side. */
  resolve(path: string, side: 'mine' | 'theirs'): Promise<void>;
  /**
   * Commits a merge whose conflicts have all been `resolve`d, returning the tree-relative paths
   * that merge commit brought into our side (`diff --name-only HEAD~1 HEAD`) — never edits left
   * uncommitted in the working tree while the conflict was open.
   */
  finishMerge(): Promise<{ changedPaths: string[] }>;
  /** Abandons an in-progress merge, restoring the pre-merge tree. */
  abortMerge(): Promise<void>;
  /** The `limit` most recent commits, newest first. */
  log(limit: number): Promise<SyncLogEntryWire[]>;
  /** Uncommitted changes in the tree right now — used to build a commit message before committing. */
  changedPaths(): Promise<TreeChange[]>;
  /** The identity commits will be attributed to, if one is configured. */
  identity(): Promise<{ name: string; email: string } | undefined>;
  /** Configures the identity commits are attributed to. */
  setIdentity(name: string, email: string): Promise<void>;
  /** Subscribes to remote-changed notifications (e.g. a filesystem watch on a synced folder); returns an unsubscribe. */
  subscribeRemote(onChange: () => void): () => void;
}

/**
 * A rejected promise for an operation a backend does not implement (e.g. `FolderBackend`).
 * Returns (never throws) so a non-`async` method can `return syncNotSupported('fetch')` and still
 * honour its `Promise<T>` return type — a synchronous throw there would reach the caller before
 * any `await`/`.catch` could see it, which is not how the rest of `SyncBackend` behaves.
 */
export function syncNotSupported<T>(operation: string): Promise<T> {
  return Promise.reject(
    new WirebenchError('sync-not-supported', `This workspace's share does not support ${operation}.`, {
      details: { operation },
    }),
  );
}

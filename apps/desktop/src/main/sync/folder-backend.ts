/**
 * The backend for a workspace synced to a plain folder (no version control): every save writes
 * straight into the folder, there is nothing to fetch/merge/push, and every operation beyond the
 * always-clean `probe()` (and the no-op `log`/`changedPaths`/`subscribeRemote`) is unsupported.
 *
 * It also stands in where no real backend can run yet (see `create-backend.ts`): a git share on a
 * machine without git (reported as `kind: 'git'` with `git-not-found`) and a server share until
 * spec 2 (reported as `kind: 'server'`). Only what `probe()` reports changes; `kind` stays
 * `'folder'` so `SyncService` never tries to commit, fetch or push through it.
 *
 * None of these methods need to be `async`: `syncNotSupported` already returns a rejected
 * promise, and the other three just wrap a plain value in `Promise.resolve`.
 */

import type { SyncBackend } from './backend.js';
import { syncNotSupported } from './backend.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncStatusWire } from './types.js';

/** How a stand-in `FolderBackend` presents itself in its status. */
export interface FolderBackendOptions {
  /** The share kind to report; `'folder'` by default. */
  readonly statusKind?: SyncStatusWire['kind'];
  /** Reported with `state: 'error'` — why this share cannot actually sync here. */
  readonly error?: { readonly code: string; readonly message: string };
}

export class FolderBackend implements SyncBackend {
  readonly kind = 'folder' as const;

  constructor(private readonly options: FolderBackendOptions = {}) {}

  probe(): Promise<SyncStatusWire> {
    const { statusKind, error } = this.options;
    return Promise.resolve({
      kind: statusKind ?? 'folder',
      gitAvailable: false,
      state: error === undefined ? 'clean' : 'error',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      ...(error !== undefined ? { error: { code: error.code, message: error.message } } : {}),
    });
  }

  fetch(): Promise<SyncStatusWire> {
    return syncNotSupported('fetch');
  }

  merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }> {
    return syncNotSupported('merge');
  }

  commit(): Promise<{ committed: boolean }> {
    return syncNotSupported('commit');
  }

  push(): Promise<SyncStatusWire> {
    return syncNotSupported('push');
  }

  conflicts(): Promise<SyncConflictWire[]> {
    return syncNotSupported('conflicts');
  }

  resolve(): Promise<void> {
    return syncNotSupported('resolve');
  }

  finishMerge(): Promise<void> {
    return syncNotSupported('finishMerge');
  }

  abortMerge(): Promise<void> {
    return syncNotSupported('abortMerge');
  }

  log(): Promise<SyncLogEntryWire[]> {
    return Promise.resolve([]);
  }

  changedPaths(): ReturnType<SyncBackend['changedPaths']> {
    return Promise.resolve([]);
  }

  identity(): Promise<{ name: string; email: string } | undefined> {
    return syncNotSupported('identity');
  }

  setIdentity(): Promise<void> {
    return syncNotSupported('setIdentity');
  }

  subscribeRemote(): () => void {
    return () => {};
  }
}

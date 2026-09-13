/**
 * The backend for a workspace synced to a plain folder (no version control): every save writes
 * straight into the folder, there is nothing to fetch/merge/push, and every operation beyond the
 * always-clean `probe()` (and the no-op `log`/`changedPaths`/`subscribeRemote`) is unsupported.
 *
 * None of these methods need to be `async`: `syncNotSupported` already returns a rejected
 * promise, and the other three just wrap a plain value in `Promise.resolve`.
 */

import type { SyncBackend } from './backend.js';
import { syncNotSupported } from './backend.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncStatusWire } from './types.js';

export class FolderBackend implements SyncBackend {
  readonly kind = 'folder' as const;

  probe(): Promise<SyncStatusWire> {
    return Promise.resolve({
      kind: 'folder',
      gitAvailable: false,
      state: 'clean',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
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

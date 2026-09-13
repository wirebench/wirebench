/**
 * Wire-shaped sync types, defined here for now (plain TypeScript, no zod) because `SyncBackend`
 * and its implementations need them before the IPC layer (T9) exists. T9 moves these three types
 * verbatim into `apps/desktop/src/shared/wire-types.ts` as zod schemas and re-exports them from
 * here — keep the field names and shapes exactly as below so that move stays mechanical.
 */

/** Where a workspace's sync currently stands relative to its remote (or synced folder). */
export type SyncState = 'clean' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'syncing' | 'offline' | 'error';

/** A backend's current status, as reported to the renderer's status-bar badge and Sync panel. */
export interface SyncStatusWire {
  readonly kind: 'local' | 'folder' | 'git' | 'server';
  readonly gitAvailable: boolean;
  readonly state: SyncState;
  readonly ahead: number;
  readonly behind: number;
  readonly uncommitted: number;
  readonly remote?: string;
  readonly branch?: string;
  readonly lastSyncAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

/** One unresolved conflict, as the conflict resolver lists it. `projectId` is filled in by main (T7). */
export interface SyncConflictWire {
  readonly path: string;
  readonly projectId?: string;
  readonly entity?: { readonly kind: string; readonly name: string };
}

/** One entry of a backend's commit history, newest first. */
export interface SyncLogEntryWire {
  readonly id: string;
  readonly subject: string;
  readonly author: string;
  readonly at: string;
}

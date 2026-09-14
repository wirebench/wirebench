/**
 * The renderer's mirror of the open workspace's sync status: one action per `sync.*` channel,
 * plus the five events the badge (Task 9), the Sync panel (Task 10) and the conflict resolver
 * (Task 11) all need.
 *
 * Every event carries a `workspaceId`; an event for a workspace that is no longer open is
 * ignored rather than applied — a reply in flight when the workspace changed must not paint
 * stale sync state over the new one.
 */

import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import type {
  GitIdentityNeededEvent,
  SyncConflictEvent,
  SyncConflictWire,
  SyncLogEntryWire,
  SyncSettingsPatchWire,
  SyncStatusChangedEvent,
  SyncStatusWire,
  WorkspaceChangedEvent,
  WorkspaceChangedOnDiskEvent,
} from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';
import { useWorkspaceStore } from './workspace.js';

/** What `sync.status` answers for a workspace that is not shared — never thrown for. */
const LOCAL_SYNC_STATUS: SyncStatusWire = {
  kind: 'local',
  gitAvailable: true,
  state: 'clean',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
};

/**
 * Failures every sync action treats as an expected outcome rather than something to toast:
 * `sync-no-remote` ("nothing to push to yet") and `sync-stopped` (the action raced a workspace
 * close/switch — by the time the reply arrived, this store has already moved on).
 */
const EXPECTED_SYNC_ERROR_CODES: ReadonlySet<string> = new Set(['sync-no-remote', 'sync-stopped']);

function toastUnlessExpected(error: IpcError): void {
  if (!EXPECTED_SYNC_ERROR_CODES.has(error.code)) {
    showToast(error.message);
  }
}

/** The sync store's serialisable state. */
export interface SyncSnapshot {
  readonly status: SyncStatusWire;
  readonly conflicts: readonly SyncConflictWire[];
  /** Set by `git.identityNeeded`; cleared by a successful {@link SyncStore.setIdentity}. */
  readonly identityNeeded: boolean;
}

/** The sync store: {@link SyncSnapshot} plus one action per `sync.*` channel. */
export interface SyncStore extends SyncSnapshot {
  /** Applies a `sync.statusChanged` event, ignoring one for a workspace that is no longer open. */
  readonly applyStatus: (workspaceId: string, status: SyncStatusWire) => void;
  /** Back to the defaults — the open workspace changed (or closed). */
  readonly reset: () => void;
  /** Re-reads the current status without starting an operation. */
  readonly refresh: () => Promise<void>;
  readonly fetch: () => Promise<void>;
  readonly pull: () => Promise<void>;
  readonly push: () => Promise<void>;
  readonly commit: (message?: string) => Promise<void>;
  readonly loadConflicts: () => Promise<readonly SyncConflictWire[]>;
  readonly resolve: (path: string, side: 'mine' | 'theirs') => Promise<void>;
  readonly abortMerge: () => Promise<void>;
  readonly log: (limit: number) => Promise<readonly SyncLogEntryWire[]>;
  readonly updateSettings: (patch: SyncSettingsPatchWire) => Promise<void>;
  readonly setIdentity: (name: string, email: string) => Promise<void>;
  readonly revealTree: (path?: string) => Promise<void>;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  status: LOCAL_SYNC_STATUS,
  conflicts: [],
  identityNeeded: false,

  applyStatus: (workspaceId, status) => {
    if (workspaceId === useWorkspaceStore.getState().workspace?.id) {
      set({ status });
    }
  },

  reset: () => {
    set({ status: LOCAL_SYNC_STATUS, conflicts: [], identityNeeded: false });
  },

  refresh: async () => {
    const result = await ipc().sync.status(undefined);
    if (result.ok) {
      set({ status: result.value });
    }
    // A failure here is not toasted: it usually just means no workspace is open yet.
  },

  fetch: async () => {
    const result = await ipc().sync.fetch(undefined);
    if (result.ok) {
      set({ status: result.value });
    } else {
      toastUnlessExpected(result.error);
    }
  },

  pull: async () => {
    const result = await ipc().sync.pull(undefined);
    if (result.ok) {
      set({ status: result.value });
    } else {
      toastUnlessExpected(result.error);
    }
  },

  push: async () => {
    const result = await ipc().sync.push(undefined);
    if (result.ok) {
      set({ status: result.value });
    } else {
      toastUnlessExpected(result.error);
    }
  },

  commit: async (message) => {
    const result = await ipc().sync.commit({ message });
    if (result.ok) {
      set({ status: result.value });
    } else {
      toastUnlessExpected(result.error);
    }
  },

  loadConflicts: async () => {
    const result = await ipc().sync.conflicts(undefined);
    if (result.ok) {
      set({ conflicts: result.value.conflicts });
      return result.value.conflicts;
    }
    toastUnlessExpected(result.error);
    return get().conflicts;
  },

  resolve: async (path, side) => {
    const result = await ipc().sync.resolve({ path, side });
    if (result.ok) {
      set({ status: result.value });
    } else {
      toastUnlessExpected(result.error);
    }
  },

  abortMerge: async () => {
    const result = await ipc().sync.abortMerge(undefined);
    if (result.ok) {
      set({ status: result.value });
    } else {
      toastUnlessExpected(result.error);
    }
  },

  log: async (limit) => {
    const result = await ipc().sync.log({ limit });
    if (result.ok) {
      return result.value.entries;
    }
    toastUnlessExpected(result.error);
    return [];
  },

  updateSettings: async (patch) => {
    const result = await ipc().sync.updateSettings(patch);
    if (result.ok) {
      set({ status: result.value });
    } else {
      toastUnlessExpected(result.error);
    }
  },

  setIdentity: async (name, email) => {
    const result = await ipc().sync.setIdentity({ name, email });
    if (result.ok) {
      set({ identityNeeded: false });
      await get().refresh();
    } else {
      toastUnlessExpected(result.error);
    }
  },

  revealTree: async (path) => {
    const result = await ipc().sync.revealTree({ path });
    if (!result.ok) {
      toastUnlessExpected(result.error);
    }
  },
}));

/**
 * Subscribes the mirror to the five sync-related events and resets it whenever the open
 * workspace changes (a switch, a close, or the initial open) — a status or conflict from the
 * workspace just left over must never linger under the new one. Called once from the shell,
 * next to `subscribeToWorkspace`; returns an unsubscribe for symmetry with React effects.
 */
export function subscribeToSync(): () => void {
  // `defineEvent` types every event's `name` as `string`, so the derived event map cannot
  // narrow a payload by channel; the cast mirrors `subscribeToWorkspace`'s.
  const offStatus = window.wirebench.on('sync.statusChanged', ((payload: SyncStatusChangedEvent) => {
    useSyncStore.getState().applyStatus(payload.workspaceId, payload.status);
  }) as (payload: unknown) => void);

  const offPulled = window.wirebench.on('sync.pulled', () => {
    // Nothing to mirror yet — Tasks 10/11 read this event directly for their own reloads/UI.
  });

  const offConflict = window.wirebench.on('sync.conflict', ((payload: SyncConflictEvent) => {
    if (payload.workspaceId === useWorkspaceStore.getState().workspace?.id) {
      useSyncStore.setState({ conflicts: payload.conflicts });
    }
  }) as (payload: unknown) => void);

  const offIdentityNeeded = window.wirebench.on('git.identityNeeded', ((payload: GitIdentityNeededEvent) => {
    if (payload.workspaceId === useWorkspaceStore.getState().workspace?.id) {
      useSyncStore.setState({ identityNeeded: true });
    }
  }) as (payload: unknown) => void);

  const offChangedOnDisk = window.wirebench.on('workspace.changedOnDisk', ((payload: WorkspaceChangedOnDiskEvent) => {
    if (payload.workspaceId === useWorkspaceStore.getState().workspace?.id) {
      showToast(`Workspace files changed on disk but could not be read: ${payload.message}`);
    }
  }) as (payload: unknown) => void);

  // Tracked here (not read off the workspace store) so a `workspace.changed` for the *same*
  // workspace — an environment edit, a rename, a pull-driven reload — never resets sync state
  // that has nothing to do with it, while a real switch (or a local workspace turning shared in
  // place) still does the right thing.
  let lastWorkspaceId: string | null = null;
  let lastShared = false;

  const offWorkspaceChanged = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    const nextId = payload.workspace?.id ?? null;
    const nextShared = payload.workspace?.share !== undefined;
    const switched = nextId !== lastWorkspaceId;
    // "or becomes null": closing the workspace always resets, even if this subscription never
    // saw the workspace that is now closing (a remount while one was already open).
    if (switched || nextId === null) {
      useSyncStore.getState().reset();
    }
    if (nextShared && (switched || !lastShared)) {
      void useSyncStore.getState().refresh();
    }
    lastWorkspaceId = nextId;
    lastShared = nextShared;
  }) as (payload: unknown) => void);

  // Best-effort initial load: a renderer mounted with a shared workspace already open (a page
  // reload, a window reopened from the dock) sees no `workspace.changed` of its own to react to.
  void useSyncStore.getState().refresh();

  return () => {
    offStatus();
    offPulled();
    offConflict();
    offIdentityNeeded();
    offChangedOnDisk();
    offWorkspaceChanged();
  };
}

import { create } from 'zustand';
import { showToast } from '../components/toast.js';
import type { SnapshotReadResponse } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/**
 * The golden response kept beside each saved request, cached per request id and read through
 * `ipc().snapshot.*`. Main owns the sidecar file; this store only mirrors what it last said, so
 * the Snapshot tab re-reads it whenever it is shown or a new response arrives (the project may
 * have been saved in between, turning `unsaved` into `none`).
 */
export interface SnapshotsStore {
  /** The last `snapshot.read` answer per request id; absent until the first read lands. */
  readonly entries: Readonly<Record<string, SnapshotReadResponse>>;
  readonly load: (requestId: string) => Promise<void>;
  /** Saves `body` as the golden (Save as snapshot, and Update snapshot once confirmed). */
  readonly save: (
    requestId: string,
    body: string,
    contentType: string | undefined,
    ignore: readonly string[],
  ) => Promise<void>;
  /** Replaces only the ignore rules; the body and `savedAt` stay as they are. */
  readonly setIgnore: (requestId: string, ignore: readonly string[]) => Promise<void>;
  readonly remove: (requestId: string) => Promise<void>;
}

export const useSnapshotsStore = create<SnapshotsStore>((set, get) => ({
  entries: {},

  load: async (requestId) => {
    const result = await ipc().snapshot.read({ requestId });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    set({ entries: { ...get().entries, [requestId]: result.value } });
  },

  save: async (requestId, body, contentType, ignore) => {
    const result = await ipc().snapshot.write({
      requestId,
      body,
      ...(contentType !== undefined ? { contentType } : {}),
      ignore: [...ignore],
    });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    const snapshot = {
      body,
      ignore: [...ignore],
      savedAt: result.value.savedAt,
      ...(contentType !== undefined ? { contentType } : {}),
    };
    set({ entries: { ...get().entries, [requestId]: { status: 'present', snapshot } } });
  },

  setIgnore: async (requestId, ignore) => {
    const result = await ipc().snapshot.setIgnore({ requestId, ignore: [...ignore] });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    const entry = get().entries[requestId];
    if (entry?.status === 'present') {
      set({
        entries: {
          ...get().entries,
          [requestId]: { status: 'present', snapshot: { ...entry.snapshot, ignore: [...ignore] } },
        },
      });
    }
  },

  remove: async (requestId) => {
    const result = await ipc().snapshot.remove({ requestId });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    set({ entries: { ...get().entries, [requestId]: { status: 'none' } } });
  },
}));

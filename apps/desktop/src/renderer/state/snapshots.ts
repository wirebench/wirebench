import { create } from 'zustand';
import { showToast } from '../components/toast.js';
import type { IpcResult } from '../../shared/ipc.js';
import type { SnapshotReadResponse } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/**
 * The golden response kept beside each saved request, cached per request id and read through
 * `ipc().snapshot.*`. Main owns the sidecar file; this store only mirrors what it last said, so
 * the Snapshot tab re-reads it whenever it is shown or a new response arrives (the project may
 * have been saved in between, turning `unsaved` into `none`).
 *
 * `ignore` holds the user's rule lines as typed (trimmed, blanks dropped, `#` comments kept);
 * comments are skipped only when diffing.
 */
export interface SnapshotsStore {
  /** The last known state per request id; absent until the first read lands. */
  readonly entries: Readonly<Record<string, SnapshotReadResponse>>;
  /** Request ids whose last read failed, so the tab can say so instead of "Loading…". */
  readonly failed: Readonly<Record<string, boolean>>;
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
  /** Appends `rule` to the latest saved rules unless it is already there, then saves. */
  readonly addIgnoreRule: (requestId: string, rule: string) => Promise<void>;
  readonly remove: (requestId: string) => Promise<void>;
}

/**
 * Bumped per request id by every read and every mutation. A read's answer is applied only while
 * its own number is still the latest, so a slow read can never restore state a later write
 * replaced.
 */
const generations = new Map<string, number>();

function bump(requestId: string): number {
  const next = (generations.get(requestId) ?? 0) + 1;
  generations.set(requestId, next);
  return next;
}

/** Runs one IPC call, turning a rejected promise into a failed result and toasting any failure. */
async function call<T>(run: () => Promise<IpcResult<T>>): Promise<T | undefined> {
  try {
    const result = await run();
    if (result.ok) {
      return result.value;
    }
    showToast(result.error.message);
  } catch (cause) {
    showToast(cause instanceof Error ? cause.message : String(cause));
  }
  return undefined;
}

export const useSnapshotsStore = create<SnapshotsStore>((set, get) => {
  function put(requestId: string, entry: SnapshotReadResponse): void {
    set({ entries: { ...get().entries, [requestId]: entry }, failed: { ...get().failed, [requestId]: false } });
  }

  return {
    entries: {},
    failed: {},

    load: async (requestId) => {
      const generation = bump(requestId);
      const value = await call(() => ipc().snapshot.read({ requestId }));
      if (generations.get(requestId) !== generation) {
        return;
      }
      if (value === undefined) {
        set({ failed: { ...get().failed, [requestId]: true } });
        return;
      }
      put(requestId, value);
    },

    save: async (requestId, body, contentType, ignore) => {
      bump(requestId);
      const value = await call(() =>
        ipc().snapshot.write({
          requestId,
          body,
          ...(contentType !== undefined ? { contentType } : {}),
          ignore: [...ignore],
        }),
      );
      if (value === undefined) {
        return;
      }
      put(requestId, {
        status: 'present',
        snapshot: {
          body,
          ignore: [...ignore],
          savedAt: value.savedAt,
          ...(contentType !== undefined ? { contentType } : {}),
        },
      });
    },

    setIgnore: async (requestId, ignore) => {
      bump(requestId);
      // Applied before the round trip so a following edit composes with this one.
      const before = get().entries[requestId];
      if (before?.status === 'present') {
        put(requestId, { status: 'present', snapshot: { ...before.snapshot, ignore: [...ignore] } });
      }
      const value = await call(() => ipc().snapshot.setIgnore({ requestId, ignore: [...ignore] }));
      if (value === undefined && before !== undefined) {
        put(requestId, before);
      }
    },

    addIgnoreRule: async (requestId, rule) => {
      const entry = get().entries[requestId];
      if (entry?.status !== 'present' || entry.snapshot.ignore.includes(rule)) {
        return;
      }
      await get().setIgnore(requestId, [...entry.snapshot.ignore, rule]);
    },

    remove: async (requestId) => {
      bump(requestId);
      const value = await call(() => ipc().snapshot.remove({ requestId }));
      if (value !== undefined) {
        put(requestId, { status: 'none' });
      }
    },
  };
});

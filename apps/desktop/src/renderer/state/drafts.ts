/**
 * Unsaved edits made in an editor tab.
 *
 * Every other edit goes straight to the main process, which holds it in the project model —
 * written on save, or on the debounce when `editor.autosave` is on. The editor surfaces are the
 * exception: what you type into a request does not leave the renderer until you save it, so a
 * tab can show an unsaved mark of its own and `Mod+S` has one item's worth of work to write.
 *
 * That distinction still matters with autosave off. Main's `dirty` flag is per *project*, which
 * is the granularity the title bar and the project tab report; this store is per *request*,
 * which is what a tab's mark needs.
 *
 * Only the *patch* lives here. The edited value itself is applied optimistically to the project
 * store as before, so every reader — the editor, the code panel, and the send path, which builds
 * its input from the renderer's own copy of the request — keeps seeing the edit without knowing
 * anything about drafts. This store answers one question: what has not been written yet.
 */
import { create } from 'zustand';
import type { RequestPatchWire } from '../../shared/wire-types.js';

interface DraftsState {
  /** Pending patch per request id. A request with no entry has nothing unsaved. */
  readonly requests: Readonly<Record<string, RequestPatchWire>>;
  /** Records an edit, merging it over whatever is already pending for that request. */
  readonly stageRequest: (requestId: string, patch: RequestPatchWire) => void;
  /** The pending patch, or `undefined` when the request is clean. Does not clear it. */
  readonly peekRequest: (requestId: string) => RequestPatchWire | undefined;
  /**
   * Clears the draft after a save, unless the user typed again while that save was in flight.
   * `committed` is what {@link peekRequest} returned when the save started; a mismatch means a
   * later keystroke is still unwritten and the request stays dirty.
   */
  readonly clearRequestIfUnchanged: (requestId: string, committed: RequestPatchWire | undefined) => void;
  /** Throws the draft away unsaved — closing a tab after the user chose to discard. */
  readonly discardRequest: (requestId: string) => void;
  readonly isRequestDirty: (requestId: string) => boolean;
  readonly dirtyRequestIds: () => readonly string[];
  /**
   * Forgets every draft. Called when a workspace is left: its drafts have already been handed to
   * main, which keeps them with that workspace, and they name requests the next one does not have.
   */
  readonly reset: () => void;
}

export const useDraftsStore = create<DraftsState>((set, get) => ({
  requests: {},

  stageRequest: (requestId, patch) => {
    set((state) => ({
      requests: { ...state.requests, [requestId]: { ...state.requests[requestId], ...patch } },
    }));
  },

  peekRequest: (requestId) => get().requests[requestId],

  clearRequestIfUnchanged: (requestId, committed) => {
    const pending = get().requests[requestId];
    // Compared by value, not by reference: `stageRequest` builds a fresh object every time, so
    // a reference check would never match and a saved draft would never clear.
    if (pending === undefined || JSON.stringify(pending) !== JSON.stringify(committed)) {
      return;
    }
    get().discardRequest(requestId);
  },

  discardRequest: (requestId) => {
    set((state) => {
      if (!(requestId in state.requests)) {
        return state;
      }
      const requests = { ...state.requests };
      delete requests[requestId];
      return { requests };
    });
  },

  isRequestDirty: (requestId) => get().requests[requestId] !== undefined,

  dirtyRequestIds: () => Object.keys(get().requests),

  reset: () => {
    set({ requests: {} });
  },
}));

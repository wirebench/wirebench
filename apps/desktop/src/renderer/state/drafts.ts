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
import type {
  GrpcRequestPatchWire,
  RequestPatchWire,
  RestRequestPatchWire,
  WsRequestPatchWire,
} from '../../shared/wire-types.js';

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
   * Pending patch per REST request id. Kept apart from {@link requests} because the two patch
   * shapes have nothing in common: one carries an envelope, the other a URL and a body.
   */
  readonly restRequests: Readonly<Record<string, RestRequestPatchWire>>;
  /** Records a REST edit, merging it over whatever is already pending for that request. */
  readonly stageRestRequest: (requestId: string, patch: RestRequestPatchWire) => void;
  readonly peekRestRequest: (requestId: string) => RestRequestPatchWire | undefined;
  readonly clearRestRequestIfUnchanged: (requestId: string, committed: RestRequestPatchWire | undefined) => void;
  readonly discardRestRequest: (requestId: string) => void;
  readonly isRestRequestDirty: (requestId: string) => boolean;
  readonly dirtyRestRequestIds: () => readonly string[];
  /** Pending patch per gRPC request id, the third kind of draft, kept apart for the same reason. */
  readonly grpcRequests: Readonly<Record<string, GrpcRequestPatchWire>>;
  readonly stageGrpcRequest: (requestId: string, patch: GrpcRequestPatchWire) => void;
  readonly peekGrpcRequest: (requestId: string) => GrpcRequestPatchWire | undefined;
  readonly clearGrpcRequestIfUnchanged: (requestId: string, committed: GrpcRequestPatchWire | undefined) => void;
  readonly discardGrpcRequest: (requestId: string) => void;
  readonly isGrpcRequestDirty: (requestId: string) => boolean;
  readonly dirtyGrpcRequestIds: () => readonly string[];
  /** Pending patch per WebSocket request id, the fourth kind of draft, kept apart for the same reason. */
  readonly wsRequests: Readonly<Record<string, WsRequestPatchWire>>;
  readonly stageWsRequest: (requestId: string, patch: WsRequestPatchWire) => void;
  readonly peekWsRequest: (requestId: string) => WsRequestPatchWire | undefined;
  readonly clearWsRequestIfUnchanged: (requestId: string, committed: WsRequestPatchWire | undefined) => void;
  readonly discardWsRequest: (requestId: string) => void;
  readonly isWsRequestDirty: (requestId: string) => boolean;
  readonly dirtyWsRequestIds: () => readonly string[];
  /**
   * Forgets every draft. Called when a workspace is left: its drafts have already been handed to
   * main, which keeps them with that workspace, and they name requests the next one does not have.
   */
  readonly reset: () => void;
}

export const useDraftsStore = create<DraftsState>((set, get) => ({
  requests: {},
  restRequests: {},
  grpcRequests: {},
  wsRequests: {},

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

  stageRestRequest: (requestId, patch) => {
    set((state) => ({
      restRequests: { ...state.restRequests, [requestId]: { ...state.restRequests[requestId], ...patch } },
    }));
  },

  peekRestRequest: (requestId) => get().restRequests[requestId],

  clearRestRequestIfUnchanged: (requestId, committed) => {
    const pending = get().restRequests[requestId];
    // By value, for the same reason as the SOAP side: `stageRestRequest` builds a fresh object
    // every time, so a reference check would never match and a saved draft would never clear.
    if (pending === undefined || JSON.stringify(pending) !== JSON.stringify(committed)) {
      return;
    }
    get().discardRestRequest(requestId);
  },

  discardRestRequest: (requestId) => {
    set((state) => {
      if (!(requestId in state.restRequests)) {
        return state;
      }
      const restRequests = { ...state.restRequests };
      delete restRequests[requestId];
      return { restRequests };
    });
  },

  isRestRequestDirty: (requestId) => get().restRequests[requestId] !== undefined,

  dirtyRestRequestIds: () => Object.keys(get().restRequests),

  stageGrpcRequest: (requestId, patch) => {
    set((state) => ({
      grpcRequests: { ...state.grpcRequests, [requestId]: { ...state.grpcRequests[requestId], ...patch } },
    }));
  },

  peekGrpcRequest: (requestId) => get().grpcRequests[requestId],

  clearGrpcRequestIfUnchanged: (requestId, committed) => {
    const pending = get().grpcRequests[requestId];
    if (pending === undefined || JSON.stringify(pending) !== JSON.stringify(committed)) {
      return;
    }
    get().discardGrpcRequest(requestId);
  },

  discardGrpcRequest: (requestId) => {
    set((state) => {
      if (!(requestId in state.grpcRequests)) {
        return state;
      }
      const grpcRequests = { ...state.grpcRequests };
      delete grpcRequests[requestId];
      return { grpcRequests };
    });
  },

  isGrpcRequestDirty: (requestId) => get().grpcRequests[requestId] !== undefined,

  dirtyGrpcRequestIds: () => Object.keys(get().grpcRequests),

  stageWsRequest: (requestId, patch) => {
    set((state) => ({
      wsRequests: { ...state.wsRequests, [requestId]: { ...state.wsRequests[requestId], ...patch } },
    }));
  },

  peekWsRequest: (requestId) => get().wsRequests[requestId],

  clearWsRequestIfUnchanged: (requestId, committed) => {
    const pending = get().wsRequests[requestId];
    if (pending === undefined || JSON.stringify(pending) !== JSON.stringify(committed)) {
      return;
    }
    get().discardWsRequest(requestId);
  },

  discardWsRequest: (requestId) => {
    set((state) => {
      if (!(requestId in state.wsRequests)) {
        return state;
      }
      const wsRequests = { ...state.wsRequests };
      delete wsRequests[requestId];
      return { wsRequests };
    });
  },

  isWsRequestDirty: (requestId) => get().wsRequests[requestId] !== undefined,

  dirtyWsRequestIds: () => Object.keys(get().wsRequests),

  reset: () => {
    set({ requests: {}, restRequests: {}, grpcRequests: {}, wsRequests: {} });
  },
}));

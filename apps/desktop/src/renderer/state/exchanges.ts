import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import { showToast } from '../components/toast.js';
import { runValidation } from '../features/request-editor/validate-actions.js';
import { recordContractProblems } from '../features/rest-editor/response/contract.js';
import type { AnyExchangeSummary } from '../features/request-editor/response-status.js';
import type {
  ExchangeFailedEvent,
  ExchangeLoggedEvent,
  ExchangeSummary,
  FailedExchangeWire,
  GrpcExchangeSummary,
  GrpcLiveEvent,
  GrpcResponseMessageWire,
  RestExchangeSummary,
  RestLiveEvent,
  SseRowWire,
  UnresolvedRefWire,
  WsExchangeSummary,
  WsFrameWire,
  WsHandshakeWire,
  WsLiveEvent,
} from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';
import { usePreferencesStore } from './preferences.js';
import type { Problem } from './problems.js';
import { useProblemsStore } from './problems.js';
import { selectRequestEndpointUrl } from './project-endpoint.js';
import { useWorkspaceStore } from './workspace.js';
import { useProjectStore } from './project.js';
import { useDraftsStore } from './drafts.js';

/** Newest-last log of every completed exchange, capped so it can't grow unbounded over a session. */
/** The row limit before preferences load; `ui.logSize` replaces it (Preferences › Behaviour). */
const DEFAULT_LOG_CAP = 500;

/** Drops the oldest rows past the store's current row limit. */
function trimLog(draft: { log: LogEntry[]; logCap: number }): void {
  if (draft.log.length > draft.logCap) {
    draft.log.splice(0, draft.log.length - draft.logCap);
  }
}

/**
 * One row of the HTTP Log: a finished exchange of either protocol, or a send that never produced
 * a response. The two are kept as separate shapes so the response pane, the inspectors, the status
 * bar and History keep consuming `ExchangeSummary` / `RestExchangeSummary` exactly as before.
 */
export type LogEntry =
  | {
      readonly kind: 'exchange';
      readonly exchange: AnyExchangeSummary;
      /** The saved request the send came from — what the row menu resends and opens. */
      readonly requestId?: string;
    }
  | { readonly kind: 'failure'; readonly failure: FailedExchangeWire };

/** The HTTP status classes the filter bar offers, plus `failed` for a send that produced none. */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'failed';

/** What narrows the HTTP Log; every list empty means "all". Lives here so it survives switching console tabs. */
export interface LogFilter {
  /** Searched in the URL, header lines, bodies and request name. */
  readonly text: string;
  /** `text` is a regular expression. */
  readonly regex: boolean;
  /** `text` matches case-sensitively. */
  readonly matchCase: boolean;
  /** Upper-case method names. */
  readonly methods: readonly string[];
  readonly statuses: readonly StatusClass[];
  readonly protocols: readonly ('soap' | 'rest' | 'grpc' | 'websocket')[];
}

/** The filter that shows every row. */
export const EMPTY_FILTER: LogFilter = {
  text: '',
  regex: false,
  matchCase: false,
  methods: [],
  statuses: [],
  protocols: [],
};

/** The HTTP Log columns a header click sorts by. */
export type SortColumn = 'time' | 'name' | 'status' | 'duration' | 'size';

export interface LogSort {
  readonly column: SortColumn;
  readonly direction: 'asc' | 'desc';
}

/** The send id either kind of entry carries. */
export function sendIdOf(entry: LogEntry): string {
  return entry.kind === 'exchange' ? entry.exchange.sendId : entry.failure.sendId;
}

/** The newest finished exchange in the log, skipping failures — what the status bar's "last:" reads. */
export function lastExchangeOf(log: readonly LogEntry[]): AnyExchangeSummary | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (entry !== undefined && entry.kind === 'exchange') {
      return entry.exchange;
    }
  }
  return undefined;
}

/** The send lifecycle for one request draft. */
export type ExchangeStatus = 'idle' | 'sending' | 'done' | 'error';

/** What is known about the most recent send for one request draft. */
export interface ExchangeState {
  readonly status: ExchangeStatus;
  readonly sendId?: string;
  readonly exchange?: ExchangeSummary;
  readonly error?: IpcError;
  readonly startedAt?: string;
}

/**
 * What a REST send with a `text/event-stream` response has produced so far.
 *
 * Mirrors {@link WsLiveState}: the pane shows this while `status` is `sending` and the finished
 * `exchange` (its `stream`) replaces it once the send resolves, so a row is never shown twice.
 */
export interface RestLiveState {
  /** The response's status, once its headers have arrived — before any row. */
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Rows in arrival order. */
  readonly rows: readonly SseRowWire[];
  /** How many of the oldest rows were let go to keep {@link WS_LIVE_FRAME_LIMIT}; absent when none. */
  readonly droppedRows?: number;
  /**
   * Running totals kept as rows arrive, the same reason {@link WsLiveState.counts} is: they must
   * neither fall back when old rows are let go nor re-count thousands of rows every tick.
   */
  readonly counts: {
    readonly events: number;
    readonly comments: number;
    readonly retries: number;
    readonly bytes: number;
  };
}

/** What is known about the most recent send for one REST request. */
export interface RestExchangeState {
  readonly status: ExchangeStatus;
  readonly sendId?: string;
  readonly exchange?: RestExchangeSummary;
  readonly error?: IpcError;
  readonly startedAt?: string;
  /** Present while an event-stream response is still arriving; dropped when the exchange arrives. */
  readonly live?: RestLiveState;
}

/**
 * What a gRPC call that is still running has produced so far.
 *
 * A server stream can run for minutes, so the pane shows this while `status` is `sending` and the
 * finished `exchange` replaces it at the end. The two never disagree: main sends the same decoded
 * messages either way, these one at a time.
 */
export interface GrpcLiveState {
  /** Response messages in arrival order. */
  readonly messages: readonly GrpcResponseMessageWire[];
  /** The server's initial metadata, once its headers have arrived. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Messages pushed by hand on an interactive call, canonical JSON text each. */
  readonly sent: readonly string[];
  /** True while the request side is open for pushing — an interactive call that has not half-closed. */
  readonly open: boolean;
}

/** What is known about the most recent call of one gRPC request. */
export interface GrpcExchangeState {
  readonly status: ExchangeStatus;
  readonly sendId?: string;
  readonly exchange?: GrpcExchangeSummary;
  readonly error?: IpcError;
  readonly startedAt?: string;
  /** Present while the call runs; dropped when the exchange arrives. */
  readonly live?: GrpcLiveState;
}

/**
 * What a WebSocket session that is still open has produced so far.
 *
 * A session can run for the life of the tab, so the pane shows this while `status` is `open` (or
 * `connecting`/`closing`) and the finished `exchange` replaces it once the session closes. Mirrors
 * {@link GrpcLiveState}: the handshake and the frames one at a time, the finished exchange carrying
 * the same information whole.
 */
export interface WsLiveState {
  /** The handshake that opened the session, once it has settled. */
  readonly handshake?: WsHandshakeWire;
  /** Frames sent or received, in arrival order. */
  readonly frames: readonly WsFrameWire[];
  /** True while the session is open. */
  readonly open: boolean;
  /** How many of the oldest frames were let go to keep {@link WS_LIVE_FRAME_LIMIT}; absent when none. */
  readonly droppedFrames?: number;
  /**
   * Running totals of the session's messages (text and binary frames — the engine's rule; control
   * frames are not counted) and their payload bytes, kept as frames arrive so the status line
   * neither falls back when old frames are let go nor re-counts thousands of frames every tick.
   */
  readonly counts?: WsLiveCounts;
}

/** The status line's running totals for a live session. */
export interface WsLiveCounts {
  readonly sent: number;
  readonly received: number;
  readonly bytes: number;
}

/**
 * The most frames a session's live half keeps in renderer memory. A session can run for hours; the
 * timeline already paints only a window of rows past a thousand, and this bounds what that window
 * is cut from, dropping the oldest first — the newest frames are the ones a person is watching.
 */
export const WS_LIVE_FRAME_LIMIT = 5000;

/**
 * Appends a frame to a live half, letting the oldest go past {@link WS_LIVE_FRAME_LIMIT}.
 *
 * A frame whose `index` is already at the tail is ignored. `events.ws.live` is the single source
 * of frames — a sent frame arrives through it, not from `request.wsSend`'s reply — and this keeps
 * that so: were a second source ever to hand the same frame over again it would be dropped here
 * rather than doubling the row, the counts and the bytes.
 */
function pushLiveFrame(live: Draft<WsLiveState>, frame: WsFrameWire): void {
  if (live.frames.at(-1)?.index === frame.index) {
    return;
  }
  live.frames.push(frame);
  if (frame.opcode === 'text' || frame.opcode === 'binary') {
    const counts = live.counts ?? { sent: 0, received: 0, bytes: 0 };
    live.counts = {
      sent: counts.sent + (frame.direction === 'sent' ? 1 : 0),
      received: counts.received + (frame.direction === 'received' ? 1 : 0),
      bytes: counts.bytes + frame.size,
    };
  }
  const excess = live.frames.length - WS_LIVE_FRAME_LIMIT;
  if (excess > 0) {
    live.frames.splice(0, excess);
    live.droppedFrames = (live.droppedFrames ?? 0) + excess;
  }
}

/**
 * Appends a row to a REST stream's live half, letting the oldest go past {@link WS_LIVE_FRAME_LIMIT}.
 *
 * Mirrors {@link pushLiveFrame}: a row whose `index` is already at the tail is ignored, and the
 * running counts rise with every row seen even once the cap starts dropping the oldest.
 */
function pushLiveRow(live: Draft<RestLiveState>, row: SseRowWire): void {
  if (live.rows.at(-1)?.index === row.index) {
    return;
  }
  live.rows.push(row);
  live.counts = {
    events: live.counts.events + (row.kind === 'event' ? 1 : 0),
    comments: live.counts.comments + (row.kind === 'comment' ? 1 : 0),
    retries: live.counts.retries + (row.kind === 'retry' ? 1 : 0),
    bytes: live.counts.bytes + row.size,
  };
  const excess = live.rows.length - WS_LIVE_FRAME_LIMIT;
  if (excess > 0) {
    live.rows.splice(0, excess);
    live.droppedRows = (live.droppedRows ?? 0) + excess;
  }
}

/** What is known about the most recent session of one WebSocket request. */
export interface WsExchangeState {
  readonly status: 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';
  readonly sendId?: string;
  /** Present while the session runs; dropped when the exchange arrives. */
  readonly live?: WsLiveState;
  readonly exchange?: WsExchangeSummary;
  readonly error?: IpcError;
}

/** The exchanges store's serialisable state. */
export interface ExchangesSnapshot {
  readonly byRequest: Record<string, ExchangeState>;
  /**
   * The REST half, keyed by REST request id. Kept apart from {@link byRequest} because the two
   * exchange shapes differ (a REST response has cookies, redirects and a detected language), and a
   * pane reading the wrong one would have to narrow on every field.
   */
  readonly restByRequest: Record<string, RestExchangeState>;
  /** The gRPC third, keyed by gRPC request id, apart for the same reason. */
  readonly grpcByRequest: Record<string, GrpcExchangeState>;
  /** The WebSocket fourth, keyed by WebSocket request id, apart for the same reason. */
  readonly wsByRequest: Record<string, WsExchangeState>;
  /**
   * Newest-last log of every send this session, SOAP and REST alike, finished or failed: the
   * console's HTTP Log is a protocol-neutral surface, and a send that never produced a response
   * belongs in it as much as one that did.
   */
  readonly log: readonly LogEntry[];
  /** The HTTP Log's filter. Not persisted; dropped with the log on `reset`. */
  readonly filter: LogFilter;
  /** The HTTP Log's column sort; undefined is log order. Reset with the filter. */
  readonly sort: LogSort | undefined;
  /** How many rows the log keeps; follows `ui.logSize`. */
  readonly logCap: number;
  /**
   * Session-only: when on, `reset` keeps the log, filter and sort. In memory only — never
   * saved, and off again at every launch.
   */
  readonly preserveLog: boolean;
}

/** The exchanges store: {@link ExchangesSnapshot} plus the actions that drive a send. */
export interface ExchangesStore extends ExchangesSnapshot {
  /**
   * Sends one request. With `editor.autoValidateOnSend` on, the envelope is validated first and
   * a send with validation errors is blocked (the toast offers "Send anyway"); the response is
   * validated once it arrives. `force` skips that gate — it is what "Send anyway" calls.
   */
  readonly send: (requestId: string, force?: boolean) => Promise<void>;
  readonly cancel: (requestId: string) => Promise<void>;
  /** Clears the exchange state for a removed request (keeps the log). */
  readonly clearRequest: (requestId: string) => void;
  /**
   * Drops every response and the whole HTTP log. Called when the workspace closes: both are
   * keyed by requests of projects that are no longer open. With `preserveLog` on, the log,
   * filter and sort stay.
   */
  readonly reset: () => void;
  /** Empties the HTTP log. Per-request state is left alone — the panes keep their responses. */
  readonly clearLog: () => void;
  /** Sets the row limit; lowering it drops the oldest rows at once, raising it keeps every row. */
  readonly setLogCap: (cap: number) => void;
  /** Turns Preserve log on or off. */
  readonly setPreserveLog: (on: boolean) => void;
  /**
   * Appends a finished exchange's row — a resend from the HTTP Log's row menu. A `sendId` already in
   * the log (either kind) is ignored.
   */
  readonly appendExchange: (exchange: AnyExchangeSummary, requestId?: string) => void;
  /** Appends a failed send's row. A `sendId` already in the log (either kind) is ignored. */
  readonly appendFailure: (failure: FailedExchangeWire) => void;
  /** Appends a row main already built (`exchange.logged`) — currently a WebSocket handshake. */
  readonly appendLoggedEntry: (entry: LogEntry) => void;
  /** Merges a patch into the HTTP Log filter. */
  readonly setFilter: (patch: Partial<LogFilter>) => void;
  /** Shows every row again. Distinct from `clearLog`, which empties the log. */
  readonly resetFilter: () => void;
  /** Cycles off → asc → desc → off; a different column starts again at asc. */
  readonly cycleSort: (column: SortColumn) => void;
  /**
   * Re-reads one exchange from main (`exchanges.get`), which re-redacts it against the
   * show-secrets flag as it stands now, and swaps the fresher copy into the log and the
   * request's pane. A no-op when main has evicted the exchange.
   */
  readonly refreshExchange: (sendId: string) => Promise<void>;
  /**
   * Sends one REST request. The renderer names the request and hands over its unsaved draft; main
   * resolves the base URL, the properties and the credentials, so nothing about where the request
   * goes is decided here.
   */
  readonly sendRest: (requestId: string) => Promise<void>;
  /** Cancels the REST send in flight for `requestId`, if any. */
  readonly cancelRest: (requestId: string) => Promise<void>;
  /** Clears the REST exchange state for a removed request. */
  readonly clearRestRequest: (requestId: string) => void;
  /** Folds one `rest.live` event into the send whose event-stream response it belongs to. */
  readonly applyRestLive: (event: RestLiveEvent) => void;
  /**
   * Cancels every REST send still in flight (`sending`), or only those of `requestIds`. The REST
   * counterpart of {@link closeOpenWsSessions}: an event stream holds its socket until stopped, so
   * leaving a workspace or removing a project must not leave one running behind it.
   *
   * The sends are read synchronously, so a caller may reset the store straight after.
   */
  readonly cancelOpenRestSends: (requestIds?: readonly string[]) => Promise<void>;
  /**
   * Makes one gRPC call, the request and its unsaved draft named; main resolves everything else.
   * `interactive` keeps the request side open afterwards, for {@link pushGrpcMessage} and
   * {@link halfCloseGrpc}; without it the call is written and half-closed at once, as before.
   */
  readonly sendGrpc: (requestId: string, options?: { readonly interactive?: boolean }) => Promise<void>;
  readonly cancelGrpc: (requestId: string) => Promise<void>;
  readonly clearGrpcRequest: (requestId: string) => void;
  /** Writes one more message on the open interactive call for `requestId`. */
  readonly pushGrpcMessage: (requestId: string, messageText: string) => Promise<void>;
  /** Half-closes that call's request side; the server may still be answering. */
  readonly halfCloseGrpc: (requestId: string) => Promise<void>;
  /** Folds one `grpc.live` event into the request whose call it belongs to. */
  readonly applyGrpcLive: (event: GrpcLiveEvent) => void;
  /**
   * Opens one WebSocket session, the request and its unsaved draft named; main resolves the URL,
   * the headers, the subprotocols and the credentials. A no-op while `status` is `connecting`,
   * `open` or `closing` — a request already has a session on the wire (spec assumption 8).
   */
  readonly connectWs: (requestId: string) => Promise<void>;
  /**
   * Sends one message on the open session for `requestId`. A no-op while the session is not open.
   *
   * The frame it produced reaches the timeline through `events.ws.live`, not from here.
   */
  readonly sendWsMessage: (
    requestId: string,
    message: { readonly format: 'text' | 'binary'; readonly content: string; readonly expand: boolean },
  ) => Promise<void>;
  /** Aborts a handshake still in progress for `requestId` (Escape, or Cancel on the strip). */
  readonly cancelWs: (requestId: string) => Promise<void>;
  /** Closes the open session for `requestId`, if any. */
  readonly disconnectWs: (requestId: string, code?: number, reason?: string) => Promise<void>;
  /**
   * Closes every session still on the wire (`connecting`, `open` or `closing`), or only those of
   * `requestIds`. For the lifecycle moments that drop this state wholesale — leaving or closing a
   * workspace, removing a project — so a session cannot outlive the request it belongs to.
   *
   * The sessions to close are read synchronously, so a caller may reset the store straight after
   * without waiting for the returned promise.
   */
  readonly closeOpenWsSessions: (requestIds?: readonly string[]) => Promise<void>;
  /** Clears the WebSocket exchange state for a removed request. */
  readonly clearWsRequest: (requestId: string) => void;
  /** Folds one `ws.live` event into the request whose session it belongs to. */
  readonly applyWsLive: (event: WsLiveEvent) => void;
}

type Mutate = (draft: Draft<ExchangesSnapshot>) => void;

/** Names the place an unresolved reference sits, for the Problems entry's message. */
function whereOf(ref: UnresolvedRefWire): string {
  if (ref.field === undefined) {
    return '';
  }
  return ref.field === 'header' && ref.headerName !== undefined ? ` in header "${ref.headerName}"` : ` in ${ref.field}`;
}

/** Turns the preflight's (or the exchange's) unresolved references into Problems entries. */
function expansionProblems(requestId: string, refs: readonly UnresolvedRefWire[]): Problem[] {
  return refs.map((ref) => ({
    groupId: `expansion:${requestId}`,
    source: 'expansion' as const,
    severity: 'warning' as const,
    requestId,
    problem: { code: `expansion-${ref.code}`, message: `Unresolved property ${ref.expr}${whereOf(ref)}` },
  }));
}

export const useExchangesStore = create<ExchangesStore>((set, get) => {
  const update = (recipe: Mutate): void => {
    set((state) => produce(state, recipe));
  };

  return {
    byRequest: {},
    restByRequest: {},
    grpcByRequest: {},
    wsByRequest: {},
    log: [],
    filter: EMPTY_FILTER,
    sort: undefined,
    logCap: DEFAULT_LOG_CAP,
    preserveLog: false,

    reset: () => {
      const { preserveLog, log, filter, sort } = get();
      set({
        byRequest: {},
        restByRequest: {},
        grpcByRequest: {},
        wsByRequest: {},
        log: preserveLog ? log : [],
        filter: preserveLog ? filter : EMPTY_FILTER,
        sort: preserveLog ? sort : undefined,
      });
    },

    sendGrpc: async (requestId, options) => {
      const request = useProjectStore.getState().grpcRequests[requestId];
      if (request === undefined) {
        update((draft) => {
          draft.grpcByRequest[requestId] = {
            status: 'error',
            error: { code: 'unknown-request', message: `No gRPC request with id "${requestId}"` },
          };
        });
        return;
      }
      useProblemsStore.getState().clearSource('expansion', requestId);
      useProblemsStore.getState().clearSource('send', requestId);

      const sendId = crypto.randomUUID();
      const interactive = options?.interactive === true;
      update((draft) => {
        draft.grpcByRequest[requestId] = {
          status: 'sending',
          sendId,
          startedAt: new Date().toISOString(),
          live: { messages: [], sent: [], open: false },
        };
      });

      const draftPatch = useDraftsStore.getState().peekGrpcRequest(requestId);
      const result = await ipc().request.sendGrpc({
        sendId,
        requestId,
        ...(draftPatch !== undefined ? { draft: draftPatch } : {}),
        ...(interactive ? { interactive: true } : {}),
      });

      if (get().grpcByRequest[requestId]?.sendId !== sendId) {
        return;
      }
      if (!result.ok) {
        update((draft) => {
          draft.grpcByRequest[requestId] = { status: 'error', sendId, error: result.error };
        });
        useProblemsStore.getState().add([
          {
            groupId: `send:${requestId}`,
            source: 'send',
            severity: 'error',
            requestId,
            problem: { code: result.error.code, message: `${result.error.code}: ${result.error.message}` },
          },
        ]);
        return;
      }
      const unresolved = result.value.unresolved ?? [];
      if (unresolved.length > 0) {
        useProblemsStore.getState().add(expansionProblems(requestId, unresolved));
      }
      update((draft) => {
        // `live` goes: the exchange holds every message it held, and holding both would let the
        // pane show a message twice.
        draft.grpcByRequest[requestId] = { status: 'done', sendId, exchange: result.value };
        draft.log.push({ kind: 'exchange', exchange: result.value, requestId });
        trimLog(draft);
      });
    },

    cancelGrpc: async (requestId) => {
      const entry = get().grpcByRequest[requestId];
      if (entry?.sendId === undefined) {
        return;
      }
      await ipc().request.cancel({ sendId: entry.sendId });
    },

    clearGrpcRequest: (requestId) => {
      update((draft) => {
        delete draft.grpcByRequest[requestId];
      });
    },

    pushGrpcMessage: async (requestId, messageText) => {
      const entry = get().grpcByRequest[requestId];
      if (entry?.sendId === undefined || entry.live?.open !== true) {
        return;
      }
      const sendId = entry.sendId;
      const result = await ipc().request.grpcPush({ sendId, messageText });
      if (!result.ok) {
        showToast(result.error.message);
        return;
      }
      update((draft) => {
        const live = draft.grpcByRequest[requestId];
        // The same guard the awaited send has: a reply for a call this request has moved on from
        // belongs to nothing.
        if (live?.sendId !== sendId || live.live === undefined) {
          return;
        }
        live.live.sent.push(result.value.json);
      });
    },

    halfCloseGrpc: async (requestId) => {
      const entry = get().grpcByRequest[requestId];
      if (entry?.sendId === undefined || entry.live?.open !== true) {
        return;
      }
      await ipc().request.grpcHalfClose({ sendId: entry.sendId });
    },

    applyGrpcLive: (event) => {
      update((draft) => {
        const found = Object.entries(draft.grpcByRequest).find(([, state]) => state.sendId === event.sendId);
        if (found === undefined) {
          return;
        }
        const [, state] = found;
        // An event for a send this request has already replaced, or one that has finished, is
        // dropped rather than written over the newer state.
        if (state.status !== 'sending' || state.live === undefined) {
          return;
        }
        switch (event.kind) {
          case 'open':
            state.live.open = true;
            return;
          case 'headers':
            state.live.headers = event.headers;
            return;
          case 'message':
            state.live.messages.push(event.message);
            return;
          case 'closed':
            state.live.open = false;
            return;
        }
      });
    },

    connectWs: async (requestId) => {
      const current = get().wsByRequest[requestId];
      // `closing` counts too: the session is still on the wire until main answers, and a second
      // connect started now would run two sessions against the one request.
      if (current?.status === 'connecting' || current?.status === 'open' || current?.status === 'closing') {
        return;
      }
      const request = useProjectStore.getState().wsRequests[requestId];
      if (request === undefined) {
        update((draft) => {
          draft.wsByRequest[requestId] = {
            status: 'error',
            error: { code: 'unknown-request', message: `No WebSocket request with id "${requestId}"` },
          };
        });
        return;
      }
      useProblemsStore.getState().clearSource('expansion', requestId);
      useProblemsStore.getState().clearSource('send', requestId);

      const sendId = crypto.randomUUID();
      update((draft) => {
        draft.wsByRequest[requestId] = { status: 'connecting', sendId, live: { frames: [], open: false } };
      });

      const draftPatch = useDraftsStore.getState().peekWsRequest(requestId);
      const result = await ipc().request.openWs({
        sendId,
        requestId,
        ...(draftPatch !== undefined ? { draft: draftPatch } : {}),
      });

      // A disconnect, or a newer connect, may already have moved this request on; only settle
      // this session if it is still the one running.
      if (get().wsByRequest[requestId]?.sendId !== sendId) {
        return;
      }
      if (!result.ok) {
        update((draft) => {
          draft.wsByRequest[requestId] = { status: 'error', sendId, error: result.error };
        });
        useProblemsStore.getState().add([
          {
            groupId: `send:${requestId}`,
            source: 'send',
            severity: 'error',
            requestId,
            problem: { code: result.error.code, message: `${result.error.code}: ${result.error.message}` },
          },
        ]);
        return;
      }
      // `live` goes: the exchange holds the handshake and every frame it held, and holding both
      // would let the pane show a frame twice.
      //
      // Unlike REST/gRPC, nothing is pushed onto `log` here: the HTTP Log's WebSocket row is the
      // handshake alone (`WsHandshakeExchangeSummary`), written the moment the handshake settles
      // rather than when the session closes — a separate wire path this task's brief did not
      // cover (no renderer channel carries it yet). See the task report.
      update((draft) => {
        draft.wsByRequest[requestId] = { status: 'closed', sendId, exchange: result.value };
      });
    },

    sendWsMessage: async (requestId, message) => {
      const entry = get().wsByRequest[requestId];
      if (entry?.sendId === undefined || entry.status !== 'open') {
        update((draft) => {
          const state = draft.wsByRequest[requestId];
          draft.wsByRequest[requestId] = {
            status: state?.status ?? 'idle',
            ...(state?.sendId !== undefined ? { sendId: state.sendId } : {}),
            ...(state?.live !== undefined ? { live: state.live } : {}),
            ...(state?.exchange !== undefined ? { exchange: state.exchange } : {}),
            error: { code: 'ws-not-open', message: 'The WebSocket session is not open.' },
          };
        });
        return;
      }
      const sendId = entry.sendId;
      const result = await ipc().request.wsSend({
        sendId,
        requestId,
        format: message.format,
        content: message.content,
        expand: message.expand,
      });
      if (!result.ok) {
        update((draft) => {
          const state = draft.wsByRequest[requestId];
          if (state?.sendId !== sendId) {
            return;
          }
          draft.wsByRequest[requestId] = { ...state, error: result.error };
        });
        return;
      }
      // The frame itself is *not* pushed here. The engine fires `onFrame` for a sent frame as it
      // records it, so the same frame is already on its way through `events.ws.live`; pushing the
      // reply as well recorded it twice — duplicate rows, doubled counts, and the frame cap
      // reached at half the real length.
    },

    cancelWs: async (requestId) => {
      const entry = get().wsByRequest[requestId];
      if (entry?.sendId === undefined || entry.status !== 'connecting') {
        return;
      }
      await ipc().request.cancel({ sendId: entry.sendId });
    },

    disconnectWs: async (requestId, code, reason) => {
      const entry = get().wsByRequest[requestId];
      if (entry?.sendId === undefined) {
        return;
      }
      update((draft) => {
        const state = draft.wsByRequest[requestId];
        if (state !== undefined && (state.status === 'connecting' || state.status === 'open')) {
          state.status = 'closing';
        }
      });
      await ipc().request.wsClose({
        sendId: entry.sendId,
        ...(code !== undefined ? { code } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    },

    closeOpenWsSessions: async (requestIds) => {
      // Collected before anything is awaited: the caller resets this state as soon as it returns.
      const live = Object.entries(get().wsByRequest).filter(
        ([requestId, state]) =>
          (requestIds === undefined || requestIds.includes(requestId)) &&
          state.sendId !== undefined &&
          (state.status === 'connecting' || state.status === 'open' || state.status === 'closing'),
      );
      if (live.length === 0) {
        return;
      }
      update((draft) => {
        for (const [requestId] of live) {
          const state = draft.wsByRequest[requestId];
          if (state !== undefined) {
            state.status = 'closing';
          }
        }
      });
      // One session refusing to close must not leave the rest of them open.
      await Promise.all(
        live.map(async ([, state]) => {
          try {
            await ipc().request.wsClose({ sendId: state.sendId! });
          } catch {
            // Nothing to report: the state this close was tidying is about to be dropped anyway.
          }
        }),
      );
    },

    clearWsRequest: (requestId) => {
      update((draft) => {
        delete draft.wsByRequest[requestId];
      });
    },

    applyWsLive: (event) => {
      update((draft) => {
        const found = Object.entries(draft.wsByRequest).find(([, state]) => state.sendId === event.sendId);
        if (found === undefined) {
          return;
        }
        const [requestId, state] = found;
        // An event for a send this request has already replaced, or one whose exchange has
        // already arrived, is dropped rather than written over the newer state.
        if (state.live === undefined) {
          return;
        }
        switch (event.kind) {
          case 'handshake':
            if (event.handshake.error === undefined) {
              state.live.handshake = event.handshake;
              state.status = 'open';
              state.live.open = true;
            } else {
              // A failed handshake ends the session: drop the live half so a frame that arrives
              // afterwards (the guard above checks `state.live === undefined`) cannot append to it.
              draft.wsByRequest[requestId] = {
                status: 'error',
                ...(state.sendId !== undefined ? { sendId: state.sendId } : {}),
              };
            }
            return;
          case 'frame':
            pushLiveFrame(state.live, event.frame);
            return;
          case 'contract': {
            // The check follows its frame; one already past the live cap is simply gone.
            const frame = state.live.frames.find((candidate) => candidate.index === event.index);
            if (frame !== undefined) {
              frame.contract = event.contract;
            }
            return;
          }
          case 'closed':
            state.live.open = false;
            state.status = 'closing';
            return;
        }
      });
    },

    sendRest: async (requestId) => {
      const request = useProjectStore.getState().restRequests[requestId];
      if (request === undefined) {
        update((draft) => {
          draft.restByRequest[requestId] = {
            status: 'error',
            error: { code: 'unknown-request', message: `No REST request with id "${requestId}"` },
          };
        });
        return;
      }

      // Last send's unresolved references say nothing about the request as it stands now.
      useProblemsStore.getState().clearSource('expansion', requestId);
      useProblemsStore.getState().clearSource('send', requestId);
      // Nor does the last response's contract result say anything about the one on its way.
      recordContractProblems(requestId, undefined);

      // A send this one replaces must not keep streaming unseen: its state is about to be dropped.
      void get()
        .cancelOpenRestSends([requestId])
        .catch(() => undefined);

      const sendId = crypto.randomUUID();
      update((draft) => {
        // No live half yet: only an `open` event says the response is an event stream, and a plain
        // response must read as an ordinary send until it arrives.
        draft.restByRequest[requestId] = {
          status: 'sending',
          sendId,
          startedAt: new Date().toISOString(),
        };
      });

      // The draft, not a resolved URL: main owns the environment, the model and the keychain, so it
      // is main that decides where this goes and what it carries.
      const draftPatch = useDraftsStore.getState().peekRestRequest(requestId);
      const result = await ipc().request.sendRest({
        sendId,
        requestId,
        ...(draftPatch !== undefined ? { draft: draftPatch } : {}),
      });

      // A cancel may already have cleared this send; only settle it if it is still ours.
      if (get().restByRequest[requestId]?.sendId !== sendId) {
        return;
      }

      if (!result.ok) {
        update((draft) => {
          draft.restByRequest[requestId] = { status: 'error', sendId, error: result.error };
        });
        useProblemsStore.getState().add([
          {
            groupId: `send:${requestId}`,
            source: 'send',
            severity: 'error',
            requestId,
            problem: { code: result.error.code, message: `${result.error.code}: ${result.error.message}` },
          },
        ]);
        return;
      }

      const unresolved = result.value.unresolved ?? [];
      if (unresolved.length > 0) {
        useProblemsStore.getState().add(expansionProblems(requestId, unresolved));
      }
      recordContractProblems(requestId, result.value.contract);
      update((draft) => {
        draft.restByRequest[requestId] = { status: 'done', sendId, exchange: result.value };
        // The same push the SOAP path does: the HTTP Log is one list across every protocol.
        draft.log.push({ kind: 'exchange', exchange: result.value, requestId });
        trimLog(draft);
      });
    },

    cancelOpenRestSends: async (requestIds) => {
      // Collected before anything is awaited: the caller may reset this state as soon as it returns.
      const open = Object.entries(get().restByRequest).filter(
        ([requestId, state]) =>
          (requestIds === undefined || requestIds.includes(requestId)) &&
          state.status === 'sending' &&
          state.sendId !== undefined,
      );
      // One send refusing to cancel must not leave the rest of them running.
      await Promise.all(
        open.map(async ([, state]) => {
          try {
            await ipc().request.cancel({ sendId: state.sendId! });
          } catch {
            // Nothing to report: the state this cancel was tidying is being dropped anyway.
          }
        }),
      );
    },

    cancelRest: async (requestId) => {
      const entry = get().restByRequest[requestId];
      if (entry?.sendId === undefined) {
        return;
      }
      await ipc().request.cancel({ sendId: entry.sendId });
    },

    clearRestRequest: (requestId) => {
      void get()
        .cancelOpenRestSends([requestId])
        .catch(() => undefined);
      recordContractProblems(requestId, undefined);
      update((draft) => {
        delete draft.restByRequest[requestId];
      });
    },

    applyRestLive: (event) => {
      update((draft) => {
        const found = Object.entries(draft.restByRequest).find(([, state]) => state.sendId === event.sendId);
        if (found === undefined) {
          return;
        }
        const [, state] = found;
        // An event for a send this request has already replaced, or one whose exchange has
        // already arrived, is dropped rather than written over the newer state.
        if (state.status !== 'sending') {
          return;
        }
        if (event.kind === 'open') {
          // The live half starts here: until main reports an event-stream response the send is an
          // ordinary one, shown as "Sending…" with Cancel.
          state.live = {
            status: event.status,
            headers: event.headers,
            rows: [],
            counts: { events: 0, comments: 0, retries: 0, bytes: 0 },
          };
          return;
        }
        if (state.live !== undefined) {
          pushLiveRow(state.live, event.row);
        }
      });
    },

    send: async (requestId, force) => {
      const projectState = useProjectStore.getState();
      const draftRequest = projectState.requests[requestId];
      if (draftRequest === undefined) {
        update((draft) => {
          draft.byRequest[requestId] = {
            status: 'error',
            error: { code: 'unknown-request', message: `No request draft with id "${requestId}"` },
          };
        });
        return;
      }

      // Every send starts from a clean slate for this request: last time's unresolved
      // references (and last time's transport failure) say nothing about the model as it
      // stands now.
      useProblemsStore.getState().clearSource('expansion', requestId);
      useProblemsStore.getState().clearSource('send', requestId);

      const autoValidate = usePreferencesStore.getState().preferences.editor.autoValidateOnSend;
      if (autoValidate && force !== true) {
        const problems = await runValidation(requestId, 'request', draftRequest.envelopeXml);
        const errors = problems.filter((problem) => problem.severity === 'error').length;
        if (errors > 0) {
          showToast(`Request has ${String(errors)} validation error${errors === 1 ? '' : 's'}`, {
            label: 'Send anyway',
            onClick: () => {
              void get().send(requestId, true);
            },
          });
          return;
        }
      }

      // `sending` is entered before the preflight round trip, so the UI reacts to the click
      // rather than to the reply, and a cancel issued in between still finds this send.
      const sendId = crypto.randomUUID();
      update((draft) => {
        draft.byRequest[requestId] = { status: 'sending', sendId, startedAt: new Date().toISOString() };
      });

      // Main resolves the endpoint against the authoritative model (including the active
      // environment) and dry-runs the expansion; the mirror's own answer is the fallback for
      // an unsaved/unknown request, where preflight cannot help.
      const preflight = await ipc().request.preflight({ requestId });
      const endpoint = preflight.ok
        ? preflight.value.endpoint
        : selectRequestEndpointUrl(projectState, useWorkspaceStore.getState().workspace, requestId);
      if (preflight.ok && preflight.value.unresolved.length > 0) {
        useProblemsStore.getState().add(expansionProblems(requestId, preflight.value.unresolved));
      }

      if (endpoint === undefined || endpoint.length === 0) {
        update((draft) => {
          draft.byRequest[requestId] = {
            status: 'error',
            sendId,
            error: { code: 'missing-endpoint', message: 'This request has no endpoint set.' },
          };
        });
        return;
      }

      const result = await ipc().request.send({
        sendId,
        requestId,
        input: {
          endpoint,
          envelopeXml: draftRequest.envelopeXml,
          soapVersion: draftRequest.soapVersion,
          ...(draftRequest.soapAction !== undefined ? { soapAction: draftRequest.soapAction } : {}),
          headers: Object.fromEntries(draftRequest.headers.map((header) => [header.name, header.value])),
        },
      });

      // A cancel may have already cleared/overwritten this send; only settle it if it's still ours.
      if (get().byRequest[requestId]?.sendId !== sendId) {
        return;
      }

      if (!result.ok) {
        update((draft) => {
          draft.byRequest[requestId] = { status: 'error', sendId, error: result.error };
        });
        // A failed send is not just a red status line that the next send erases: it belongs in
        // Problems alongside everything else that went wrong with this request.
        useProblemsStore.getState().add([
          {
            groupId: `send:${requestId}`,
            source: 'send',
            severity: 'error',
            requestId,
            problem: { code: result.error.code, message: `${result.error.code}: ${result.error.message}` },
          },
        ]);
        return;
      }

      // The engine expands the input it was actually given, so it can report references the
      // preflight never saw (an unsaved envelope edit, say); merge in whatever is new.
      const already = new Set(
        useProblemsStore
          .getState()
          .items.filter((item) => item.source === 'expansion' && item.requestId === requestId)
          .map((item) => item.problem.message),
      );
      const extra = expansionProblems(requestId, result.value.unresolved ?? []).filter(
        (item) => !already.has(item.problem.message),
      );
      if (extra.length > 0) {
        useProblemsStore.getState().add(extra);
      }

      if (autoValidate) {
        const responseXml = result.value.response?.envelopeXml;
        if (responseXml !== undefined) {
          void runValidation(requestId, 'response', responseXml);
        }
      }

      update((draft) => {
        draft.byRequest[requestId] = { status: 'done', sendId, exchange: result.value };
        draft.log.push({ kind: 'exchange', exchange: result.value, requestId });
        trimLog(draft);
      });
    },

    cancel: async (requestId) => {
      const entry = get().byRequest[requestId];
      if (entry?.sendId === undefined) {
        return;
      }
      await ipc().request.cancel({ sendId: entry.sendId });
    },

    refreshExchange: async (sendId) => {
      const result = await ipc().exchanges.get({ sendId });
      if (!result.ok) {
        return;
      }
      const fresh = result.value;
      update((draft) => {
        const index = draft.log.findIndex((entry) => entry.kind === 'exchange' && entry.exchange.sendId === sendId);
        if (index >= 0) {
          const previous = draft.log[index];
          const requestId = previous?.kind === 'exchange' ? previous.requestId : undefined;
          draft.log[index] =
            requestId === undefined
              ? { kind: 'exchange', exchange: fresh }
              : { kind: 'exchange', exchange: fresh, requestId };
        }
        // A REST summary is the one carrying `methodChanged`; each lands back in its own protocol's map.
        if ('methodChanged' in fresh) {
          for (const [requestId, state] of Object.entries(draft.restByRequest)) {
            if (state.sendId === sendId && state.exchange !== undefined) {
              draft.restByRequest[requestId] = { ...state, exchange: fresh };
            }
          }
          return;
        }
        for (const [requestId, state] of Object.entries(draft.byRequest)) {
          if (state.sendId === sendId && state.exchange !== undefined) {
            draft.byRequest[requestId] = { ...state, exchange: fresh };
          }
        }
      });
    },

    clearLog: () => {
      update((draft) => {
        draft.log = [];
      });
    },

    setPreserveLog: (on) => {
      set({ preserveLog: on });
    },

    setLogCap: (cap) => {
      update((draft) => {
        draft.logCap = cap;
        trimLog(draft);
      });
    },

    appendExchange: (exchange, requestId) => {
      update((draft) => {
        if (draft.log.some((entry) => sendIdOf(entry) === exchange.sendId)) {
          return;
        }
        draft.log.push(
          requestId === undefined ? { kind: 'exchange', exchange } : { kind: 'exchange', exchange, requestId },
        );
        trimLog(draft);
      });
    },

    appendFailure: (failure) => {
      update((draft) => {
        if (draft.log.some((entry) => sendIdOf(entry) === failure.sendId)) {
          return;
        }
        draft.log.push({ kind: 'failure', failure });
        trimLog(draft);
      });
    },

    appendLoggedEntry: (entry) => {
      update((draft) => {
        if (draft.log.some((existing) => sendIdOf(existing) === sendIdOf(entry))) {
          return;
        }
        draft.log.push(entry);
        trimLog(draft);
      });
    },

    setFilter: (patch) => {
      set((state) => ({ filter: { ...state.filter, ...patch } }));
    },

    resetFilter: () => {
      set({ filter: EMPTY_FILTER, sort: undefined });
    },

    cycleSort: (column) => {
      set((state) => {
        if (state.sort?.column !== column) {
          return { sort: { column, direction: 'asc' } };
        }
        return { sort: state.sort.direction === 'asc' ? { column, direction: 'desc' } : undefined };
      });
    },

    clearRequest: (requestId) => {
      update((draft) => {
        delete draft.byRequest[requestId];
      });
    },
  };
});

/**
 * Subscribes the gRPC panes to `grpc.live`, the running half of a call. Called once from the
 * shell; returns the unsubscribe for symmetry with React effects.
 */
export function subscribeToGrpcLive(): () => void {
  return window.wirebench.on('grpc.live', ((payload: GrpcLiveEvent) => {
    useExchangesStore.getState().applyGrpcLive(payload);
  }) as (payload: unknown) => void);
}

/**
 * Subscribes the WebSocket panes to `ws.live`, the running half of a session. Called once from the
 * shell; returns the unsubscribe for symmetry with React effects.
 */
export function subscribeToWsLive(): () => void {
  return window.wirebench.on('ws.live', ((payload: WsLiveEvent) => {
    useExchangesStore.getState().applyWsLive(payload);
  }) as (payload: unknown) => void);
}

/**
 * Subscribes the REST panes to `rest.live`, the running half of an event-stream response. Called
 * once from the shell, beside `subscribeToWsLive`; returns the unsubscribe for symmetry with React
 * effects.
 */
export function subscribeToRestLive(): () => void {
  return window.wirebench.on('rest.live', ((payload: RestLiveEvent) => {
    useExchangesStore.getState().applyRestLive(payload);
  }) as (payload: unknown) => void);
}

/**
 * Subscribes the log to `exchange.failed`. Called once from the shell, beside `subscribeToHistory`;
 * returns the unsubscribe for symmetry with React effects.
 */
export function subscribeToExchangeFailures(): () => void {
  return window.wirebench.on('exchange.failed', ((payload: ExchangeFailedEvent) => {
    useExchangesStore.getState().appendFailure(payload.failure);
  }) as (payload: unknown) => void);
}

/**
 * Subscribes the log to `exchange.logged` — a row main puts there before its own invoke resolves
 * (currently only a WebSocket handshake). Called once from the shell, beside
 * `subscribeToExchangeFailures`; returns the unsubscribe for symmetry with React effects.
 */
export function subscribeToExchangeLogged(): () => void {
  return window.wirebench.on('exchange.logged', ((payload: ExchangeLoggedEvent) => {
    const { entry } = payload;
    if (entry.kind === 'failure') {
      useExchangesStore.getState().appendFailure(entry.failure);
      return;
    }
    // Normalized rather than spread as-is: the wire type allows an explicit `requestId: undefined`,
    // which `LogEntry`'s optional field does not.
    useExchangesStore
      .getState()
      .appendLoggedEntry(
        entry.requestId === undefined
          ? { kind: 'exchange', exchange: entry.exchange }
          : { kind: 'exchange', exchange: entry.exchange, requestId: entry.requestId },
      );
  }) as (payload: unknown) => void);
}

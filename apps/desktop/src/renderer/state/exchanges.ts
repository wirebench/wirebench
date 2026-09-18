import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import { showToast } from '../components/toast.js';
import { runValidation } from '../features/request-editor/validate-actions.js';
import type { AnyExchangeSummary } from '../features/request-editor/response-status.js';
import type {
  ExchangeFailedEvent,
  ExchangeSummary,
  FailedExchangeWire,
  GrpcExchangeSummary,
  GrpcLiveEvent,
  GrpcResponseMessageWire,
  RestExchangeSummary,
  UnresolvedRefWire,
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
const LOG_CAP = 500;

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
  readonly protocols: readonly ('soap' | 'rest' | 'grpc')[];
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

/** What is known about the most recent send for one REST request. */
export interface RestExchangeState {
  readonly status: ExchangeStatus;
  readonly sendId?: string;
  readonly exchange?: RestExchangeSummary;
  readonly error?: IpcError;
  readonly startedAt?: string;
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
  /**
   * Newest-last log of every send this session, SOAP and REST alike, finished or failed: the
   * console's HTTP Log is a protocol-neutral surface, and a send that never produced a response
   * belongs in it as much as one that did.
   */
  readonly log: readonly LogEntry[];
  /** The HTTP Log's filter. Not persisted; dropped with the log on `reset`. */
  readonly filter: LogFilter;
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
   * keyed by requests of projects that are no longer open.
   */
  readonly reset: () => void;
  /** Empties the HTTP log. Per-request state is left alone — the panes keep their responses. */
  readonly clearLog: () => void;
  /**
   * Appends a finished exchange's row — a resend from the HTTP Log's row menu. A `sendId` already in
   * the log (either kind) is ignored.
   */
  readonly appendExchange: (exchange: AnyExchangeSummary, requestId?: string) => void;
  /** Appends a failed send's row. A `sendId` already in the log (either kind) is ignored. */
  readonly appendFailure: (failure: FailedExchangeWire) => void;
  /** Merges a patch into the HTTP Log filter. */
  readonly setFilter: (patch: Partial<LogFilter>) => void;
  /** Shows every row again. Distinct from `clearLog`, which empties the log. */
  readonly resetFilter: () => void;
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
    log: [],
    filter: EMPTY_FILTER,

    reset: () => {
      set({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, log: [], filter: EMPTY_FILTER });
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
        if (draft.log.length > LOG_CAP) {
          draft.log.splice(0, draft.log.length - LOG_CAP);
        }
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

      const sendId = crypto.randomUUID();
      update((draft) => {
        draft.restByRequest[requestId] = { status: 'sending', sendId, startedAt: new Date().toISOString() };
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
      update((draft) => {
        draft.restByRequest[requestId] = { status: 'done', sendId, exchange: result.value };
        // The same push the SOAP path does: the HTTP Log is one list across every protocol.
        // (`refreshExchange` cannot re-redact a REST row on a show-secrets toggle — `exchanges.get`
        // only knows the SOAP cache — but the row's URL was already redacted at send time, so it
        // stays correct; it just does not gain the secret back. Tracked on the roadmap.)
        draft.log.push({ kind: 'exchange', exchange: result.value, requestId });
        if (draft.log.length > LOG_CAP) {
          draft.log.splice(0, draft.log.length - LOG_CAP);
        }
      });
    },

    cancelRest: async (requestId) => {
      const entry = get().restByRequest[requestId];
      if (entry?.sendId === undefined) {
        return;
      }
      await ipc().request.cancel({ sendId: entry.sendId });
    },

    clearRestRequest: (requestId) => {
      update((draft) => {
        delete draft.restByRequest[requestId];
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
        if (draft.log.length > LOG_CAP) {
          draft.log.splice(0, draft.log.length - LOG_CAP);
        }
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

    appendExchange: (exchange, requestId) => {
      update((draft) => {
        if (draft.log.some((entry) => sendIdOf(entry) === exchange.sendId)) {
          return;
        }
        draft.log.push(
          requestId === undefined ? { kind: 'exchange', exchange } : { kind: 'exchange', exchange, requestId },
        );
        if (draft.log.length > LOG_CAP) {
          draft.log.splice(0, draft.log.length - LOG_CAP);
        }
      });
    },

    appendFailure: (failure) => {
      update((draft) => {
        if (draft.log.some((entry) => sendIdOf(entry) === failure.sendId)) {
          return;
        }
        draft.log.push({ kind: 'failure', failure });
        if (draft.log.length > LOG_CAP) {
          draft.log.splice(0, draft.log.length - LOG_CAP);
        }
      });
    },

    setFilter: (patch) => {
      set((state) => ({ filter: { ...state.filter, ...patch } }));
    },

    resetFilter: () => {
      set({ filter: EMPTY_FILTER });
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
 * Subscribes the log to `exchange.failed`. Called once from the shell, beside `subscribeToHistory`;
 * returns the unsubscribe for symmetry with React effects.
 */
export function subscribeToExchangeFailures(): () => void {
  return window.wirebench.on('exchange.failed', ((payload: ExchangeFailedEvent) => {
    useExchangesStore.getState().appendFailure(payload.failure);
  }) as (payload: unknown) => void);
}

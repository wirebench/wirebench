import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import { showToast } from '../components/toast.js';
import { runValidation } from '../features/request-editor/validate-actions.js';
import type { AnyExchangeSummary } from '../features/request-editor/response-status.js';
import type {
  ExchangeSummary,
  GrpcExchangeSummary,
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

/** What is known about the most recent call of one gRPC request. */
export interface GrpcExchangeState {
  readonly status: ExchangeStatus;
  readonly sendId?: string;
  readonly exchange?: GrpcExchangeSummary;
  readonly error?: IpcError;
  readonly startedAt?: string;
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
   * Newest-last log of every completed exchange, SOAP and REST alike: the console's HTTP Log is a
   * protocol-neutral surface, and a REST send that never reached it left the log and the status
   * bar's "last:" indicator claiming nothing had been sent.
   */
  readonly log: readonly AnyExchangeSummary[];
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
  /** Makes one gRPC call, the request and its unsaved draft named; main resolves everything else. */
  readonly sendGrpc: (requestId: string) => Promise<void>;
  readonly cancelGrpc: (requestId: string) => Promise<void>;
  readonly clearGrpcRequest: (requestId: string) => void;
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

    reset: () => {
      set({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, log: [] });
    },

    sendGrpc: async (requestId) => {
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
      update((draft) => {
        draft.grpcByRequest[requestId] = { status: 'sending', sendId, startedAt: new Date().toISOString() };
      });

      const draftPatch = useDraftsStore.getState().peekGrpcRequest(requestId);
      const result = await ipc().request.sendGrpc({
        sendId,
        requestId,
        ...(draftPatch !== undefined ? { draft: draftPatch } : {}),
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
        draft.grpcByRequest[requestId] = { status: 'done', sendId, exchange: result.value };
        draft.log.push(result.value);
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
        // The same push the SOAP path does: the HTTP Log is one list across both protocols.
        // (`refreshExchange` cannot re-redact a REST row on a show-secrets toggle — `exchanges.get`
        // only knows the SOAP cache — but the row's URL was already redacted at send time, so it
        // stays correct; it just does not gain the secret back. Tracked on the roadmap.)
        draft.log.push(result.value);
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
        draft.log.push(result.value);
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
        const index = draft.log.findIndex((entry) => entry.sendId === sendId);
        if (index >= 0) {
          draft.log[index] = fresh;
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

    clearRequest: (requestId) => {
      update((draft) => {
        delete draft.byRequest[requestId];
      });
    },
  };
});

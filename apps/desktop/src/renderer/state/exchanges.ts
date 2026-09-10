import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import type { ExchangeSummary, UnresolvedRefWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';
import type { Problem } from './problems.js';
import { useProblemsStore } from './problems.js';
import { selectRequestEndpointUrl } from './project-endpoint.js';
import { useProjectStore } from './project.js';

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

/** The exchanges store's serialisable state. */
export interface ExchangesSnapshot {
  readonly byRequest: Record<string, ExchangeState>;
  readonly log: readonly ExchangeSummary[];
}

/** The exchanges store: {@link ExchangesSnapshot} plus the actions that drive a send. */
export interface ExchangesStore extends ExchangesSnapshot {
  readonly send: (requestId: string) => Promise<void>;
  readonly cancel: (requestId: string) => Promise<void>;
  /** Clears the exchange state for a removed request (keeps the log). */
  readonly clearRequest: (requestId: string) => void;
  /** Empties the HTTP log. Per-request state is left alone — the panes keep their responses. */
  readonly clearLog: () => void;
  /**
   * Re-reads one exchange from main (`exchanges.get`), which re-redacts it against the
   * show-secrets flag as it stands now, and swaps the fresher copy into the log and the
   * request's pane. A no-op when main has evicted the exchange.
   */
  readonly refreshExchange: (sendId: string) => Promise<void>;
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
    log: [],

    send: async (requestId) => {
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
      const endpoint = preflight.ok ? preflight.value.endpoint : selectRequestEndpointUrl(projectState, requestId);
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

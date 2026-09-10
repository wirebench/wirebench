import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import type { ExchangeSummary } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';
import { selectRequestEndpoint, useProjectStore } from './project.js';

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
}

type Mutate = (draft: Draft<ExchangesSnapshot>) => void;

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
      const endpoint = selectRequestEndpoint(projectState, requestId);
      if (endpoint === undefined || endpoint.length === 0) {
        update((draft) => {
          draft.byRequest[requestId] = {
            status: 'error',
            error: { code: 'missing-endpoint', message: 'This request has no endpoint set.' },
          };
        });
        return;
      }

      const sendId = crypto.randomUUID();
      update((draft) => {
        draft.byRequest[requestId] = { status: 'sending', sendId, startedAt: new Date().toISOString() };
      });

      const result = await ipc().request.send({
        sendId,
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
        return;
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

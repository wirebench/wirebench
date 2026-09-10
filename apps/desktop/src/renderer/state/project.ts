import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { ImportSourceWire, InterfaceSummary, RequestGenerateResponse } from '../../shared/wire-types.js';
import { useEditorsStore } from './editors.js';
import { useExchangesStore } from './exchanges.js';
import { ipc } from './ipc-client.js';

/** One request tab: an operation's generated envelope, plus whatever the user has edited. */
export interface RequestDraft {
  readonly id: string;
  readonly interfaceId: string;
  /** Clark-notation binding QName (`{namespaceUri}localName`), as returned by `definition.import`. */
  readonly bindingName: string;
  readonly operationName: string;
  readonly name: string;
  readonly envelopeXml: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
  readonly endpoint?: string;
  readonly headers: Record<string, string>;
  /** Non-fatal problems from the `request.generate` call that produced this draft, if any. */
  readonly problems?: { readonly code: string; readonly message: string }[];
}

/** In-memory project model: imported interfaces and the request drafts generated from them. */
export interface ProjectSnapshot {
  readonly interfaces: Record<string, InterfaceSummary>;
  readonly requests: Record<string, RequestDraft>;
  /** Interface ids, in import order — what the explorer iterates to render the tree. */
  readonly order: string[];
}

/** The project store: {@link ProjectSnapshot} plus the actions that mutate it. */
export interface ProjectStore extends ProjectSnapshot {
  readonly importDefinition: (
    source: ImportSourceWire,
    options?: { readonly auth?: { readonly username: string; readonly password: string } },
    token?: string,
  ) => Promise<InterfaceSummary>;
  readonly removeInterface: (interfaceId: string) => Promise<void>;
  readonly updateRequest: (requestId: string, patch: Partial<Omit<RequestDraft, 'id' | 'interfaceId'>>) => void;
  readonly setEndpoint: (requestId: string, url: string) => void;
  /** Generates another draft for the operation (same path `definition.import` uses), named `Request N`. */
  readonly addRequest: (interfaceId: string, bindingName: string, operationName: string) => Promise<string>;
  /** Copies an existing draft, named `<name> (copy)`. Returns the new draft's id. */
  readonly cloneRequest: (requestId: string) => string;
  /** Deletes a draft and closes its open editor tab, if any. */
  readonly removeRequest: (requestId: string) => void;
}

type Mutate = (draft: Draft<ProjectSnapshot>) => void;

/** Picks the first port address declared for an operation, if any — the draft's initial endpoint. */
function firstAddress(summary: InterfaceSummary, bindingLocal: string): string | undefined {
  const operation = summary.operations.find((op) => op.bindingLocal === bindingLocal);
  return operation?.ports.find((port) => port.address !== undefined)?.address;
}

function draftFromGenerated(
  interfaceId: string,
  binding: string,
  bindingLocal: string,
  operationName: string,
  summary: InterfaceSummary,
  generated: RequestGenerateResponse,
  name = 'Request 1',
): RequestDraft {
  const endpoint = firstAddress(summary, bindingLocal);
  return {
    id: crypto.randomUUID(),
    interfaceId,
    bindingName: binding,
    operationName,
    name,
    envelopeXml: generated.envelopeXml,
    soapVersion: generated.soapVersion,
    ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    headers: { ...generated.headers },
    ...(generated.problems.length > 0 ? { problems: [...generated.problems] } : {}),
  };
}

function failedDraft(interfaceId: string, binding: string, operationName: string, message: string): RequestDraft {
  return {
    id: crypto.randomUUID(),
    interfaceId,
    bindingName: binding,
    operationName,
    name: 'Request 1',
    envelopeXml: '',
    soapVersion: '1.1',
    headers: {},
    problems: [{ code: 'generate-failed', message }],
  };
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  const update = (recipe: Mutate): void => {
    set((state) => produce(state, recipe));
  };

  return {
    interfaces: {},
    requests: {},
    order: [],

    importDefinition: async (source, options, token) => {
      const result = await ipc().definition.import({
        source,
        ...(options !== undefined ? { options } : {}),
        ...(token !== undefined ? { token } : {}),
      });
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      }
      const summary = result.value;

      update((draft) => {
        draft.interfaces[summary.id] = summary;
        draft.order.push(summary.id);
      });

      // Sequentially, so a slow/failing generate for one operation never races another's write.
      for (const operation of summary.operations) {
        const generated = await ipc().request.generate({
          interfaceId: summary.id,
          bindingName: operation.binding,
          operationName: operation.name,
        });
        const draftRequest = generated.ok
          ? draftFromGenerated(
              summary.id,
              operation.binding,
              operation.bindingLocal,
              operation.name,
              summary,
              generated.value,
            )
          : failedDraft(summary.id, operation.binding, operation.name, generated.error.message);
        update((draft) => {
          draft.requests[draftRequest.id] = draftRequest;
        });
      }

      return summary;
    },

    removeInterface: async (interfaceId) => {
      await ipc().definition.close({ interfaceId });
      update((draft) => {
        delete draft.interfaces[interfaceId];
        draft.order = draft.order.filter((id) => id !== interfaceId);
        for (const [requestId, request] of Object.entries(draft.requests)) {
          if (request.interfaceId === interfaceId) {
            delete draft.requests[requestId];
          }
        }
      });
    },

    updateRequest: (requestId, patch) => {
      update((draft) => {
        const request = draft.requests[requestId];
        if (request === undefined) {
          return;
        }
        Object.assign(request, patch);
      });
    },

    setEndpoint: (requestId, url) => {
      get().updateRequest(requestId, { endpoint: url });
    },

    addRequest: async (interfaceId, bindingName, operationName) => {
      const summary = get().interfaces[interfaceId];
      if (summary === undefined) {
        throw new Error(`unknown-interface: ${interfaceId}`);
      }
      const operation = summary.operations.find((op) => op.binding === bindingName && op.name === operationName);
      if (operation === undefined) {
        throw new Error(`unknown-operation: ${bindingName} ${operationName}`);
      }
      const existingDrafts = Object.values(get().requests).filter(
        (r) => r.interfaceId === interfaceId && r.bindingName === bindingName && r.operationName === operationName,
      );
      const maxIndex = existingDrafts.reduce((max, draft) => {
        const match = draft.name.match(/^Request (\d+)$/);
        return match ? Math.max(max, parseInt(match[1]!, 10)) : max;
      }, 0);
      const name = `Request ${String(maxIndex + 1)}`;

      const generated = await ipc().request.generate({ interfaceId, bindingName, operationName });
      const draftRequest = generated.ok
        ? draftFromGenerated(
            interfaceId,
            bindingName,
            operation.bindingLocal,
            operationName,
            summary,
            generated.value,
            name,
          )
        : failedDraft(interfaceId, bindingName, operationName, generated.error.message);
      const finalDraft = { ...draftRequest, name };
      update((draft) => {
        draft.requests[finalDraft.id] = finalDraft;
      });
      return finalDraft.id;
    },

    cloneRequest: (requestId) => {
      const source = get().requests[requestId];
      if (source === undefined) {
        throw new Error(`unknown-request: ${requestId}`);
      }
      const clone: RequestDraft = { ...source, id: crypto.randomUUID(), name: `${source.name} (copy)` };
      update((draft) => {
        draft.requests[clone.id] = clone;
      });
      return clone.id;
    },

    removeRequest: (requestId) => {
      update((draft) => {
        delete draft.requests[requestId];
      });
      useEditorsStore.getState().close(`request:${requestId}`);
      useExchangesStore.getState().clearRequest(requestId);
    },
  };
});

import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import type {
  ImportSourceWire,
  InterfaceWire,
  ProjectChange,
  ProjectChangedEvent,
  ProjectChangedOnDiskEvent,
  ProjectWire,
  RecentProject,
  RequestPatchWire,
  RequestWire,
} from '../../shared/wire-types.js';
import { useEditorsStore } from './editors.js';
import { useExchangesStore } from './exchanges.js';
import { ipc } from './ipc-client.js';

/**
 * One request as the renderer sees it. Historically an in-memory draft; since Task 21 it is
 * a mirror of the request saved on disk, hence the alias rather than a separate shape.
 */
export type RequestDraft = RequestWire;

/** Whether an explicit or automatic save is currently running. */
export type SaveStatus = 'idle' | 'saving' | 'saved';

/** The renderer's read-only mirror of the main process's project model. */
export interface ProjectSnapshot {
  /** The open project, or `null` when the Welcome screen should be shown. */
  readonly project: ProjectWire | null;
  /** Interfaces by id — a derived index over `project.interfaces`. */
  readonly interfaces: Record<string, InterfaceWire>;
  /** Requests by id — a derived index over `project.requests`. */
  readonly requests: Record<string, RequestDraft>;
  /** Interface ids in project order: what the explorer iterates to render the tree. */
  readonly order: string[];
  readonly saveStatus: SaveStatus;
  readonly lastSavedAt: string | undefined;
  /** Paths reported by the folder watcher since the banner was last dismissed. */
  readonly changedOnDisk: readonly string[];
}

/** The project store: {@link ProjectSnapshot} plus the actions that drive main. */
export interface ProjectStore extends ProjectSnapshot {
  /** Replaces the mirror wholesale (used by `project.changed` and every action's reply). */
  readonly applySnapshot: (project: ProjectWire | null) => void;
  readonly createProject: (dir: string, name: string) => Promise<void>;
  readonly openProject: (dir: string) => Promise<void>;
  readonly closeProject: () => Promise<void>;
  readonly reloadProject: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly save: () => Promise<void>;
  readonly recent: () => Promise<RecentProject[]>;
  readonly noteChangedOnDisk: (paths: readonly string[]) => void;
  readonly dismissChangedOnDisk: () => void;
  /** Imports a WSDL into the open project; the interface and its `Request 1`s come back saved. */
  readonly importDefinition: (
    source: ImportSourceWire,
    options?: { readonly auth?: { readonly username: string; readonly password: string } },
    token?: string,
  ) => Promise<InterfaceWire>;
  readonly removeInterface: (interfaceId: string) => Promise<void>;
  readonly updateRequest: (requestId: string, patch: RequestPatchWire) => void;
  readonly setEndpoint: (requestId: string, url: string) => void;
  /** Generates another request for the operation, named `Request N`. Returns its id. */
  readonly addRequest: (interfaceId: string, bindingName: string, operationName: string) => Promise<string>;
  /** Copies an existing request, named `<name> (copy)`. Returns the new request's id. */
  readonly cloneRequest: (requestId: string) => Promise<string>;
  /** Deletes a request and closes its open editor tab, if any. */
  readonly removeRequest: (requestId: string) => Promise<void>;
}

type Mutate = (draft: Draft<ProjectSnapshot>) => void;

function asError(error: IpcError): Error {
  return Object.assign(new Error(error.message), { code: error.code });
}

/**
 * Patches the renderer applied optimistically and has not yet had acknowledged by main.
 * Re-applied on top of every incoming snapshot so a reply that crosses a keystroke cannot
 * make the editor jump back to what the user typed a moment ago.
 */
const pending = new Map<string, RequestPatchWire>();

function withPatch(request: RequestDraft, patch: RequestPatchWire): RequestDraft {
  return {
    ...request,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.envelopeXml !== undefined ? { envelopeXml: patch.envelopeXml } : {}),
    ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
    ...(patch.endpointId !== undefined ? { endpointId: patch.endpointId ?? undefined } : {}),
    ...(patch.endpointUrl !== undefined ? { endpointUrl: patch.endpointUrl ?? undefined } : {}),
    ...(patch.soapAction !== undefined ? { soapAction: patch.soapAction ?? undefined } : {}),
  };
}

/** Builds the `interfaces`/`requests`/`order` indexes the existing selectors read. */
function indexesOf(project: ProjectWire | null): Pick<ProjectSnapshot, 'interfaces' | 'requests' | 'order'> {
  if (project === null) {
    return { interfaces: {}, requests: {}, order: [] };
  }
  const interfaces: Record<string, InterfaceWire> = {};
  for (const iface of project.interfaces) {
    interfaces[iface.id] = iface;
  }
  const requests: Record<string, RequestDraft> = {};
  for (const request of project.requests) {
    const patch = pending.get(request.id);
    requests[request.id] = patch === undefined ? request : withPatch(request, patch);
  }
  return { interfaces, requests, order: project.interfaces.map((iface) => iface.id) };
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  const update = (recipe: Mutate): void => {
    set((state) => produce(state, recipe));
  };

  const apply = (project: ProjectWire | null): void => {
    set((state) => ({
      ...state,
      project,
      ...indexesOf(project),
      lastSavedAt: project?.lastSavedAt ?? state.lastSavedAt,
    }));
  };

  const mutate = async (change: ProjectChange): Promise<string | undefined> => {
    const result = await ipc().project.mutate({ change });
    if (!result.ok) {
      throw asError(result.error);
    }
    apply(result.value.project);
    return result.value.createdRequestId;
  };

  return {
    project: null,
    interfaces: {},
    requests: {},
    order: [],
    saveStatus: 'idle',
    lastSavedAt: undefined,
    changedOnDisk: [],

    applySnapshot: apply,

    createProject: async (dir, name) => {
      const result = await ipc().project.create({ dir, name });
      if (!result.ok) {
        throw asError(result.error);
      }
      apply(result.value.project);
    },

    openProject: async (dir) => {
      const result = await ipc().project.open({ dir });
      if (!result.ok) {
        throw asError(result.error);
      }
      apply(result.value.project);
    },

    closeProject: async () => {
      const result = await ipc().project.close(undefined);
      if (result.ok) {
        apply(result.value.project);
      }
    },

    reloadProject: async () => {
      const result = await ipc().project.reload(undefined);
      if (!result.ok) {
        throw asError(result.error);
      }
      pending.clear();
      apply(result.value.project);
      update((draft) => {
        draft.changedOnDisk = [];
      });
    },

    refresh: async () => {
      const result = await ipc().project.snapshot(undefined);
      if (result.ok) {
        apply(result.value.project);
      }
    },

    save: async () => {
      update((draft) => {
        draft.saveStatus = 'saving';
      });
      const result = await ipc().project.save(undefined);
      update((draft) => {
        draft.saveStatus = 'saved';
        if (result.ok && result.value.savedAt !== undefined) {
          draft.lastSavedAt = result.value.savedAt;
        }
      });
    },

    recent: async () => {
      const result = await ipc().project.recent(undefined);
      return result.ok ? result.value.recent : [];
    },

    noteChangedOnDisk: (paths) => {
      update((draft) => {
        draft.changedOnDisk = [...new Set([...draft.changedOnDisk, ...paths])];
      });
    },

    dismissChangedOnDisk: () => {
      update((draft) => {
        draft.changedOnDisk = [];
      });
    },

    importDefinition: async (source, options, token) => {
      const result = await ipc().project.addInterface({
        source,
        ...(options?.auth !== undefined ? { auth: options.auth } : {}),
        ...(token !== undefined ? { token } : {}),
      });
      if (!result.ok) {
        throw asError(result.error);
      }
      apply(result.value.project);
      const added = get().interfaces[result.value.interfaceId];
      if (added === undefined) {
        throw new Error(`import returned an unknown interface: ${result.value.interfaceId}`);
      }
      return added;
    },

    removeInterface: async (interfaceId) => {
      await mutate({ kind: 'remove-interface', interfaceId });
    },

    updateRequest: (requestId, patch) => {
      // Applied locally first so typing stays smooth, then merged with whatever main replies.
      const existing = pending.get(requestId);
      const merged: RequestPatchWire = { ...existing, ...patch };
      pending.set(requestId, merged);
      update((draft) => {
        const request = draft.requests[requestId];
        if (request !== undefined) {
          draft.requests[requestId] = withPatch(request, patch);
        }
      });
      void ipc()
        .project.mutate({ change: { kind: 'update-request', requestId, patch } })
        .then((result) => {
          // Apply first, drop the pending patch second: the reply already contains this edit,
          // but a snapshot that crossed a later keystroke does not, and the patch covers it.
          if (result.ok) {
            apply(result.value.project);
          }
          if (pending.get(requestId) === merged) {
            pending.delete(requestId);
          }
        });
    },

    setEndpoint: (requestId, url) => {
      get().updateRequest(requestId, { endpointUrl: url });
    },

    addRequest: async (interfaceId, bindingName, operationName) => {
      const created = await mutate({ kind: 'add-request', interfaceId, bindingName, operationName });
      if (created === undefined) {
        throw new Error('add-request did not return a request id');
      }
      return created;
    },

    cloneRequest: async (requestId) => {
      const created = await mutate({ kind: 'clone-request', requestId });
      if (created === undefined) {
        throw new Error('clone-request did not return a request id');
      }
      return created;
    },

    removeRequest: async (requestId) => {
      await mutate({ kind: 'remove-request', requestId });
      pending.delete(requestId);
      useEditorsStore.getState().close(`request:${requestId}`);
      useExchangesStore.getState().clearRequest(requestId);
    },
  };
});

/**
 * The URL a request is actually sent to: its own custom URL, else its chosen interface
 * endpoint, else the interface default, else the interface's first endpoint. Mirrors the
 * engine's `resolveEndpoint` precedence; environments join it in Task 22.
 */
export function selectRequestEndpoint(state: ProjectSnapshot, requestId: string): string | undefined {
  const request = state.requests[requestId];
  if (request === undefined) {
    return undefined;
  }
  if (request.endpointUrl !== undefined) {
    return request.endpointUrl;
  }
  const iface = state.interfaces[request.interfaceId];
  if (iface === undefined) {
    return undefined;
  }
  const byId = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : iface.endpoints.find((endpoint) => endpoint.id === id)?.url;
  return byId(request.endpointId) ?? byId(iface.defaultEndpointId) ?? iface.endpoints[0]?.url;
}

/**
 * Subscribes the mirror to main's project events and pulls the initial snapshot. Called once
 * from the shell; returns an unsubscribe for symmetry with React effects.
 */
export function subscribeToProject(): () => void {
  const store = useProjectStore.getState();
  void store.refresh();
  // `defineEvent` types every event's `name` as `string`, so the derived event map cannot
  // narrow a payload by channel; the casts below are the same ones the import dialog uses.
  const offChanged = window.wirebench.on('project.changed', ((payload: ProjectChangedEvent) => {
    useProjectStore.getState().applySnapshot(payload.project);
  }) as (payload: unknown) => void);
  const offDisk = window.wirebench.on('project.changedOnDisk', ((payload: ProjectChangedOnDiskEvent) => {
    useProjectStore.getState().noteChangedOnDisk(payload.paths);
  }) as (payload: unknown) => void);
  return () => {
    offChanged();
    offDisk();
  };
}

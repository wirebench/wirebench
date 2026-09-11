import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import { showToast } from '../components/toast.js';
import type { IpcError } from '../../shared/ipc.js';
import type {
  AttachmentPatchWire,
  EndpointAuthWire,
  EnvironmentPatchWire,
  EnvironmentWire,
  ImportSourceWire,
  InterfaceWire,
  KeystorePatchWire,
  WssIncomingPatchWire,
  WssIncomingWire,
  WssOutgoingPatchWire,
  WssOutgoingWire,
  KeystoreWire,
  ProjectChange,
  ProjectChangedEvent,
  ProjectChangedOnDiskEvent,
  ProjectMutateResponse,
  ProjectSettingsPatchWire,
  ProjectWire,
  RecentProject,
  RequestPatchWire,
  RequestPropertiesPatchWire,
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
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

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
  /** The project's environments, in `order`. Empty when no project is open. */
  readonly environments: readonly EnvironmentWire[];
  /** The active environment's id, or `undefined` when none is active. */
  readonly activeEnvironmentId: string | undefined;
  /** The project's client keystores, in registry order. Empty when no project is open. */
  readonly keystores: readonly KeystoreWire[];
  /** The project's outgoing WS-Security configurations. Empty when no project is open. */
  readonly wssOutgoing: readonly WssOutgoingWire[];
  /** The project's incoming WS-Security configurations. Empty when no project is open. */
  readonly wssIncoming: readonly WssIncomingWire[];
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
    options?: {
      readonly auth?: { readonly username: string; readonly passwordRef: string };
      readonly useForRequests?: boolean;
    },
    token?: string,
  ) => Promise<InterfaceWire>;
  readonly removeInterface: (interfaceId: string) => Promise<void>;
  readonly updateRequest: (requestId: string, patch: RequestPatchWire) => void;
  /**
   * Merges a patch into one request's §6.3 properties. Applied optimistically (so a checkbox
   * does not lag the click) and then confirmed by main's snapshot. A `null` clears an optional
   * property back to "inherit".
   */
  readonly updateRequestProperties: (requestId: string, patch: RequestPropertiesPatchWire) => void;
  /** Merges a patch into the project's settings (`wirebench.yaml`). */
  readonly updateProjectSettings: (patch: ProjectSettingsPatchWire) => Promise<void>;
  /** Turns the definition cache on or off for one interface. */
  readonly setCacheDefinition: (interfaceId: string, cacheDefinition: boolean) => Promise<void>;
  readonly setEndpoint: (requestId: string, url: string) => void;
  /** Replaces a request's envelope in the mirror ONLY: for changes main has already saved
   * itself (`request.recreate`), where a second `update-request` would just rewrite the file. */
  readonly applyEnvelope: (requestId: string, envelopeXml: string) => void;
  /** Generates another request for the operation, named `Request N`. Returns its id. */
  readonly addRequest: (interfaceId: string, bindingName: string, operationName: string) => Promise<string>;
  /** Copies an existing request, named `<name> (copy)`. Returns the new request's id. */
  readonly cloneRequest: (requestId: string) => Promise<string>;
  /** Deletes a request and closes its open editor tab, if any. */
  readonly removeRequest: (requestId: string) => Promise<void>;
  /** Appends an empty environment and returns its id. */
  readonly addEnvironment: (name: string) => Promise<string>;
  /**
   * Patches one environment. `endpoints`/`properties` REPLACE the whole map (send the complete
   * map you want it to end up with); omit a map to leave it untouched.
   */
  readonly updateEnvironment: (environmentId: string, patch: EnvironmentPatchWire) => Promise<void>;
  readonly removeEnvironment: (environmentId: string) => Promise<void>;
  /** Registers a keystore file (already chosen through `keystores.pickFile`); returns its id. */
  readonly addKeystore: (input: { path: string; name?: string; passwordSecretRef?: string }) => Promise<string>;
  readonly updateKeystore: (keystoreId: string, patch: KeystorePatchWire) => Promise<void>;
  readonly removeKeystore: (keystoreId: string) => Promise<void>;
  /** Creates an empty outgoing WS-Security configuration; returns its id. */
  readonly addWssOutgoing: (input?: { name?: string }) => Promise<string>;
  readonly updateWssOutgoing: (configId: string, patch: WssOutgoingPatchWire) => Promise<void>;
  readonly removeWssOutgoing: (configId: string) => Promise<void>;
  /** Creates an incoming WS-Security configuration with this build's defaults; returns its id. */
  readonly addWssIncoming: (input?: { name?: string }) => Promise<string>;
  readonly updateWssIncoming: (configId: string, patch: WssIncomingPatchWire) => Promise<void>;
  readonly removeWssIncoming: (configId: string) => Promise<void>;
  /** Switches the active environment; `null` deactivates. */
  readonly setActiveEnvironment: (environmentId: string | null) => Promise<void>;
  /** Appends an endpoint to an interface. */
  readonly addEndpoint: (interfaceId: string, name: string, url: string) => Promise<void>;
  /** Renames or re-addresses one endpoint. */
  readonly updateEndpoint: (
    interfaceId: string,
    endpointId: string,
    patch: { readonly name?: string; readonly url?: string; readonly authMode?: 'override' | 'complement' },
  ) => Promise<void>;
  /** Sets (or, with `null`, clears so it inherits) one request's own credentials. */
  readonly updateRequestAuth: (requestId: string, auth: EndpointAuthWire | null) => void;
  /** Sets (or clears) one endpoint's credentials. */
  readonly updateEndpointAuth: (
    interfaceId: string,
    endpointId: string,
    auth: EndpointAuthWire | null,
  ) => Promise<void>;
  /** Sets (or clears) one interface's fallback credentials. */
  readonly updateInterfaceAuth: (interfaceId: string, auth: EndpointAuthWire | null) => Promise<void>;
  readonly removeEndpoint: (interfaceId: string, endpointId: string) => Promise<void>;
  /** Makes one endpoint the interface's default, used by requests that pick none of their own. */
  readonly setDefaultEndpoint: (interfaceId: string, endpointId: string) => Promise<void>;
  readonly setProjectProperty: (name: string, value: string) => Promise<void>;
  readonly removeProjectProperty: (name: string) => Promise<void>;
  /**
   * Attaches a file to a request. Only the path crosses IPC: main stats and reads it, and with
   * `copyToCache` (the default) content-addresses the bytes into the project's `attachments/`
   * folder so the project stays self-contained. Returns the new attachment's id.
   */
  readonly addAttachment: (
    requestId: string,
    path: string,
    options?: { readonly copyToCache?: boolean; readonly contentType?: string },
  ) => Promise<string>;
  /**
   * Merges a patch into one attachment's editable fields. Applied optimistically (so an edited
   * grid cell does not lag the keystroke) and then confirmed by main's snapshot. `part: null`
   * clears the WSDL part binding.
   */
  readonly updateAttachment: (requestId: string, attachmentId: string, patch: AttachmentPatchWire) => void;
  /** Detaches one attachment. Any cached blob is left in place; pruning is a separate action. */
  readonly removeAttachment: (requestId: string, attachmentId: string) => Promise<void>;
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

/**
 * Environment patches applied optimistically but not yet acknowledged by main, keyed by
 * environment id. Re-applied on top of every incoming snapshot for the same reason as
 * {@link pending}: two edits to the same map fired before either IPC round trip resolves must
 * each build from what the other just wrote, not from a stale render-time snapshot.
 */
const pendingEnvironment = new Map<string, EnvironmentPatchWire>();

function withEnvironmentPatch(environment: EnvironmentWire, patch: EnvironmentPatchWire): EnvironmentWire {
  return {
    ...environment,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.endpoints !== undefined ? { endpoints: patch.endpoints } : {}),
    ...(patch.properties !== undefined ? { properties: patch.properties } : {}),
  };
}

/** Applies a properties patch to a mirrored request; `null` clears the property. */
function withPropertiesPatch(request: RequestDraft, patch: RequestPropertiesPatchWire): RequestDraft {
  const properties: Record<string, unknown> = { ...request.properties };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete properties[key];
      continue;
    }
    properties[key] = value;
  }
  return { ...request, properties: properties as unknown as RequestDraft['properties'] };
}

function withPatch(request: RequestDraft, patch: RequestPatchWire): RequestDraft {
  return {
    ...request,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description ?? undefined } : {}),
    ...(patch.envelopeXml !== undefined ? { envelopeXml: patch.envelopeXml } : {}),
    ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
    ...(patch.endpointId !== undefined ? { endpointId: patch.endpointId ?? undefined } : {}),
    ...(patch.endpointUrl !== undefined ? { endpointUrl: patch.endpointUrl ?? undefined } : {}),
    ...(patch.soapAction !== undefined ? { soapAction: patch.soapAction ?? undefined } : {}),
  };
}

/** Applies an attachment patch to a mirrored request; `part: null` clears the WSDL part binding. */
function withAttachmentPatch(request: RequestDraft, attachmentId: string, patch: AttachmentPatchWire): RequestDraft {
  return {
    ...request,
    attachments: request.attachments.map((attachment) =>
      attachment.id !== attachmentId
        ? attachment
        : {
            ...attachment,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.contentType !== undefined ? { contentType: patch.contentType } : {}),
            ...(patch.contentId !== undefined ? { contentId: patch.contentId } : {}),
            ...(patch.type !== undefined ? { type: patch.type } : {}),
            ...(patch.part !== undefined ? { part: patch.part ?? undefined } : {}),
          },
    ),
  };
}

/** Builds the indexes (and environment mirror) the selectors below read. */
function indexesOf(
  project: ProjectWire | null,
): Pick<
  ProjectSnapshot,
  | 'interfaces'
  | 'requests'
  | 'order'
  | 'environments'
  | 'activeEnvironmentId'
  | 'keystores'
  | 'wssOutgoing'
  | 'wssIncoming'
> {
  if (project === null) {
    return {
      interfaces: {},
      requests: {},
      order: [],
      environments: [],
      activeEnvironmentId: undefined,
      keystores: [],
      wssOutgoing: [],
      wssIncoming: [],
    };
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
  const environments = project.environments
    .map((environment) => {
      const patch = pendingEnvironment.get(environment.id);
      return patch === undefined ? environment : withEnvironmentPatch(environment, patch);
    })
    .sort((a, b) => a.order - b.order);
  return {
    interfaces,
    requests,
    order: project.interfaces.map((iface) => iface.id),
    environments,
    activeEnvironmentId: project.activeEnvironmentId,
    keystores: project.keystores,
    wssOutgoing: project.wssOutgoing,
    wssIncoming: project.wssIncoming,
  };
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

  const mutate = async (change: ProjectChange): Promise<ProjectMutateResponse> => {
    const result = await ipc().project.mutate({ change });
    if (!result.ok) {
      throw asError(result.error);
    }
    apply(result.value.project);
    return result.value;
  };

  return {
    project: null,
    interfaces: {},
    requests: {},
    order: [],
    environments: [],
    activeEnvironmentId: undefined,
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
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
      if (!result.ok) {
        // Leave the project dirty: nothing was written, so the pending edit is still only
        // in memory and the caller (`projectActions.save`) needs the thrown error to toast it.
        update((draft) => {
          draft.saveStatus = 'error';
        });
        throw asError(result.error);
      }
      update((draft) => {
        draft.saveStatus = 'saved';
        if (result.value.savedAt !== undefined) {
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
        ...(options?.useForRequests !== undefined ? { useForRequests: options.useForRequests } : {}),
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
      const fail = (message: string): void => {
        // Drop the pending patch and fall back to the last confirmed snapshot so the editor
        // does not keep showing text that was never saved, then surface the failure. Without
        // this, a failed mutate left `pending` set forever and the rejection went unhandled.
        if (pending.get(requestId) === merged) {
          pending.delete(requestId);
        }
        update((draft) => {
          const project = get().project;
          const fresh = project?.requests.find((candidate) => candidate.id === requestId);
          if (fresh !== undefined) {
            const stillPending = pending.get(requestId);
            draft.requests[requestId] = stillPending === undefined ? fresh : withPatch(fresh, stillPending);
          }
        });
        showToast(message);
      };
      void ipc()
        .project.mutate({ change: { kind: 'update-request', requestId, patch } })
        .then((result) => {
          // Apply first, drop the pending patch second: the reply already contains this edit,
          // but a snapshot that crossed a later keystroke does not, and the patch covers it.
          if (result.ok) {
            apply(result.value.project);
            if (pending.get(requestId) === merged) {
              pending.delete(requestId);
            }
            return;
          }
          fail(asError(result.error).message);
        })
        .catch((error: unknown) => {
          fail(error instanceof Error ? error.message : 'Could not save the change');
        });
    },

    applyEnvelope: (requestId, envelopeXml) => {
      update((draft) => {
        const request = draft.requests[requestId];
        if (request !== undefined) {
          draft.requests[requestId] = { ...request, envelopeXml };
        }
      });
    },

    setEndpoint: (requestId, url) => {
      get().updateRequest(requestId, { endpointUrl: url });
    },

    addRequest: async (interfaceId, bindingName, operationName) => {
      const { createdRequestId: created } = await mutate({
        kind: 'add-request',
        interfaceId,
        bindingName,
        operationName,
      });
      if (created === undefined) {
        throw new Error('add-request did not return a request id');
      }
      return created;
    },

    cloneRequest: async (requestId) => {
      const { createdRequestId: created } = await mutate({ kind: 'clone-request', requestId });
      if (created === undefined) {
        throw new Error('clone-request did not return a request id');
      }
      return created;
    },

    addEndpoint: async (interfaceId, name, url) => {
      await mutate({ kind: 'add-endpoint', interfaceId, name, url });
    },

    updateEndpoint: async (interfaceId, endpointId, patch) => {
      await mutate({ kind: 'update-endpoint', interfaceId, endpointId, patch });
    },

    updateRequestAuth: (requestId, auth) => {
      // Fire-and-report like the other request edits: the inspector must stay responsive, and
      // a rejected mutation surfaces as a toast rather than an unhandled rejection.
      void mutate({ kind: 'update-request-auth', requestId, auth }).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Could not update the request credentials');
      });
    },

    updateEndpointAuth: async (interfaceId, endpointId, auth) => {
      await mutate({ kind: 'update-endpoint-auth', interfaceId, endpointId, auth });
    },

    updateInterfaceAuth: async (interfaceId, auth) => {
      await mutate({ kind: 'update-interface-auth', interfaceId, auth });
    },

    removeEndpoint: async (interfaceId, endpointId) => {
      await mutate({ kind: 'remove-endpoint', interfaceId, endpointId });
    },

    setDefaultEndpoint: async (interfaceId, endpointId) => {
      await mutate({ kind: 'set-default-endpoint', interfaceId, endpointId });
    },

    removeRequest: async (requestId) => {
      await mutate({ kind: 'remove-request', requestId });
      pending.delete(requestId);
      useEditorsStore.getState().close(`request:${requestId}`);
      useExchangesStore.getState().clearRequest(requestId);
    },

    addEnvironment: async (name) => {
      const { createdEnvironmentId } = await mutate({ kind: 'add-environment', name });
      if (createdEnvironmentId === undefined) {
        throw new Error('add-environment did not return an environment id');
      }
      return createdEnvironmentId;
    },

    updateEnvironment: async (environmentId, patch) => {
      // Applied locally first (and merged with any still-pending patch) so a second commit
      // fired before the first round trip resolves builds on top of both edits, not just the
      // render-time snapshot; see `withEnvironmentPatch`/`pendingEnvironment` above.
      const existing = pendingEnvironment.get(environmentId);
      const merged: EnvironmentPatchWire = { ...existing, ...patch };
      pendingEnvironment.set(environmentId, merged);
      update((draft) => {
        const index = draft.environments.findIndex((candidate) => candidate.id === environmentId);
        const current = index === -1 ? undefined : draft.environments[index];
        if (index !== -1 && current !== undefined) {
          draft.environments[index] = withEnvironmentPatch(current, patch);
        }
      });
      try {
        await mutate({ kind: 'update-environment', environmentId, patch });
        if (pendingEnvironment.get(environmentId) === merged) {
          pendingEnvironment.delete(environmentId);
        }
      } catch (error) {
        // Drop the pending patch and fall back to the last confirmed snapshot, same recovery
        // as `updateRequest.fail` — otherwise a failed mutate leaves `pendingEnvironment` set
        // forever and the mirror keeps showing an edit that was never saved.
        if (pendingEnvironment.get(environmentId) === merged) {
          pendingEnvironment.delete(environmentId);
        }
        update((draft) => {
          const project = get().project;
          const fresh = project?.environments.find((candidate) => candidate.id === environmentId);
          if (fresh !== undefined) {
            const index = draft.environments.findIndex((candidate) => candidate.id === environmentId);
            const stillPending = pendingEnvironment.get(environmentId);
            const resolved = stillPending === undefined ? fresh : withEnvironmentPatch(fresh, stillPending);
            if (index === -1) {
              draft.environments.push(resolved);
            } else {
              draft.environments[index] = resolved;
            }
          }
        });
        throw error;
      }
    },

    removeEnvironment: async (environmentId) => {
      await mutate({ kind: 'remove-environment', environmentId });
    },

    addKeystore: async (input) => {
      const { createdKeystoreId } = await mutate({
        kind: 'add-keystore',
        path: input.path,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.passwordSecretRef !== undefined ? { passwordSecretRef: input.passwordSecretRef } : {}),
      });
      if (createdKeystoreId === undefined) {
        throw new Error('add-keystore did not return a keystore id');
      }
      return createdKeystoreId;
    },

    updateKeystore: async (keystoreId, patch) => {
      await mutate({ kind: 'update-keystore', keystoreId, patch });
    },

    removeKeystore: async (keystoreId) => {
      await mutate({ kind: 'remove-keystore', keystoreId });
    },

    addWssOutgoing: async (input) => {
      const { createdWssOutgoingId } = await mutate({
        kind: 'add-wss-outgoing',
        ...(input?.name !== undefined ? { name: input.name } : {}),
      });
      if (createdWssOutgoingId === undefined) {
        throw new Error('add-wss-outgoing did not return a configuration id');
      }
      return createdWssOutgoingId;
    },

    updateWssOutgoing: async (configId, patch) => {
      await mutate({ kind: 'update-wss-outgoing', configId, patch });
    },

    removeWssOutgoing: async (configId) => {
      await mutate({ kind: 'remove-wss-outgoing', configId });
    },

    addWssIncoming: async (input) => {
      const { createdWssIncomingId } = await mutate({
        kind: 'add-wss-incoming',
        ...(input?.name !== undefined ? { name: input.name } : {}),
      });
      if (createdWssIncomingId === undefined) {
        throw new Error('add-wss-incoming did not return a configuration id');
      }
      return createdWssIncomingId;
    },

    updateWssIncoming: async (configId, patch) => {
      await mutate({ kind: 'update-wss-incoming', configId, patch });
    },

    removeWssIncoming: async (configId) => {
      await mutate({ kind: 'remove-wss-incoming', configId });
    },

    setActiveEnvironment: async (environmentId) => {
      await mutate({ kind: 'set-active-environment', environmentId });
    },

    updateRequestProperties: (requestId, patch) => {
      update((draft) => {
        const request = draft.requests[requestId];
        if (request !== undefined) {
          draft.requests[requestId] = withPropertiesPatch(request, patch);
        }
      });
      void ipc()
        .project.mutate({ change: { kind: 'update-request-properties', requestId, patch } })
        .then((result) => {
          if (result.ok) {
            apply(result.value.project);
            return;
          }
          // Fall back to the last confirmed snapshot: the optimistic edit was never saved.
          apply(get().project);
          showToast(asError(result.error).message);
        })
        .catch((error: unknown) => {
          apply(get().project);
          showToast(error instanceof Error ? error.message : 'Could not save the change');
        });
    },

    updateProjectSettings: async (patch) => {
      await mutate({ kind: 'update-project-settings', patch });
    },

    setCacheDefinition: async (interfaceId, cacheDefinition) => {
      await mutate({ kind: 'update-interface', interfaceId, patch: { cacheDefinition } });
    },

    setProjectProperty: async (name, value) => {
      await mutate({ kind: 'set-project-property', name, value });
    },

    removeProjectProperty: async (name) => {
      await mutate({ kind: 'remove-project-property', name });
    },

    addAttachment: async (requestId, path, options) => {
      const { createdAttachmentId } = await mutate({
        kind: 'add-attachment',
        requestId,
        path,
        copyToCache: options?.copyToCache ?? true,
        ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}),
      });
      if (createdAttachmentId === undefined) {
        throw new Error('add-attachment did not return an attachment id');
      }
      return createdAttachmentId;
    },

    updateAttachment: (requestId, attachmentId, patch) => {
      update((draft) => {
        const request = draft.requests[requestId];
        if (request !== undefined) {
          draft.requests[requestId] = withAttachmentPatch(request, attachmentId, patch);
        }
      });
      void ipc()
        .project.mutate({ change: { kind: 'update-attachment', requestId, attachmentId, patch } })
        .then((result) => {
          if (result.ok) {
            apply(result.value.project);
            return;
          }
          // Fall back to the last confirmed snapshot: the optimistic edit was never saved.
          apply(get().project);
          showToast(asError(result.error).message);
        })
        .catch((error: unknown) => {
          apply(get().project);
          showToast(error instanceof Error ? error.message : 'Could not save the change');
        });
    },

    removeAttachment: async (requestId, attachmentId) => {
      await mutate({ kind: 'remove-attachment', requestId, attachmentId });
    },
  };
});

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

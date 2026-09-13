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
  WsaConfigWire,
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
  ProjectAddInterfaceTarget,
  ProjectWire,
  RequestPatchWire,
  RequestPropertiesPatchWire,
  RequestWire,
  ApiPatchWire,
  RestApiWire,
  RestFolderPatchWire,
  RestFolderWire,
  RestRequestPatchWire,
  RestRequestWire,
} from '../../shared/wire-types.js';
import type { ExplorerRestData } from '../features/explorer/tree-nodes.js';
import { useDraftsStore } from './drafts.js';
import { useInterfaceEditorStore } from '../features/interface-editor/interface-editor-state.js';
import { useEditorsStore } from './editors.js';
import { useExchangesStore } from './exchanges.js';
import { ipc } from './ipc-client.js';
import { useUiStore } from './ui.js';

/**
 * One request as the renderer sees it. Historically an in-memory draft; since Task 21 it is
 * a mirror of the request saved on disk, hence the alias rather than a separate shape.
 */
export type RequestDraft = RequestWire;

/** Whether an explicit or automatic save is currently running. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** One keystore (or WS-Security configuration) tagged with the project it belongs to. */
export type OfProject<T> = T & { readonly projectId: string };

/** The interfaces of one project, in project order — what the explorer's tree iterates. */
export interface ProjectOrder {
  readonly projectId: string;
  readonly interfaceIds: string[];
}

/** The renderer's read-only mirror of every project open in the workspace. */
export interface ProjectSnapshot {
  /** Every open project by id. Empty when no workspace is open. */
  readonly projects: Readonly<Record<string, ProjectWire>>;
  /** Interfaces by id, flattened across every open project. */
  readonly interfaces: Record<string, InterfaceWire>;
  /** Requests by id, flattened across every open project. */
  readonly requests: Record<string, RequestDraft>;
  /** REST APIs by id, flattened across every open project. */
  readonly apis: Record<string, RestApiWire>;
  /** REST folders by id, flattened across every open project. */
  readonly folders: Record<string, RestFolderWire>;
  /** REST requests by id, flattened across every open project. */
  readonly restRequests: Record<string, RestRequestWire>;
  /**
   * Each project's REST lists, kept per project because that is how the explorer reads them: one
   * root's children come from exactly one project.
   */
  readonly rest: Readonly<Record<string, ExplorerRestData>>;
  /** Project order, and each project's interface ids in its own order. */
  readonly order: readonly ProjectOrder[];
  /**
   * Which project owns an entity — project, interface, request, environment, keystore or
   * WS-Security configuration id. This is what lets an action the renderer addresses at an
   * entity be routed to the right project without the caller having to know which one it is.
   */
  readonly projectOf: Readonly<Record<string, string>>;
  /** Every project's client keystores, each tagged with its project. */
  readonly keystores: readonly OfProject<KeystoreWire>[];
  /** Every project's outgoing WS-Security configurations, each tagged with its project. */
  readonly wssOutgoing: readonly OfProject<WssOutgoingWire>[];
  /** Every project's incoming WS-Security configurations, each tagged with its project. */
  readonly wssIncoming: readonly OfProject<WssIncomingWire>[];
  /** Save state per project: a save is per project, and so is its failure. */
  readonly saveStatus: Readonly<Record<string, SaveStatus>>;
  /** Paths the folder watcher reported per project, since that project's banner was dismissed. */
  readonly changedOnDisk: Readonly<Record<string, readonly string[]>>;
}

/** The project store: {@link ProjectSnapshot} plus the actions that drive main. */
export interface ProjectStore extends ProjectSnapshot {
  /**
   * Applies one project's snapshot (`project.changed`, and every action's reply). A `null`
   * project removes it from the mirror — the other projects are untouched.
   */
  readonly applySnapshot: (projectId: string, project: ProjectWire | null) => void;
  /** Empties the mirror. Called by `useWorkspaceStore.applySnapshot(null)`. */
  readonly reset: () => void;
  /** Re-reads one project's folder from disk, discarding its unsaved in-memory changes. */
  readonly reloadProject: (projectId: string) => Promise<void>;
  /** Re-pulls one project's snapshot from main. */
  readonly refresh: (projectId: string) => Promise<void>;
  /** Saves one project, or — with no id — every open project. */
  readonly save: (projectId?: string) => Promise<void>;
  readonly noteChangedOnDisk: (projectId: string, paths: readonly string[]) => void;
  readonly dismissChangedOnDisk: (projectId: string) => void;
  /**
   * Imports a WSDL. `target` names the project it lands in, or asks for a project to be
   * created for it — importing into an empty workspace is one gesture, not two.
   */
  readonly importDefinition: (
    target: ProjectAddInterfaceTarget,
    source: ImportSourceWire,
    options?: {
      readonly auth?: { readonly username: string; readonly passwordRef: string };
      readonly useForRequests?: boolean;
    },
    token?: string,
  ) => Promise<InterfaceWire>;
  readonly removeInterface: (interfaceId: string) => Promise<void>;
  /**
   * Writes a request edit straight through to main, which autosaves it. For edits made outside
   * an editor tab — renaming from the explorer tree, naming a request as it is created — where
   * there is no tab to carry an unsaved mark or to press `Mod+S` in.
   */
  readonly updateRequest: (requestId: string, patch: RequestPatchWire) => void;
  /**
   * Stages an edit made *in an editor tab*: applied to the mirror at once, so the editor and
   * the send path see it immediately, but not written until {@link saveRequest}. This is what
   * makes a tab's unsaved mark meaningful.
   */
  readonly editRequest: (requestId: string, patch: RequestPatchWire) => void;
  /**
   * Sends one request's staged edits to main without writing the project, so anything main
   * derives from its own model sees them. Returns false when the mutation failed, leaving the
   * draft in place. A no-op (true) when the request is clean.
   */
  readonly commitRequest: (requestId: string) => Promise<boolean>;
  /** Writes one request's staged edits and saves its project. A no-op when it is clean. */
  readonly saveRequest: (requestId: string) => Promise<void>;
  /**
   * Merges a patch into one request's §6.3 properties. Applied optimistically (so a checkbox
   * does not lag the click) and then confirmed by main's snapshot. A `null` clears an optional
   * property back to "inherit".
   */
  readonly updateRequestProperties: (requestId: string, patch: RequestPropertiesPatchWire) => void;
  /** Merges a patch into one project's settings (`wirebench.yaml`). */
  readonly updateProjectSettings: (projectId: string, patch: ProjectSettingsPatchWire) => Promise<void>;
  /** Renames one project. The folder keeps its slug; only the name in `wirebench.yaml` changes. */
  readonly renameProject: (projectId: string, name: string) => Promise<void>;
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
  /** Adds a REST API to one project and returns its id. */
  readonly addApi: (projectId: string, name: string, baseUrl?: string) => Promise<string>;
  readonly updateApi: (apiId: string, patch: ApiPatchWire) => Promise<void>;
  /** Deletes an API with everything inside it, and closes the tabs that named any of it. */
  readonly removeApi: (apiId: string) => Promise<void>;
  /** Adds a folder at an API's root, or inside `parentId`. Returns the new folder's id. */
  readonly addFolder: (apiId: string, parentId: string | undefined, name: string) => Promise<string>;
  readonly updateFolder: (folderId: string, patch: RestFolderPatchWire) => Promise<void>;
  readonly removeFolder: (folderId: string) => Promise<void>;
  /** Adds a REST request to an API or one of its folders. Returns the new request's id. */
  readonly addRestRequest: (apiId: string, parentId?: string, name?: string) => Promise<string>;
  /**
   * Writes one REST request's edit straight through to main, which autosaves it. For edits made
   * outside an editor tab — renaming from the tree, naming a request as it is created.
   */
  readonly updateRestRequest: (requestId: string, patch: RestRequestPatchWire) => Promise<void>;
  /**
   * Stages an edit made *in the REST editor*: applied to the mirror at once, so the editor and the
   * send path see it immediately, but not written until {@link saveRestRequest}. This is what makes
   * the tab's unsaved dot mean something.
   */
  readonly editRestRequest: (requestId: string, patch: RestRequestPatchWire) => void;
  /**
   * Sends one REST request's staged edits to main without writing the project, so anything main
   * derives from its own model sees them. False when the mutation failed, leaving the draft.
   */
  readonly commitRestRequest: (requestId: string) => Promise<boolean>;
  /** Writes one REST request's staged edits and saves its project. A no-op when it is clean. */
  readonly saveRestRequest: (requestId: string) => Promise<void>;
  readonly removeRestRequest: (requestId: string) => Promise<void>;
  /** Copies a REST request beside the original; returns the copy's id. */
  readonly cloneRestRequest: (requestId: string) => Promise<string>;
  /**
   * Moves an API, a folder or a REST request to `index` inside `parentId` (the API's root when
   * absent). What a drag-and-drop in the explorer commits.
   */
  readonly moveNode: (nodeId: string, parentId: string | undefined, index: number) => Promise<void>;
  /** Appends an empty environment to one project and returns its id. */
  readonly addEnvironment: (projectId: string, name: string) => Promise<string>;
  /**
   * Patches one project environment. `endpoints`/`properties` REPLACE the whole map (send the
   * complete map you want it to end up with); omit a map to leave it untouched.
   */
  readonly updateEnvironment: (projectId: string, environmentId: string, patch: EnvironmentPatchWire) => Promise<void>;
  readonly removeEnvironment: (projectId: string, environmentId: string) => Promise<void>;
  /** Registers a keystore file (already chosen through `keystores.pickFile`); returns its id. */
  readonly addKeystore: (
    projectId: string,
    input: { path: string; name?: string; passwordSecretRef?: string },
  ) => Promise<string>;
  readonly updateKeystore: (keystoreId: string, patch: KeystorePatchWire) => Promise<void>;
  readonly removeKeystore: (keystoreId: string) => Promise<void>;
  /** Creates an empty outgoing WS-Security configuration; returns its id. */
  readonly addWssOutgoing: (projectId: string, input?: { name?: string }) => Promise<string>;
  readonly updateWssOutgoing: (configId: string, patch: WssOutgoingPatchWire) => Promise<void>;
  readonly removeWssOutgoing: (configId: string) => Promise<void>;
  /** Creates an incoming WS-Security configuration with this build's defaults; returns its id. */
  readonly addWssIncoming: (projectId: string, input?: { name?: string }) => Promise<string>;
  readonly updateWssIncoming: (configId: string, patch: WssIncomingPatchWire) => Promise<void>;
  readonly removeWssIncoming: (configId: string) => Promise<void>;
  /** Appends an endpoint to an interface. */
  readonly addEndpoint: (interfaceId: string, name: string, url: string) => Promise<void>;
  /** Renames or re-addresses one endpoint. */
  readonly updateEndpoint: (
    interfaceId: string,
    endpointId: string,
    patch: {
      readonly name?: string;
      readonly url?: string;
      readonly authMode?: 'override' | 'complement';
      /** Send to this endpoint even when its certificate does not verify. */
      readonly trustInvalid?: boolean;
    },
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
  /** Sets (`null` clears, back to "inherit") one request's own WS-Addressing overrides. */
  readonly updateRequestWsa: (requestId: string, wsa: WsaConfigWire | null) => void;
  /** Sets the interface-level WS-Addressing defaults every request of it inherits. */
  readonly updateInterfaceWsa: (interfaceId: string, wsa: WsaConfigWire) => Promise<void>;
  readonly removeEndpoint: (interfaceId: string, endpointId: string) => Promise<void>;
  /** Makes one endpoint the interface's default, used by requests that pick none of their own. */
  readonly setDefaultEndpoint: (interfaceId: string, endpointId: string) => Promise<void>;
  readonly setProjectProperty: (projectId: string, name: string, value: string) => Promise<void>;
  readonly removeProjectProperty: (projectId: string, name: string) => Promise<void>;
  /** Toggles one project property's disabled flag without removing it. */
  readonly setProjectPropertyEnabled: (projectId: string, name: string, enabled: boolean) => Promise<void>;
  /** Switches a project's active environment; `null` deactivates. Mirrors the workspace's own. */
  readonly setActiveEnvironment: (projectId: string, environmentId: string | null) => Promise<void>;
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

/** Every index {@link ProjectSnapshot} exposes, rebuilt from the whole project map. */
type Indexes = Pick<
  ProjectSnapshot,
  | 'interfaces'
  | 'requests'
  | 'apis'
  | 'folders'
  | 'restRequests'
  | 'rest'
  | 'order'
  | 'projectOf'
  | 'keystores'
  | 'wssOutgoing'
  | 'wssIncoming'
>;

/**
 * Rebuilds the flattened indexes from every open project.
 *
 * Rebuilt wholesale rather than patched per project: the indexes are keyed by entity id across
 * projects, so removing one project means removing exactly its entries — and recomputing is
 * both shorter and impossible to get subtly wrong.
 */
/** One request's staged-but-unsaved patch, or `undefined` when the request is clean. */
function draftPatchOf(requestId: string): RequestPatchWire | undefined {
  return useDraftsStore.getState().peekRequest(requestId);
}

/** One REST request's staged-but-unsaved patch, or `undefined` when it is clean. */
function restDraftPatchOf(requestId: string): RestRequestPatchWire | undefined {
  return useDraftsStore.getState().peekRestRequest(requestId);
}

/**
 * A mirrored REST request with its staged edit laid over it, for the same reason its SOAP
 * counterpart gets one: a snapshot from main reflects only what has been written, and replacing
 * the mirror wholesale would throw away what the user has typed and not yet saved.
 *
 * Tables, the body and the settings are replaced rather than merged — an absent setting means
 * *inherit*, so merging could never turn one back off.
 */
export function layerRestEdits(
  request: RestRequestWire,
  draftPatch: RestRequestPatchWire | undefined,
): RestRequestWire {
  if (draftPatch === undefined) {
    return request;
  }
  return {
    ...request,
    ...(draftPatch.name !== undefined ? { name: draftPatch.name } : {}),
    ...(draftPatch.description !== undefined ? { description: draftPatch.description ?? undefined } : {}),
    ...(draftPatch.method !== undefined ? { method: draftPatch.method } : {}),
    ...(draftPatch.url !== undefined ? { url: draftPatch.url } : {}),
    ...(draftPatch.pathParams !== undefined ? { pathParams: draftPatch.pathParams } : {}),
    ...(draftPatch.query !== undefined ? { query: draftPatch.query } : {}),
    ...(draftPatch.headers !== undefined ? { headers: draftPatch.headers } : {}),
    ...(draftPatch.body !== undefined ? { body: draftPatch.body } : {}),
    ...(draftPatch.auth !== undefined ? { auth: draftPatch.auth } : {}),
    ...(draftPatch.settings !== undefined ? { settings: draftPatch.settings } : {}),
  };
}

/**
 * Lays the edits main has not confirmed yet over the request it just sent us.
 *
 * A snapshot from main reflects only what has been *written*, so replacing the mirror with it
 * wholesale would throw away two kinds of edit: one still in flight (`pending`) and one the
 * user has deliberately not saved yet (`draft`). Both are re-applied on every snapshot, drafts
 * last, because a staged edit is the most recent thing the user typed.
 */
export function layerEdits(
  request: RequestDraft,
  pendingPatch: RequestPatchWire | undefined,
  draftPatch: RequestPatchWire | undefined,
): RequestDraft {
  let merged = request;
  if (pendingPatch !== undefined) {
    merged = withPatch(merged, pendingPatch);
  }
  if (draftPatch !== undefined) {
    merged = withPatch(merged, draftPatch);
  }
  return merged;
}

function indexesOf(projects: Readonly<Record<string, ProjectWire>>): Indexes {
  const interfaces: Record<string, InterfaceWire> = {};
  const requests: Record<string, RequestDraft> = {};
  const apis: Record<string, RestApiWire> = {};
  const folders: Record<string, RestFolderWire> = {};
  const restRequests: Record<string, RestRequestWire> = {};
  const rest: Record<string, ExplorerRestData> = {};
  const projectOf: Record<string, string> = {};
  const order: ProjectOrder[] = [];
  const keystores: OfProject<KeystoreWire>[] = [];
  const wssOutgoing: OfProject<WssOutgoingWire>[] = [];
  const wssIncoming: OfProject<WssIncomingWire>[] = [];

  for (const project of Object.values(projects)) {
    projectOf[project.id] = project.id;
    for (const iface of project.interfaces) {
      interfaces[iface.id] = iface;
      projectOf[iface.id] = project.id;
    }
    for (const request of project.requests) {
      requests[request.id] = layerEdits(request, pending.get(request.id), draftPatchOf(request.id));
      projectOf[request.id] = project.id;
    }
    for (const api of project.apis) {
      apis[api.id] = api;
      projectOf[api.id] = project.id;
    }
    for (const folder of project.folders) {
      folders[folder.id] = folder;
      projectOf[folder.id] = project.id;
    }
    for (const request of project.restRequests) {
      restRequests[request.id] = layerRestEdits(request, restDraftPatchOf(request.id));
      projectOf[request.id] = project.id;
    }
    rest[project.id] = {
      apis: project.apis,
      folders: project.folders,
      requests: project.restRequests.map((request) => restRequests[request.id] ?? request),
    };
    for (const environment of project.environments) {
      projectOf[environment.id] = project.id;
    }
    for (const keystore of project.keystores) {
      keystores.push({ ...keystore, projectId: project.id });
      projectOf[keystore.id] = project.id;
    }
    for (const config of project.wssOutgoing) {
      wssOutgoing.push({ ...config, projectId: project.id });
      projectOf[config.id] = project.id;
    }
    for (const config of project.wssIncoming) {
      wssIncoming.push({ ...config, projectId: project.id });
      projectOf[config.id] = project.id;
    }
    order.push({ projectId: project.id, interfaceIds: project.interfaces.map((iface) => iface.id) });
  }
  // Projects are ordered by name so the explorer's tree does not reshuffle on every snapshot
  // (object key order follows insertion, which follows whichever project replied last).
  order.sort((a, b) => (projects[a.projectId]?.name ?? '').localeCompare(projects[b.projectId]?.name ?? ''));
  return {
    interfaces,
    requests,
    apis,
    folders,
    restRequests,
    rest,
    order,
    projectOf,
    keystores,
    wssOutgoing,
    wssIncoming,
  };
}

/**
 * The last patched copy handed out per environment object, with the patch it was built from.
 * An environment with a pending patch must come back as the *same* object on every read until
 * the patch or the environment changes — a selector returning a fresh object each call would
 * make every `useProjectStore(selectEnvironment…)` consumer rerender forever.
 */
const patchedEnvironments = new WeakMap<
  EnvironmentWire,
  { readonly patch: EnvironmentPatchWire; readonly result: EnvironmentWire }
>();

/** `environment` with its still-unacknowledged patch (if any) applied; referentially stable. */
function withPendingPatch(environment: EnvironmentWire): EnvironmentWire {
  const patch = pendingEnvironment.get(environment.id);
  if (patch === undefined) {
    return environment;
  }
  const cached = patchedEnvironments.get(environment);
  if (cached?.patch === patch) {
    return cached.result;
  }
  const result = withEnvironmentPatch(environment, patch);
  patchedEnvironments.set(environment, { patch, result });
  return result;
}

/**
 * One environment by id, wherever in the open projects it lives, with any optimistic edit
 * applied. A selector rather than store state: environments are per project now, and only the
 * project environment editor still reads them (the workspace's own live in `useWorkspaceStore`).
 */
export function selectEnvironment(state: ProjectSnapshot, environmentId: string): EnvironmentWire | undefined {
  const projectId = state.projectOf[environmentId];
  const environment =
    projectId === undefined
      ? undefined
      : state.projects[projectId]?.environments.find((candidate) => candidate.id === environmentId);
  return environment === undefined ? undefined : withPendingPatch(environment);
}

/** One project's environments in `order`, optimistic edits applied. Not for use as a hook selector. */
export function selectProjectEnvironments(state: ProjectSnapshot, projectId: string): readonly EnvironmentWire[] {
  return (state.projects[projectId]?.environments ?? []).map(withPendingPatch).sort((a, b) => a.order - b.order);
}

/** One REST request by id, with its staged edit applied. */
export function selectRestRequest(state: ProjectSnapshot, requestId: string): RestRequestWire | undefined {
  return state.restRequests[requestId];
}

/** The API a REST request, folder or API id belongs to. */
export function selectApiOf(state: ProjectSnapshot, entityId: string): RestApiWire | undefined {
  const apiId = state.apis[entityId]?.id ?? state.folders[entityId]?.apiId ?? state.restRequests[entityId]?.apiId;
  return apiId === undefined ? undefined : state.apis[apiId];
}

/**
 * The folders from an API's root down to `folderId`, outermost first — what a breadcrumb shows and
 * what the credentials chain climbs.
 *
 * Takes the folder map rather than the whole store so a component can `useMemo` it: the result is a
 * fresh array, and a zustand selector that built one on every call would rerender forever.
 */
export function folderChainOf(
  folders: Readonly<Record<string, RestFolderWire>>,
  folderId: string | undefined,
): readonly RestFolderWire[] {
  const chain: RestFolderWire[] = [];
  // Bounded by the folder count: a cycle on disk would otherwise loop here forever.
  const seen = new Set<string>();
  let at = folderId;
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const folder = folders[at];
    if (folder === undefined) {
      break;
    }
    chain.unshift(folder);
    at = folder.parentId;
  }
  return chain;
}

/** The folders a REST request sits in, outermost first. Empty for a request at the API's root. */
export function selectFolderChain(state: ProjectSnapshot, requestId: string): readonly RestFolderWire[] {
  return folderChainOf(state.folders, state.restRequests[requestId]?.folderId);
}

const EMPTY: ProjectSnapshot = {
  projects: {},
  interfaces: {},
  requests: {},
  apis: {},
  folders: {},
  restRequests: {},
  rest: {},
  order: [],
  projectOf: {},
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
  saveStatus: {},
  changedOnDisk: {},
};

export const useProjectStore = create<ProjectStore>((set, get) => {
  const update = (recipe: Mutate): void => {
    set((state) => produce(state, recipe));
  };

  /** Replaces one project in the mirror (or, with `null`, removes it) and rebuilds the indexes. */
  const apply = (projectId: string, project: ProjectWire | null): void => {
    set((state) => {
      const projects = { ...state.projects };
      if (project !== null) {
        projects[project.id] = project;
        return { ...state, projects, ...indexesOf(projects) };
      }
      // A removed project takes its per-project state and its unacknowledged patches with it.
      const removed = projects[projectId];
      for (const request of removed?.requests ?? []) {
        pending.delete(request.id);
      }
      for (const environment of removed?.environments ?? []) {
        pendingEnvironment.delete(environment.id);
      }
      delete projects[projectId];
      const saveStatus = { ...state.saveStatus };
      delete saveStatus[projectId];
      const changedOnDisk = { ...state.changedOnDisk };
      delete changedOnDisk[projectId];
      return { ...state, projects, saveStatus, changedOnDisk, ...indexesOf(projects) };
    });
  };

  /**
   * The project owning `entityId`. Throws rather than silently doing nothing: an action
   * addressed at an entity no open project holds is a renderer bug, and a no-op would hide it.
   */
  const ownerOf = (entityId: string): string => {
    const projectId = get().projectOf[entityId];
    if (projectId === undefined) {
      throw new Error(`No open project holds "${entityId}"`);
    }
    return projectId;
  };

  /**
   * Bumped by `reset()`. A mutation reply that lands after the workspace closed belongs to a
   * project that is gone, and applying it would put that project back into an empty mirror.
   */
  let generation = 0;

  const mutate = async (projectId: string, change: ProjectChange): Promise<ProjectMutateResponse> => {
    const sentIn = generation;
    const result = await ipc().project.mutate({ projectId, change });
    if (!result.ok) {
      throw asError(result.error);
    }
    if (sentIn === generation) {
      apply(projectId, result.value.project);
    }
    return result.value;
  };

  /** `mutate`, for a change addressed at an entity rather than at a project. */
  const mutateEntity = async (entityId: string, change: ProjectChange): Promise<ProjectMutateResponse> =>
    await mutate(ownerOf(entityId), change);

  /**
   * Drops everything the renderer kept for a REST request that no longer exists: its tab, its
   * unsaved draft and its cached response. A draft left behind would keep the workspace looking
   * unsaved with nothing left to save.
   */
  const forgetRestRequest = (requestId: string): void => {
    useDraftsStore.getState().discardRestRequest(requestId);
    useEditorsStore.getState().close(`rest:${requestId}`);
    useExchangesStore.getState().clearRequest(requestId);
  };

  /** Saves one project, reporting its own status. */
  const saveOne = async (projectId: string): Promise<void> => {
    update((draft) => {
      draft.saveStatus[projectId] = 'saving';
    });
    const result = await ipc().project.save({ projectId });
    if (!result.ok) {
      // Leave the project dirty: nothing was written, so the pending edit is still only in
      // memory and the caller needs the thrown error to toast it.
      update((draft) => {
        draft.saveStatus[projectId] = 'error';
      });
      throw asError(result.error);
    }
    update((draft) => {
      draft.saveStatus[projectId] = 'saved';
    });
  };

  return {
    ...EMPTY,

    applySnapshot: apply,

    reset: () => {
      generation += 1;
      pending.clear();
      pendingEnvironment.clear();
      set((state) => ({ ...state, ...EMPTY }));
    },

    reloadProject: async (projectId) => {
      const result = await ipc().project.reload({ projectId });
      if (!result.ok) {
        throw asError(result.error);
      }
      pending.clear();
      apply(projectId, result.value.project);
      update((draft) => {
        draft.changedOnDisk[projectId] = [];
      });
    },

    refresh: async (projectId) => {
      const result = await ipc().project.snapshot({ projectId });
      if (result.ok) {
        apply(projectId, result.value.project);
      }
    },

    save: async (projectId) => {
      const ids = projectId === undefined ? Object.keys(get().projects) : [projectId];
      // Staged edits are part of this save. Without committing them first, "Save All" writes
      // main's model — which has never seen them — and every unsaved request edit is silently
      // left behind with its tab still marked. Sequentially, because each commit mutates main
      // and applies the snapshot it returns.
      for (const requestId of useDraftsStore.getState().dirtyRequestIds()) {
        if (ids.includes(get().projectOf[requestId] ?? '')) {
          await get().commitRequest(requestId);
        }
      }
      // Every project is saved even when one fails, and the first failure is what the caller
      // hears about: a failed save on one project must not leave the others unwritten.
      const results = await Promise.allSettled(ids.map(async (id) => await saveOne(id)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed !== undefined && failed.status === 'rejected') {
        throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
      }
    },

    noteChangedOnDisk: (projectId, paths) => {
      update((draft) => {
        draft.changedOnDisk[projectId] = [...new Set([...(draft.changedOnDisk[projectId] ?? []), ...paths])];
      });
    },

    dismissChangedOnDisk: (projectId) => {
      update((draft) => {
        draft.changedOnDisk[projectId] = [];
      });
    },

    importDefinition: async (target, source, options, token) => {
      const result = await ipc().project.addInterface({
        target,
        source,
        ...(options?.auth !== undefined ? { auth: options.auth } : {}),
        ...(options?.useForRequests !== undefined ? { useForRequests: options.useForRequests } : {}),
        ...(token !== undefined ? { token } : {}),
      });
      if (!result.ok) {
        throw asError(result.error);
      }
      apply(result.value.projectId, result.value.project);
      const added = get().interfaces[result.value.interfaceId];
      if (added === undefined) {
        throw new Error(`import returned an unknown interface: ${result.value.interfaceId}`);
      }
      return added;
    },

    removeInterface: async (interfaceId) => {
      await mutateEntity(interfaceId, { kind: 'remove-interface', interfaceId });
      // The Interface editor caches this definition's documents, texts and schema index; none
      // of it outlives the interface itself.
      useInterfaceEditorStore.getState().forget(interfaceId);
    },

    updateRequest: (requestId, patch) => {
      // Applied locally first so typing stays smooth, then merged with whatever main replies.
      const projectId = ownerOf(requestId);
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
          const fresh = get().projects[projectId]?.requests.find((candidate) => candidate.id === requestId);
          if (fresh !== undefined) {
            const stillPending = pending.get(requestId);
            draft.requests[requestId] = stillPending === undefined ? fresh : withPatch(fresh, stillPending);
          }
        });
        showToast(message);
      };
      void ipc()
        .project.mutate({ projectId, change: { kind: 'update-request', requestId, patch } })
        .then((result) => {
          // Apply first, drop the pending patch second: the reply already contains this edit,
          // but a snapshot that crossed a later keystroke does not, and the patch covers it.
          if (result.ok) {
            apply(projectId, result.value.project);
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

    editRequest: (requestId, patch) => {
      // Optimistic exactly as `updateRequest` is, and for the same reason: the mirror is what
      // the editor, the code panel and the send path read, so the edit has to land there at
      // once. The only difference is that nothing is written — the patch waits in the drafts
      // store until the user saves.
      update((draft) => {
        const request = draft.requests[requestId];
        if (request !== undefined) {
          draft.requests[requestId] = withPatch(request, patch);
        }
      });
      useDraftsStore.getState().stageRequest(requestId, patch);
    },

    commitRequest: async (requestId) => {
      const staged = useDraftsStore.getState().peekRequest(requestId);
      if (staged === undefined) {
        return true;
      }
      const projectId = ownerOf(requestId);
      // Replayed as one ordinary mutation, so main's model is whole again: `saveProject`
      // reconciles the entire project against that model, and anything main derives from it —
      // a recreate's "keep values", a preflight — reads it directly.
      const result = await ipc().project.mutate({
        projectId,
        change: { kind: 'update-request', requestId, patch: staged },
      });
      if (!result.ok) {
        // The draft survives a failed commit: nothing landed, so the edit is still unsaved and
        // the tab must keep saying so.
        showToast(asError(result.error).message);
        return false;
      }
      apply(projectId, result.value.project);
      useDraftsStore.getState().clearRequestIfUnchanged(requestId, staged);
      return true;
    },

    saveRequest: async (requestId) => {
      if (useDraftsStore.getState().peekRequest(requestId) === undefined) {
        return;
      }
      const projectId = ownerOf(requestId);
      if (!(await get().commitRequest(requestId))) {
        return;
      }
      await saveOne(projectId);
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
      const { createdRequestId: created } = await mutateEntity(interfaceId, {
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
      const { createdRequestId: created } = await mutateEntity(requestId, { kind: 'clone-request', requestId });
      if (created === undefined) {
        throw new Error('clone-request did not return a request id');
      }
      return created;
    },

    addEndpoint: async (interfaceId, name, url) => {
      await mutateEntity(interfaceId, { kind: 'add-endpoint', interfaceId, name, url });
    },

    updateEndpoint: async (interfaceId, endpointId, patch) => {
      await mutateEntity(interfaceId, { kind: 'update-endpoint', interfaceId, endpointId, patch });
    },

    updateRequestAuth: (requestId, auth) => {
      // Fire-and-report like the other request edits: the inspector must stay responsive, and
      // a rejected mutation surfaces as a toast rather than an unhandled rejection.
      void mutateEntity(requestId, { kind: 'update-request-auth', requestId, auth }).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Could not update the request credentials');
      });
    },

    updateEndpointAuth: async (interfaceId, endpointId, auth) => {
      await mutateEntity(interfaceId, { kind: 'update-endpoint-auth', interfaceId, endpointId, auth });
    },

    updateInterfaceAuth: async (interfaceId, auth) => {
      await mutateEntity(interfaceId, { kind: 'update-interface-auth', interfaceId, auth });
    },

    updateRequestWsa: (requestId, wsa) => {
      // Fire-and-report like `updateRequestAuth`: the inspector must stay responsive, and a
      // rejected mutation surfaces as a toast rather than an unhandled rejection.
      void mutateEntity(requestId, { kind: 'update-request-wsa', requestId, wsa }).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Could not update WS-Addressing');
      });
    },

    updateInterfaceWsa: async (interfaceId, wsa) => {
      await mutateEntity(interfaceId, { kind: 'update-interface-wsa', interfaceId, wsa });
    },

    removeEndpoint: async (interfaceId, endpointId) => {
      await mutateEntity(interfaceId, { kind: 'remove-endpoint', interfaceId, endpointId });
    },

    setDefaultEndpoint: async (interfaceId, endpointId) => {
      await mutateEntity(interfaceId, { kind: 'set-default-endpoint', interfaceId, endpointId });
    },

    removeRequest: async (requestId) => {
      await mutateEntity(requestId, { kind: 'remove-request', requestId });
      pending.delete(requestId);
      // A deleted request cannot be saved, so its staged edit goes with it; leaving the draft
      // behind would keep the workspace looking unsaved forever with nothing to save.
      useDraftsStore.getState().discardRequest(requestId);
      useEditorsStore.getState().close(`request:${requestId}`);
      useExchangesStore.getState().clearRequest(requestId);
    },

    addApi: async (projectId, name, baseUrl = '') => {
      const { createdId } = await mutate(projectId, { kind: 'add-api', name, baseUrl });
      if (createdId === undefined) {
        throw new Error('add-api did not return an API id');
      }
      return createdId;
    },

    updateApi: async (apiId, patch) => {
      await mutateEntity(apiId, { kind: 'update-api', apiId, patch });
    },

    removeApi: async (apiId) => {
      // Every request inside it goes too, so their tabs, drafts and cached responses go with them
      // — a tab left open on a request that no longer exists is a tab that can never be saved.
      const inside = Object.values(get().restRequests).filter((request) => request.apiId === apiId);
      await mutateEntity(apiId, { kind: 'remove-api', apiId });
      for (const request of inside) {
        forgetRestRequest(request.id);
      }
      useEditorsStore.getState().close(`api:${apiId}`);
    },

    addFolder: async (apiId, parentId, name) => {
      const { createdId } = await mutateEntity(apiId, {
        kind: 'add-folder',
        apiId,
        ...(parentId !== undefined ? { parentId } : {}),
        name,
      });
      if (createdId === undefined) {
        throw new Error('add-folder did not return a folder id');
      }
      return createdId;
    },

    updateFolder: async (folderId, patch) => {
      await mutateEntity(folderId, { kind: 'update-folder', folderId, patch });
    },

    removeFolder: async (folderId) => {
      const inside = Object.values(get().restRequests).filter((request) => request.folderId === folderId);
      await mutateEntity(folderId, { kind: 'remove-folder', folderId });
      for (const request of inside) {
        forgetRestRequest(request.id);
      }
    },

    addRestRequest: async (apiId, parentId, name) => {
      const { createdId } = await mutateEntity(apiId, {
        kind: 'add-rest-request',
        apiId,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(name !== undefined ? { name } : {}),
      });
      if (createdId === undefined) {
        throw new Error('add-rest-request did not return a request id');
      }
      return createdId;
    },

    updateRestRequest: async (requestId, patch) => {
      await mutateEntity(requestId, { kind: 'update-rest-request', requestId, patch });
    },

    editRestRequest: (requestId, patch) => {
      update((draft) => {
        const request = draft.restRequests[requestId];
        if (request !== undefined) {
          const merged = layerRestEdits(request, patch);
          draft.restRequests[requestId] = merged;
          // The per-project list the explorer and the breadcrumb read is rebuilt from the same
          // merged request, so a staged rename shows in the tree without a round trip.
          const projectId = draft.projectOf[requestId];
          const rest = projectId === undefined ? undefined : draft.rest[projectId];
          if (rest !== undefined && projectId !== undefined) {
            draft.rest[projectId] = {
              ...rest,
              requests: rest.requests.map((candidate) => (candidate.id === requestId ? merged : candidate)),
            };
          }
        }
      });
      useDraftsStore.getState().stageRestRequest(requestId, patch);
    },

    commitRestRequest: async (requestId) => {
      const staged = useDraftsStore.getState().peekRestRequest(requestId);
      if (staged === undefined) {
        return true;
      }
      const projectId = ownerOf(requestId);
      const result = await ipc().project.mutate({
        projectId,
        change: { kind: 'update-rest-request', requestId, patch: staged },
      });
      if (!result.ok) {
        // The draft survives a failed commit: nothing landed, so the edit is still unsaved and the
        // tab must keep saying so.
        showToast(asError(result.error).message);
        return false;
      }
      apply(projectId, result.value.project);
      useDraftsStore.getState().clearRestRequestIfUnchanged(requestId, staged);
      return true;
    },

    saveRestRequest: async (requestId) => {
      if (useDraftsStore.getState().peekRestRequest(requestId) === undefined) {
        return;
      }
      const projectId = ownerOf(requestId);
      if (!(await get().commitRestRequest(requestId))) {
        return;
      }
      await saveOne(projectId);
    },

    removeRestRequest: async (requestId) => {
      await mutateEntity(requestId, { kind: 'remove-rest-request', requestId });
      forgetRestRequest(requestId);
    },

    cloneRestRequest: async (requestId) => {
      const { createdId } = await mutateEntity(requestId, { kind: 'clone-rest-request', requestId });
      if (createdId === undefined) {
        throw new Error('clone-rest-request did not return a request id');
      }
      return createdId;
    },

    moveNode: async (nodeId, parentId, index) => {
      await mutateEntity(nodeId, {
        kind: 'move-node',
        nodeId,
        ...(parentId !== undefined ? { parentId } : {}),
        index,
      });
    },

    addEnvironment: async (projectId, name) => {
      const { createdEnvironmentId } = await mutate(projectId, { kind: 'add-environment', name });
      if (createdEnvironmentId === undefined) {
        throw new Error('add-environment did not return an environment id');
      }
      return createdEnvironmentId;
    },

    updateEnvironment: async (projectId, environmentId, patch) => {
      // Applied locally first (and merged with any still-pending patch) so a second commit
      // fired before the first round trip resolves builds on top of both edits, not just the
      // render-time snapshot; see `withPendingPatch`/`pendingEnvironment` above.
      const existing = pendingEnvironment.get(environmentId);
      const merged: EnvironmentPatchWire = { ...existing, ...patch };
      pendingEnvironment.set(environmentId, merged);
      // The patch lives outside the state, so readers are told to look again.
      set((state) => ({ ...state }));
      try {
        await mutate(projectId, { kind: 'update-environment', environmentId, patch });
      } finally {
        // The reply (or the failure) is authoritative either way: on success the snapshot
        // already carries this edit, and on failure the optimistic one was never saved, so
        // dropping the patch falls back to the last confirmed snapshot.
        if (pendingEnvironment.get(environmentId) === merged) {
          pendingEnvironment.delete(environmentId);
          set((state) => ({ ...state }));
        }
      }
    },

    removeEnvironment: async (projectId, environmentId) => {
      await mutate(projectId, { kind: 'remove-environment', environmentId });
    },

    addKeystore: async (projectId, input) => {
      const { createdKeystoreId } = await mutate(projectId, {
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
      await mutateEntity(keystoreId, { kind: 'update-keystore', keystoreId, patch });
    },

    removeKeystore: async (keystoreId) => {
      await mutateEntity(keystoreId, { kind: 'remove-keystore', keystoreId });
    },

    addWssOutgoing: async (projectId, input) => {
      const { createdWssOutgoingId } = await mutate(projectId, {
        kind: 'add-wss-outgoing',
        ...(input?.name !== undefined ? { name: input.name } : {}),
      });
      if (createdWssOutgoingId === undefined) {
        throw new Error('add-wss-outgoing did not return a configuration id');
      }
      return createdWssOutgoingId;
    },

    updateWssOutgoing: async (configId, patch) => {
      await mutateEntity(configId, { kind: 'update-wss-outgoing', configId, patch });
    },

    removeWssOutgoing: async (configId) => {
      await mutateEntity(configId, { kind: 'remove-wss-outgoing', configId });
    },

    addWssIncoming: async (projectId, input) => {
      const { createdWssIncomingId } = await mutate(projectId, {
        kind: 'add-wss-incoming',
        ...(input?.name !== undefined ? { name: input.name } : {}),
      });
      if (createdWssIncomingId === undefined) {
        throw new Error('add-wss-incoming did not return a configuration id');
      }
      return createdWssIncomingId;
    },

    updateWssIncoming: async (configId, patch) => {
      await mutateEntity(configId, { kind: 'update-wss-incoming', configId, patch });
    },

    removeWssIncoming: async (configId) => {
      await mutateEntity(configId, { kind: 'remove-wss-incoming', configId });
    },

    updateRequestProperties: (requestId, patch) => {
      const projectId = ownerOf(requestId);
      update((draft) => {
        const request = draft.requests[requestId];
        if (request !== undefined) {
          draft.requests[requestId] = withPropertiesPatch(request, patch);
        }
      });
      const revert = (message: string): void => {
        // Fall back to the last confirmed snapshot: the optimistic edit was never saved.
        const project = get().projects[projectId];
        if (project !== undefined) {
          apply(projectId, project);
        }
        showToast(message);
      };
      void ipc()
        .project.mutate({ projectId, change: { kind: 'update-request-properties', requestId, patch } })
        .then((result) => {
          if (result.ok) {
            apply(projectId, result.value.project);
            return;
          }
          revert(asError(result.error).message);
        })
        .catch((error: unknown) => {
          revert(error instanceof Error ? error.message : 'Could not save the change');
        });
    },

    updateProjectSettings: async (projectId, patch) => {
      await mutate(projectId, { kind: 'update-project-settings', patch });
    },

    renameProject: async (projectId, name) => {
      await mutate(projectId, { kind: 'rename-project', name });
    },

    setCacheDefinition: async (interfaceId, cacheDefinition) => {
      await mutateEntity(interfaceId, { kind: 'update-interface', interfaceId, patch: { cacheDefinition } });
    },

    setProjectProperty: async (projectId, name, value) => {
      await mutate(projectId, { kind: 'set-project-property', name, value });
    },

    removeProjectProperty: async (projectId, name) => {
      await mutate(projectId, { kind: 'remove-project-property', name });
    },

    setProjectPropertyEnabled: async (projectId, name, enabled) => {
      await mutate(projectId, { kind: 'set-project-property-enabled', name, enabled });
    },

    setActiveEnvironment: async (projectId, environmentId) => {
      await mutate(projectId, { kind: 'set-active-environment', environmentId });
    },

    addAttachment: async (requestId, path, options) => {
      const { createdAttachmentId } = await mutateEntity(requestId, {
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
      const projectId = ownerOf(requestId);
      update((draft) => {
        const request = draft.requests[requestId];
        if (request !== undefined) {
          draft.requests[requestId] = withAttachmentPatch(request, attachmentId, patch);
        }
      });
      const revert = (message: string): void => {
        // Fall back to the last confirmed snapshot: the optimistic edit was never saved.
        const project = get().projects[projectId];
        if (project !== undefined) {
          apply(projectId, project);
        }
        showToast(message);
      };
      void ipc()
        .project.mutate({ projectId, change: { kind: 'update-attachment', requestId, attachmentId, patch } })
        .then((result) => {
          if (result.ok) {
            apply(projectId, result.value.project);
            return;
          }
          revert(asError(result.error).message);
        })
        .catch((error: unknown) => {
          revert(error instanceof Error ? error.message : 'Could not save the change');
        });
    },

    removeAttachment: async (requestId, attachmentId) => {
      await mutateEntity(requestId, { kind: 'remove-attachment', requestId, attachmentId });
    },
  };
});

/**
 * The project an action that names no entity applies to: the one selected in the explorer, or
 * — with nothing selected — the only open project.
 *
 * A deliberate stopgap, not a hidden "current project": with several projects open and none
 * selected there is no answer, and the affordances that use this (Add keystore, Add WS-Security
 * configuration) are disabled rather than guessing. Task 11 gives those a project of their own.
 */
export function useTargetProjectId(): string | undefined {
  const selectionId = useUiStore((state) => state.selection?.id);
  const selectionRequestId = useUiStore((state) => state.selection?.requestId);
  const selectionInterfaceId = useUiStore((state) => state.selection?.interfaceId);
  return useProjectStore((state) => {
    const selected = [selectionRequestId, selectionInterfaceId, selectionId]
      .map((id) => (id === undefined ? undefined : state.projectOf[id]))
      .find((id) => id !== undefined);
    if (selected !== undefined) {
      return selected;
    }
    const ids = Object.keys(state.projects);
    return ids.length === 1 ? ids[0] : undefined;
  });
}

/**
 * Subscribes the mirror to main's project events. Called once from the shell; returns an
 * unsubscribe for symmetry with React effects.
 */
export function subscribeToProject(): () => void {
  // No pull here: which projects exist is the workspace's to say, so the workspace store pulls
  // any ready project the mirror lacks whenever a workspace arrives (`pullMissingProjects`),
  // and opening one raises `project.changed` per project as each host comes up.
  // `defineEvent` types every event's `name` as `string`, so the derived event map cannot
  // narrow a payload by channel; the casts below are the same ones the import dialog uses.
  const offChanged = window.wirebench.on('project.changed', ((payload: ProjectChangedEvent) => {
    useProjectStore.getState().applySnapshot(payload.projectId, payload.project);
  }) as (payload: unknown) => void);
  const offDisk = window.wirebench.on('project.changedOnDisk', ((payload: ProjectChangedOnDiskEvent) => {
    useProjectStore.getState().noteChangedOnDisk(payload.projectId, payload.paths);
  }) as (payload: unknown) => void);
  return () => {
    offChanged();
    offDisk();
  };
}

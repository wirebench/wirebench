/**
 * The main process's owner of the open project.
 *
 * The renderer never holds the authoritative model: it mirrors {@link ProjectWire} snapshots
 * and asks for changes through `project.mutate`. That keeps a single writer for both the
 * in-memory model and the folder on disk, which in turn makes autosave, the external-change
 * watcher and quit-time saving describable in one place.
 *
 * Definitions are not stored in the project folder's YAML: an interface records where its
 * WSDL came from, and the resolved documents live in the definition cache. Reopening a
 * project therefore re-imports every interface from that cache in the background
 * ("hydration"), which is what makes `request.generate` and `request.send` work offline.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { isInsideAny } from './path-containment.js';
import type { ReadPicks } from './dialog-picks.js';
import {
  apiDefinitionDir,
  applyUpdate,
  attachmentFile,
  attachmentsDir,
  createFileAttachmentResolver,
  createDefaultFetchDocument,
  createInterface,
  createProject,
  DEFAULT_PREFERENCES,
  definitionCacheDir,
  definitionRootOf,
  enabledProperties,
  exportDefinition,
  fetchDocumentFromCache,
  generateDocs,
  generateId,
  IMPORTED_SCRIPTS_DIR,
  interfaceDir,
  loadProject,
  mapLegacyProject,
  nodeFs,
  planUpdate,
  ProjectError,
  projectFiles,
  putAttachment,
  readApiDefinitionCache,
  describeMessageAt,
  describeServices,
  loadProtoSet,
  sampleMessageText,
  writeProtoDefinitionCache,
  PROTOS_DIR,
  protoPathSegments,
  resolveApiBaseUrl,
  resolveAuthEndpoint,
  resolveEndpoint,
  resolveScopes,
  resolveWorkspaceApiBaseUrl,
  resolveWorkspaceEndpoint,
  resolveWorkspaceScopes,
  saveProject,
  toSendInput,
  uniqueSlug,
  writeApiDefinitionCache,
  applyAsyncApiUpdate,
  asyncApiChannelMessages,
  createCachedApiFetch,
  matchOperation,
  toWireSchema,
  parseAsyncApi,
  parseOpenApi,
  planAsyncApiUpdate,
  writeDefinitionCache,
  writeDescriptorDefinitionCache,
  writeFileAtomic,
  DESCRIPTORS_FILE,
  descriptorSetBytes,
  expand,
  protoSetFromDescriptorSet,
  readGrpcDefinitionCache,
  reconcileGrpcApi,
  reflectProtoSet,
} from '@wirebench/engine';
import type {
  AuthConfig,
  LegacyImportReport,
  LegacyProject,
  ResolvedLegacyInterface,
  GrpcApi,
  GrpcReconcileResult,
  GrpcReflectionVersion,
  GrpcServiceDescriptor,
  MessageDescriptor,
  ProtoImportSummary,
  ProtoSet,
  ProtoSources,
  TlsOptions,
  ResolvedDocument,
  AsyncApiApplyResult,
  AsyncApiDocument,
  OpenApiDocument,
  AsyncApiUpdatePlan,
  ChannelMessages,
  ParsedAsyncApi,
  RestApi,
  WsApi,
  RestFolder,
  RestRequestDef,
  Cookie,
  Attachment,
  AttachmentResolvers,
  AttachmentSource,
  Endpoint,
  EndpointSource,
  FsLike,
  Preferences,
  Interface,
  OperationDef,
  Project,
  ProjectFiles,
  ProxyConfig,
  PropertyScopes,
  RequestDef,
  SendAttachmentOptions,
  Workspace,
} from '@wirebench/engine';
import {
  DEFAULT_WSA_CONFIG,
  applyWsaHeaders,
  effectiveWsa,
  stripWsaHeaders,
  applyOutgoingWss,
  createWssContext,
  loadKeystore,
  removeOutgoingWss,
  toKeystoreDef,
  isExcluded,
  resolveProxyFor,
  splitPemBundle,
  toTlsClientIdentity,
  toWssIncomingConfig,
  toWssOutgoingConfig,
  WirebenchError,
} from '@wirebench/engine';
import type {
  Keystore,
  KeystoreDef,
  SoapSendWss,
  WssContext,
  WssEntry,
  WsaConfig,
  WssIncomingConfig,
  WssOutgoingConfig,
} from '@wirebench/engine';
import { MAX_DROPPED_ATTACHMENT_BYTES } from '../shared/wire-types.js';
import type {
  GrpcRequestPatchWire,
  WsRequestPatchWire,
  RestRequestPatchWire,
  ApplyUpdateWire,
  DefinitionUpdateOptions,
  DefinitionUpdateSource,
  EngineProgressEvent,
  HydrationStatus,
  ImportSourceWire,
  InterfaceSummary,
  ProjectChange,
  ProjectProblemWire,
  ProjectSaveResult,
  KeystoresInspectResponse,
  ProjectWire,
  SoapSendInputWire,
  ProxyOptionsWire,
  TlsOptionsWire,
  UpdatePlanWire,
} from '../shared/wire-types.js';
import { isEndpointAuth } from '@wirebench/engine';
import type { EndpointAuth, JsonSchema, SoapOwnerAuth } from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import { generateOptionsFrom } from './generate-options.js';
import type { GlobalProperties } from './global-properties.js';
import type { PreferencesService } from './preferences.js';
import type { PreflightResult } from './expansion-preflight.js';
import { preflightRequest } from './expansion-preflight.js';
import { resolveEndpointAuth } from './secret-resolver.js';
import { findRestFolder, findRestRequest, restApiOwning } from './project-rest-mutations.js';
import type { RestContractTarget } from './rest-contract.js';
import { resolveRestSend } from './rest-send.js';
import type { RestSendResolution } from './rest-send.js';
import { resolveGrpcSend } from './grpc-send.js';
import type { GrpcSendResolution } from './grpc-send.js';
import { findGrpcFolder, findGrpcRequest, grpcApiOwning, locateGrpcRequest } from './project-grpc-mutations.js';
import { findWsRequest, locateWsRequest, takenApiSlugs, wsApiOwning } from './project-ws-mutations.js';
import { resolveWsSend } from './ws-send.js';
import type { WsSendResolution } from './ws-send.js';
import type { SecretStore } from './secrets.js';
import { effectiveAuth } from './project-auth.js';
import { allowsReadPath } from './path-access.js';
import {
  addRequest,
  appendAttachment,
  applyChange,
  contentTypeForPath,
  projectNameFromDir,
} from './project-mutations.js';
import type { AsyncApiDefinitionInfo, InterfaceRuntime } from './project-wire.js';
import { findRequest, toProjectWire, toUpdatePlanWire } from './project-wire.js';
import { ProjectWatcher, SELF_WRITE_TTL_MS } from './project-watch.js';
import { mergeUnsaved, overlayFs } from './unsaved-store.js';
import type { UnsavedProjectFiles } from './unsaved-store.js';
import { renameWithRetry } from './rename-dir.js';

/**
 * What a send needs to carry a request's attachments: the attachments themselves plus the
 * fully-mapped engine options (the seven MTOM/SwA flags, and the resolvers that read bytes).
 * Never serialised — the resolvers are closures over the main process's file system.
 */
export interface SendAttachmentInput {
  readonly attachments: readonly Attachment[];
  readonly attachmentOptions: SendAttachmentOptions;
}

/** How long an edit sits before autosave writes it out. */
export const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * `writtenBy` in every project manifest this host writes. Deliberately without the save reason:
 * a manual save and an autosave of the same model must produce byte-identical files, or every
 * switch between the two rewrites `wirebench.yaml` (and, in a shared workspace, commits it).
 */
const PROJECT_WRITER = 'wirebench';

/** Events the service raises; the IPC layer forwards them to the renderer. */
export interface ProjectHostHooks {
  /** After any mutation, save, open, close or reload. `null` means no project is open. */
  readonly onChanged?: (project: ProjectWire | null) => void;
  /** Files under the project folder changed outside the app. */
  readonly onChangedOnDisk?: (paths: readonly string[]) => void;
  /** One interface's definition finished (or failed) re-importing. */
  readonly onHydration?: (event: { interfaceId: string; status: HydrationStatus; message?: string }) => void;
  /** Import progress, forwarded from the engine. */
  readonly onProgress?: (event: EngineProgressEvent) => void;
  /**
   * A save wrote or removed files (paths relative to the project folder). Raised only when
   * something changed on disk; the host's own save `reason` (`'autosave'`, `'manual'`, …) is passed
   * through untouched. The host knows nothing about what listens — a shared workspace commits.
   */
  readonly onSaved?: (event: { reason: string; written: readonly string[]; removed: readonly string[] }) => void;
}

/**
 * What a gRPC API's definition arrived as, which decides the cache it is written to: the `.proto`
 * text of an import, or the descriptor set a server described itself with.
 */
export type GrpcDefinitionInput =
  | { readonly kind: 'proto'; readonly sources: ProtoSources }
  | {
      readonly kind: 'reflection';
      readonly descriptors: Uint8Array;
      readonly version: 'v1' | 'v1alpha';
      readonly trustInvalid?: boolean;
    };

/** How long a discovery waits for a server to describe itself. */
const GRPC_REFLECTION_TIMEOUT_MS = 30_000;

/** The mutable state of one open project. */
interface OpenProject {
  project: Project;
  readonly dir: string;
  dirty: boolean;
  lastSavedAt: string | undefined;
  problems: ProjectProblemWire[];
  readonly runtime: Map<string, InterfaceRuntime>;
  lastWritten: ProjectFiles | undefined;
  /**
   * The project's files as they are on disk when the model was last in sync with them: at open,
   * or after a save. What an unsaved-changes record is merged against when it is restored.
   */
  baseline: ProjectFiles;
  readonly watcher: ProjectWatcher;
}

/** What {@link ProjectHost.openProject} did with an unsaved-changes record it was handed. */
export type UnsavedRestoreOutcome =
  | { readonly status: 'restored'; readonly conflicts: readonly string[]; readonly dropped: readonly string[] }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cleans a dropped file's browser-reported name before it becomes the attachment's `name` and
 * the source hint for `putAttachment`'s cached file name.
 *
 * A drop hands main a plain string, not a path the OS resolved, so nothing stops it from
 * containing separators or control characters (a crafted `DataTransfer`, or just an odd OS). It
 * is never used to address the file system — `addAttachmentBytes` always writes under
 * `attachments/<sha256>` — but it is shown in the grid and offered back as a save/open default
 * name, so it is stripped to a plain, safe display name here rather than downstream.
 */
function sanitizeDroppedName(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const cleaned = withoutSeparators.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/**
 * The absolute paths a `path`-source attachment's declared path could mean, in the exact order
 * `createFileAttachmentResolver` (`@wirebench/engine`'s `packages/engine/src/project/attachments-cache.ts`)
 * would try them: an absolute path is itself the only candidate; a relative one is tried under
 * `resourceRoot` first (when the project has one), then under the project folder. Kept in sync
 * with that function deliberately, so the path main checks is always the path the engine would
 * actually read — see {@link ProjectHost.attachmentResolvers}'s `resolver`.
 */
function attachmentPathCandidates(projectDir: string, resourceRoot: string | undefined, path: string): string[] {
  if (isAbsolute(path)) {
    return [path];
  }
  return resourceRoot === undefined
    ? [resolvePath(projectDir, path)]
    : [resolvePath(resourceRoot, path), resolvePath(projectDir, path)];
}

/** The first of `candidates` that exists on disk, or `undefined` when none do. */
async function firstExistingCandidate(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Every distinct port address of an imported definition, as project endpoints. */
function endpointsFrom(summary: InterfaceSummary): Endpoint[] {
  const seen = new Set<string>();
  const endpoints: Endpoint[] = [];
  for (const service of summary.services) {
    for (const port of service.ports) {
      if (port.address === undefined || seen.has(port.address)) {
        continue;
      }
      seen.add(port.address);
      endpoints.push({
        id: generateId(),
        name: `${service.name} ${port.name}`,
        url: port.address,
        authMode: 'complement',
      });
    }
  }
  return endpoints;
}

/** One empty {@link OperationDef} per operation the definition exposes, with unique slugs. */
function operationsFrom(summary: InterfaceSummary): OperationDef[] {
  const taken = new Set<string>();
  return summary.operations.map((operation, index) => {
    const slug = uniqueSlug(operation.name, taken);
    taken.add(slug);
    return { name: operation.name, bindingName: operation.binding, slug, order: index, requests: [] };
  });
}

/** True when `dir` does not exist, or exists and holds nothing. */
async function isEmptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) {
    return true;
  }
  return (await readdir(dir)).length === 0;
}

/**
 * Where a host learns that its project is open *inside* a workspace: the workspace as it stands
 * right now, and the slug the workspace's manifest addresses this project by (the first half of
 * an endpoint override's `<projectSlug>/<interfaceSlug>` key).
 *
 * A function rather than a value because the workspace is replaced on every edit — a host that
 * held a snapshot would keep routing to the environment that was active when it opened.
 */
export type WorkspaceContext = () => { readonly workspace: Workspace; readonly projectSlug: string } | undefined;

/** Owns the open project: its model, its folder, its autosave timer and its watcher. */
export class ProjectHost {
  private open: OpenProject | undefined;
  /** Parsed keystores, keyed by entry id; see {@link loadKeystoreFor} for the invalidation key. */
  private readonly keystoreCache = new Map<string, { key: string; keystore: Keystore }>();
  /**
   * What each REST request's own last response set, for the session only, keyed by request id.
   *
   * Not a cookie jar: a request only ever sees what it set itself, so one request's send cannot
   * change another's, and none of this reaches disk (see `rest/cookies.ts`).
   */
  private readonly restCookies = new Map<string, readonly Cookie[]>();
  /**
   * Loaded `.proto` sets, keyed by gRPC API id. A set is parsed once per API from its cache and
   * kept for the session — every send and every method-picker refresh reads from it — and dropped
   * when the API is removed or re-imported.
   */
  private readonly protoSets = new Map<string, Promise<ProtoSet>>();
  /** Each AsyncAPI-imported API's parsed contract, read from its cache once per session and API. */
  private readonly asyncApiContracts = new Map<string, Promise<AsyncApiDocument | undefined>>();
  /** The version and WebSocket servers of each cached AsyncAPI document read so far, for the Definition card. */
  private readonly asyncApiInfo = new Map<string, AsyncApiDefinitionInfo>();
  /**
   * Each OpenAPI-imported API's parsed document, read from its definition cache once per session
   * and API, for checking responses against it. Dropped on close and when the API is imported.
   */
  private readonly openApiDocuments = new Map<string, Promise<OpenApiDocument>>();
  private autosave: NodeJS.Timeout | undefined;
  private hydrating: Promise<void> | undefined;
  /** What the last `openProject` did with an unsaved-changes record, if it was given one. */
  private restore: UnsavedRestoreOutcome | undefined;
  /**
   * Serialises {@link save}: every save chains off this promise, so a manual save and the
   * before-quit save can never have their write+prune phases interleave. Never rejects — a
   * failed save resolves it so the next one still runs (the caller sees the rejection).
   */
  private saveQueue: Promise<void> = Promise.resolve();
  /**
   * Set by `WorkspaceService` for every host it opens; `undefined` for a host that owns a
   * standalone project. Everything property- and endpoint-related branches on it, and with no
   * context the host behaves exactly as it did before workspaces existed.
   */
  private workspaceContext: WorkspaceContext | undefined;

  constructor(
    private readonly engine: EngineService,
    private readonly hooks: ProjectHostHooks = {},
    /** Overrides the filesystem `saveProject` writes through. Test-only (deferred writes). */
    private readonly fs?: FsLike,
    /** The `${#Global#name}` scope. Omitted in tests that never expand properties. */
    private readonly globals?: Pick<GlobalProperties, 'get'>,
    /** Resolves `passwordRef`s at import time. Omitted in tests that never import with auth. */
    private readonly secrets?: Pick<SecretStore, 'get'>,
    /**
     * The user's preferences, folded into every send input. Omitted in tests, where the
     * engine's built-in defaults stand in.
     */
    private readonly preferences?: Pick<PreferencesService, 'get'>,
    /**
     * The absolute paths the user picked through a native dialog this session (see
     * `dialog-picks.ts`). It is the only evidence that lets an attachment name a file outside
     * the project folder; omitted in tests, which then get containment and nothing else.
     */
    private readonly picks?: ReadPicks,
    /**
     * Answers Chromium's PAC-style proxy string for a URL — the app passes a wrapper around
     * `session.resolveProxy`, so "System proxy" means exactly what the rest of Electron's
     * network stack means by it. Omitted in tests (and then `mode: 'system'` goes direct),
     * which is also what keeps this class free of any `electron` import.
     */
    private readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>,
  ) {}

  /**
   * Tells this host which workspace its project is open inside. Injected after construction
   * rather than through the constructor because the workspace owns the host, not the other way
   * round: `WorkspaceService` builds the host, then hands it a closure over the entry it just
   * created. Pass `undefined` to go back to standalone behaviour.
   */
  setWorkspaceContext(context: WorkspaceContext | undefined): void {
    this.workspaceContext = context;
  }

  /**
   * The URL a send of `request` would go to, resolved the way the project is actually open:
   * through the workspace's active environment when there is a workspace context (spec §3.3 —
   * a linked project's own environment wins, then the workspace environment's override for
   * `<projectSlug>/<interfaceSlug>`, then the project's own resolution), and through the
   * project's own active environment when there is not.
   *
   * The single place the choice is made, so the send path, the TLS lookup, the WS-A `To`
   * header and the preflight badge can never disagree about where a request is going.
   */
  private resolveEndpointFor(
    project: Project,
    iface: Interface,
    request: Pick<RequestDef, 'endpointId' | 'endpointUrl'>,
  ): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint } {
    const context = this.workspaceContext?.();
    if (context === undefined) {
      return resolveEndpoint(project, project.activeEnvironmentId, iface, request);
    }
    return resolveWorkspaceEndpoint({
      workspace: context.workspace,
      project,
      projectSlug: context.projectSlug,
      iface,
      request,
    });
  }

  /**
   * Whether main may touch `resolved` on behalf of a request attachment.
   *
   * Two kinds of evidence count, and nothing else does: the file is contained in the project
   * folder (or its attachment cache), or the *user* picked it through the Add-attachments /
   * Browse… dialog this session. A path that merely arrived over IPC — or that a project file
   * declares after a restart — has neither, so it is refused rather than read, sent or opened.
   *
   * A path delivered by an OS drag-and-drop (Task 33b) is NOT evidence: it leaves no record in
   * main. 33b must add its own "remember this drop" channel and call it before the drop's path
   * reaches `add-attachment`, rather than widening this check.
   */
  private async allowsAttachmentPath(dir: string, resolved: string): Promise<boolean> {
    if (this.picks?.hasRead(resolved) === true) {
      return true;
    }
    return isInsideAny([dir, attachmentsDir(dir)], resolved);
  }

  /** The current preferences, or the engine defaults when none were injected. */
  private prefs(): Preferences | undefined {
    return this.preferences?.get();
  }

  /**
   * Folds a request's saved properties, the project's settings and the user's preferences into
   * the send input for `requestId` — the single place those three layers meet (see the engine's
   * `toSendInput`). `overrides` carries what the *editor* currently holds (an envelope the user
   * has typed but that has not been autosaved yet, and the endpoint the renderer resolved), so
   * a send always puts the visible request on the wire, with the saved knobs applied to it.
   *
   * `undefined` when no project is open, the request is unknown, or no endpoint resolves.
   */
  sendInputFor(
    requestId: string,
    overrides?: {
      readonly endpoint?: string;
      readonly envelopeXml?: string;
      readonly headers?: Record<string, string>;
    },
  ): SoapSendInputWire | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const { iface, request } = location;
    const endpoint = overrides?.endpoint ?? this.resolveEndpointFor(this.open.project, iface, request).url;
    if (endpoint === undefined) {
      return undefined;
    }
    const headers =
      overrides?.headers !== undefined
        ? Object.entries(overrides.headers).map(([name, value]) => ({ name, value }))
        : request.headers;
    const wsa = this.wsaFor(requestId);
    const input = toSendInput({
      request: {
        properties: request.properties,
        soapVersion: request.soapVersion,
        ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
        headers,
        envelopeXml: overrides?.envelopeXml ?? request.envelopeXml,
      },
      endpoint,
      ...(this.prefs() !== undefined ? { preferences: this.prefs() as Preferences } : {}),
      projectSettings: this.open.project.settings,
    });
    return {
      endpoint: input.endpoint,
      envelopeXml: input.envelopeXml,
      soapVersion: input.soapVersion,
      ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
      ...(input.headers !== undefined ? { headers: { ...input.headers } } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
      ...(input.followRedirects !== undefined ? { followRedirects: input.followRedirects } : {}),
      ...(input.maxSizeBytes !== undefined ? { maxSizeBytes: input.maxSizeBytes } : {}),
      ...(input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {}),
      ...(input.localAddress !== undefined ? { localAddress: input.localAddress } : {}),
      ...(input.compressBody !== undefined ? { compressBody: input.compressBody } : {}),
      ...(input.entitize !== undefined ? { entitize: input.entitize } : {}),
      // Only the preference-level TLS floor reaches the renderer here; trust anchors, the
      // client identity and a per-endpoint trust decision are resolved in main (`tlsFor`) and
      // merged on at send time, so no key material or trust decision rides this wire shape.
      ...(input.tls?.minVersion !== undefined ? { tls: { minVersion: input.tls.minVersion } } : {}),
      ...(input.allowH2 !== undefined ? { allowH2: input.allowH2 } : {}),
      ...(wsa !== undefined ? { wsa } : {}),
    };
  }

  /**
   * The attachments (and the MTOM/SwA options the request's properties ask for) that a send of
   * `requestId` must carry. Deliberately NOT part of {@link SoapSendInputWire}: it holds the
   * resolver closures that read bytes, which cannot — and must not — cross IPC.
   *
   * `undefined` when no project is open or the request is unknown (an ad-hoc send, which has
   * no saved attachments and no project folder to read them from).
   */
  sendAttachmentsFor(requestId: string): SendAttachmentInput | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const { request } = location;
    // Built through `toSendInput` rather than by mapping the seven MTOM flags here a second
    // time: that mapping is the engine's, and duplicating it is how the two drift apart. Only
    // the attachment fields of the result are used; the rest is rebuilt by `sendInputFor`.
    const input = toSendInput({
      request: {
        properties: request.properties,
        soapVersion: request.soapVersion,
        ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
        headers: request.headers,
        envelopeXml: request.envelopeXml,
      },
      endpoint: '',
      ...(this.prefs() !== undefined ? { preferences: this.prefs() as Preferences } : {}),
      projectSettings: this.open.project.settings,
      attachments: request.attachments,
      attachmentResolvers: this.attachmentResolvers(this.open),
    });
    if (input.attachmentOptions === undefined) {
      return undefined;
    }
    return { attachments: input.attachments ?? [], attachmentOptions: input.attachmentOptions };
  }

  /**
   * The resolvers a send reads attachment (and inline-file) bytes through.
   *
   * Both closures are guarded by the same predicate as `add-attachment` and
   * `resolveAttachmentPath`, {@link allowsAttachmentPath}: a read is allowed only when the
   * resolved path is inside the project folder (or its attachment cache) or was picked by the
   * *user* through a native dialog this session.
   *
   * `resolver` does NOT delegate a `path` source to the engine's project-folder resolver
   * (`createFileAttachmentResolver`) — only a `cache` source does, since its digest already
   * confines it to `attachments/`. For a `path` source, main itself works out the same
   * candidate list the engine resolver would try (`resourceRoot` first when the path is
   * relative and one is set, then the project folder — see `attachments-cache.ts`'s own
   * candidate logic), picks the first candidate that exists, and runs
   * {@link allowsAttachmentPath} on *that exact candidate* before reading it itself. Checking
   * `resolvePath(projectDir, path)` instead (ignoring `resourceRoot`) would be wrong: a
   * relative path can be contained under the project folder by that resolution while the
   * candidate the engine would actually read — `resourceRoot` joined with the same relative
   * path — points somewhere else entirely, e.g. `resourceRoot: /Users/me/.ssh` +
   * `source.path: id_rsa`. Checking the wrong candidate is equivalent to not checking at all.
   *
   * `resolveFile` handles `file:<path>` references the renderer put into the envelope; a read
   * is allowed only inside the project folder or its attachment cache, or at a user-picked
   * path — never merely because some attachment on the request happens to declare it, since
   * that declaration might itself be an unpicked, cross-session one.
   */
  private attachmentResolvers(open: OpenProject): AttachmentResolvers {
    const projectDir = open.dir;
    const resourceRoot = open.project.settings.resourceRoot;
    const readFileAttachment = createFileAttachmentResolver(projectDir, resourceRoot);
    return {
      resolver: async (attachment: Attachment): Promise<Uint8Array> => {
        if (attachment.source.kind !== 'path') {
          return readFileAttachment(attachment);
        }
        const declared = attachment.source.path;
        const candidates = attachmentPathCandidates(projectDir, resourceRoot, declared);
        const existing = await firstExistingCandidate(candidates);
        if (existing === undefined) {
          throw new ProjectError(
            'attachment-unreadable',
            `Attachment "${attachment.name}" could not be read from ${declared}`,
            { details: { attachmentId: attachment.id, path: declared } },
          );
        }
        if (!(await this.allowsAttachmentPath(projectDir, existing))) {
          throw new ProjectError(
            'attachment-outside-project',
            `The attachment "${attachment.name}" is outside the project`,
            { details: { attachmentId: attachment.id, path: declared } },
          );
        }
        return new Uint8Array(await readFile(existing));
      },
      resolveFile: async (path: string): Promise<Uint8Array> => {
        const resolved = resolvePath(projectDir, path);
        if (!(await this.allowsAttachmentPath(projectDir, resolved))) {
          throw new ProjectError(
            'inline-file-outside-project',
            `The file "${path}" resolves outside the project folder`,
            { details: { path } },
          );
        }
        return new Uint8Array(await readFile(resolved));
      },
      // Relative `file:` references resolve against the project folder, which is exactly the
      // set `resolveFile` above is willing to read from.
      resourceRoot: projectDir,
    };
  }

  /**
   * The absolute file that holds one request attachment's bytes: the cache blob for a `cache`
   * source, or the resolved `path` for a `path` one.
   *
   * The result is what `attachments.openRequest` hands to the OS — a `.command`/`.desktop`
   * away from arbitrary code execution — so it is allow-listed here rather than at the call
   * site, through {@link allowsAttachmentPath}: inside the project folder or its attachment
   * cache, or a path the user picked through a dialog *this session*. A `path` attachment
   * saved in an earlier session therefore needs re-picking before it can be opened. Throws
   * rather than returning `undefined` so the renderer sees *why* an open was refused.
   */
  async resolveAttachmentPath(requestId: string, attachmentId: string): Promise<string> {
    const open = this.require();
    const location = findRequest(open.project, requestId);
    if (location === undefined) {
      throw new ProjectError('not-found', `No request with id "${requestId}"`, { details: { requestId } });
    }
    const attachment = location.request.attachments.find((candidate) => candidate.id === attachmentId);
    if (attachment === undefined) {
      throw new ProjectError('not-found', `No attachment with id "${attachmentId}"`, { details: { attachmentId } });
    }
    if (attachment.source.kind === 'cache') {
      return attachmentFile(open.dir, attachment.source.sha256);
    }
    const declared = attachment.source.path;
    const resolved = resolvePath(open.dir, declared);
    if (await this.allowsAttachmentPath(open.dir, resolved)) {
      return resolved;
    }
    throw new ProjectError('attachment-outside-project', `The attachment "${attachment.name}" is outside the project`, {
      details: { attachmentId, path: declared },
    });
  }

  /** The `dumpFile` path a request asks its responses to be written to, if any. */
  dumpFileFor(requestId: string): { path: string; projectDir: string } | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    const path = location?.request.properties.dumpFile;
    if (path === undefined || path.trim().length === 0) {
      return undefined;
    }
    return { path: path.trim(), projectDir: this.open.dir };
  }

  /**
   * The property scopes a send (or a preflight) expands against: the open project's own
   * properties, the active environment's (or `envId`'s) overrides, the user's globals and the
   * process environment. With no project open only the global and system scopes are populated,
   * so an ad-hoc send still expands `${#Global#…}`.
   */
  scopesFor(envId?: string): PropertyScopes {
    const globalsState = this.globals?.get();
    const globals = globalsState === undefined ? {} : enabledProperties(globalsState.properties, globalsState.disabled);
    if (this.open === undefined) {
      return { project: {}, global: globals, system: process.env };
    }
    const context = this.workspaceContext?.();
    if (context !== undefined) {
      // Inside a workspace the active environment is the *workspace's*, and the project
      // manifest's own `activeEnvironmentId` is deliberately not read (spec §3.3) — so `envId`,
      // which only ever names a project environment, has nothing to select here.
      return resolveWorkspaceScopes({
        workspace: context.workspace,
        project: this.open.project,
        globals,
        system: process.env,
      });
    }
    return resolveScopes(this.open.project, envId ?? this.open.project.activeEnvironmentId, globals, process.env);
  }

  /**
   * Resolves one saved request's endpoint under the active environment and reports every
   * property reference that would not expand. Nothing is sent; see {@link preflightRequest}.
   */
  preflight(requestId: string, envId?: string): PreflightResult {
    const open = this.require();
    const activeId = envId ?? open.project.activeEnvironmentId;
    return preflightRequest(
      open.project,
      requestId,
      this.scopesFor(activeId),
      activeId,
      this.defaultWsaActionFor(requestId),
      this.workspaceContext?.() === undefined
        ? undefined
        : (iface, request) => this.resolveEndpointFor(open.project, iface, request),
    );
  }

  /** Resolves a `secretRef` to plaintext for the duration of one import/send call. */
  private async getSecret(ref: string): Promise<string | undefined> {
    return this.secrets?.get(ref);
  }

  /**
   * The auth that should apply when sending `requestId`: request auth overrides its endpoint's,
   * which overrides its interface's (see `effectiveAuth`). `undefined` when the request is
   * unknown or nothing configures auth at any level. Any non-`inherit` scheme: a SOAP owner may
   * hold a Bearer, API-key or OAuth2 configuration as well as Basic/NTLM.
   */
  authFor(requestId: string): SoapOwnerAuth | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const endpoint = resolveAuthEndpoint(location.iface, location.request);
    return effectiveAuth(location.request.auth, endpoint?.auth, endpoint?.authMode ?? 'override', location.iface.auth);
  }

  /**
   * The credentials configured on one SOAP interface, endpoint or request — its own, not its
   * effective ones.
   *
   * The SOAP counterpart of {@link restAuthOf}, for the OAuth2 channels: a token is obtained for
   * the owner that configures it, not for whichever request happened to inherit it.
   */
  soapAuthOf(ownerId: string): SoapOwnerAuth | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    for (const iface of this.open.project.interfaces) {
      if (iface.id === ownerId) {
        return iface.auth;
      }
      const endpoint = iface.endpoints.find((candidate) => candidate.id === ownerId);
      if (endpoint !== undefined) {
        return endpoint.auth;
      }
    }
    return findRequest(this.open.project, ownerId)?.request.auth;
  }

  /** The open project's id, or `undefined` when no project is open. Used to key its history file. */
  projectId(): string | undefined {
    return this.open?.project.id;
  }

  /**
   * Everything `validate.message` needs about a saved request: which imported interface (and
   * binding operation) it belongs to, the envelope as last saved, and the transport metadata
   * the SOAP structure checks cross-check the envelope against.
   *
   * `undefined` when no project is open or the request is unknown.
   */
  validationTargetFor(requestId: string):
    | {
        readonly interfaceId: string;
        readonly bindingName: string;
        readonly operationName: string;
        readonly envelopeXml: string;
        readonly soapAction?: string;
        readonly contentType?: string;
      }
    | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const { iface, operation, request } = location;
    const contentType = request.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value;
    return {
      interfaceId: iface.id,
      bindingName: operation.bindingName,
      operationName: operation.name,
      envelopeXml: request.envelopeXml,
      ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
    };
  }

  /**
   * The saved request's name and owning interface/operation, for labelling a history entry.
   * `undefined` when no project is open or the request is unknown (an ad-hoc/raw send).
   */
  requestMeta(requestId: string): { requestName: string; interfaceName: string; operationName: string } | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    return {
      requestName: location.request.name,
      interfaceName: location.iface.name,
      operationName: location.operation.name,
    };
  }

  /**
   * The send input for a still-*saved* request, built from its LIVE model — current envelope,
   * headers and effective endpoint, exactly what `request.send` would use today. `undefined`
   * when no project is open, the request no longer exists, or its endpoint cannot be resolved.
   *
   * Used by `history.resend`: a re-send must replay the current request, not the (redacted)
   * copy captured in the history entry at send time.
   */
  buildLiveSendInput(requestId: string): SoapSendInputWire | undefined {
    return this.sendInputFor(requestId);
  }

  /**
   * Where a saved request came from (its operation) and what it currently holds. `undefined`
   * when no project is open or the request no longer exists. Used by `request.recreate`, which
   * must regenerate that operation's envelope before merging the current one into it.
   */
  requestSource(
    requestId: string,
  ): { interfaceId: string; bindingName: string; operationName: string; envelopeXml: string } | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    return {
      interfaceId: location.iface.id,
      bindingName: location.operation.bindingName,
      operationName: location.operation.name,
      envelopeXml: location.request.envelopeXml,
    };
  }

  /** The current snapshot, or `null` when no project is open. */
  snapshot(): ProjectWire | null {
    if (this.open === undefined) {
      return null;
    }
    return toProjectWire(this.open.project, {
      dir: this.open.dir,
      dirty: this.open.dirty,
      ...(this.open.lastSavedAt !== undefined ? { lastSavedAt: this.open.lastSavedAt } : {}),
      problems: this.open.problems,
      runtime: this.open.runtime,
      asyncApiInfo: this.asyncApiInfo,
    });
  }

  /**
   * The open project's engine model, or `undefined` when no project is open.
   *
   * `snapshot()` answers the *renderer's* question and is lossy by design; exporting a project
   * has to write the model itself, unsaved edits included, so `WorkspaceService.exportProject`
   * reads it here rather than round-tripping the folder through disk.
   */
  model(): Project | undefined {
    return this.open?.project;
  }

  /** The open project's model and the folder it is saved in, or `undefined` when none is open. */
  savedProject(): { readonly project: Project; readonly dir: string } | undefined {
    return this.open === undefined ? undefined : { project: this.open.project, dir: this.open.dir };
  }

  private require(): OpenProject {
    if (this.open === undefined) {
      throw new ProjectError('no-project', 'No project is open');
    }
    return this.open;
  }

  private emitChanged(): void {
    this.hooks.onChanged?.(this.snapshot());
  }

  /** Creates a new project in an empty (or not yet existing) folder and opens it. */
  async create(input: { dir: string; name: string }): Promise<ProjectWire> {
    if (!(await isEmptyDir(input.dir))) {
      throw new ProjectError('project-dir-not-empty', `"${input.dir}" is not empty`, { details: { dir: input.dir } });
    }
    await mkdir(input.dir, { recursive: true });
    await this.closeInternal();
    this.adopt(createProject(input.name.trim().length > 0 ? input.name : projectNameFromDir(input.dir)), input.dir, []);
    await this.save({ reason: 'create' });
    this.emitChanged();
    return this.snapshot() as ProjectWire;
  }

  /**
   * Opens an existing project folder, then hydrates its definitions in the background.
   *
   * With `unsaved`, the unsaved changes a previous session left behind are laid back over the
   * folder (see `mergeUnsaved`) before the project is adopted, and the project opens dirty —
   * nothing is written. When the merged files will not load, the folder opens as it is on disk
   * and the outcome says why. {@link lastRestore} reports what happened.
   */
  async openProject(dir: string, options: { unsaved?: UnsavedProjectFiles } = {}): Promise<ProjectWire> {
    const loaded = await loadProject(dir);
    let { project, problems } = loaded;
    const disk = projectFiles(loaded.project);
    let restore: UnsavedRestoreOutcome | undefined;
    if (options.unsaved !== undefined) {
      const merge = mergeUnsaved(options.unsaved.baseline, disk, options.unsaved.unsaved);
      if (!merge.changed) {
        restore = { status: 'unchanged' };
      } else {
        try {
          ({ project, problems } = await loadProject(dir, { fs: overlayFs(dir, merge.files, disk.keys()) }));
          restore = { status: 'restored', conflicts: merge.conflicts, dropped: merge.dropped };
        } catch (error) {
          restore = { status: 'failed', message: errorMessage(error) };
        }
      }
    }
    await this.closeInternal();
    this.adopt(
      project,
      dir,
      problems.map((problem) => ({ code: problem.code, message: problem.message, file: problem.file })),
      disk,
    );
    this.restore = restore;
    if (restore?.status === 'restored') {
      this.markDirty();
    }
    this.emitChanged();
    this.hydrating = this.hydrateAll();
    return this.snapshot() as ProjectWire;
  }

  /** What the last {@link openProject} did with the unsaved record it was given, if any. */
  lastRestore(): UnsavedRestoreOutcome | undefined {
    return this.restore;
  }

  /**
   * The open project's unsaved changes as a record a later session can restore — both sides of
   * the merge — or `undefined` when there is nothing unsaved.
   */
  unsavedFiles(): UnsavedProjectFiles | undefined {
    const open = this.open;
    if (open === undefined || !open.dirty) {
      return undefined;
    }
    return { baseline: open.baseline, unsaved: projectFiles(open.project) };
  }

  /** Paths announced through {@link expectOnDisk}, kept until their TTL so a reload's new watcher honours them too. */
  private expectedOnDisk: { readonly paths: readonly string[]; readonly until: number }[] = [];

  /**
   * Marks `paths` (relative to the project folder) as about to be written by someone other than
   * this host but on the app's behalf — a sync pull — so the watcher does not report them as an
   * outside edit. Remembered for the watcher's self-write TTL and re-applied to the fresh watcher
   * {@link reload} creates, because the pull's own events can reach that watcher late.
   */
  expectOnDisk(paths: readonly string[]): void {
    const now = Date.now();
    this.expectedOnDisk = [
      ...this.expectedOnDisk.filter((entry) => entry.until > now),
      { paths: [...paths], until: now + SELF_WRITE_TTL_MS },
    ];
    this.open?.watcher.expect(paths);
  }

  /** Re-reads the folder from disk, discarding any unsaved in-memory changes. */
  async reload(): Promise<ProjectWire | null> {
    const open = this.open;
    if (open === undefined) {
      return null;
    }
    // Reload is explicitly "take what is on disk"; clearing the flag stops the close path
    // from writing the in-memory edits back out on the way past.
    open.dirty = false;
    return this.openProject(open.dir);
  }

  /**
   * Closes the open project. By default a dirty project is saved first; with `keepUnsaved` it is
   * not — the caller has already taken {@link unsavedFiles} and keeps them for a later session.
   */
  async close(options: { keepUnsaved?: boolean } = {}): Promise<null> {
    await this.closeInternal(options);
    this.emitChanged();
    return null;
  }

  /** Resolves once the background hydration started by {@link openProject} has finished. */
  async whenHydrated(): Promise<void> {
    await this.hydrating;
  }

  private adopt(project: Project, dir: string, problems: ProjectProblemWire[], baseline?: ProjectFiles): void {
    const watcher = new ProjectWatcher({
      dir,
      onChange: (paths) => this.hooks.onChangedOnDisk?.(paths),
    });
    this.open = {
      project,
      dir,
      dirty: false,
      lastSavedAt: undefined,
      problems,
      runtime: new Map(project.interfaces.map((iface) => [iface.id, { hydration: 'pending' as const }])),
      lastWritten: undefined,
      baseline: baseline ?? projectFiles(project),
      watcher,
    };
    const now = Date.now();
    this.expectedOnDisk = this.expectedOnDisk.filter((entry) => entry.until > now);
    for (const entry of this.expectedOnDisk) {
      watcher.expect(entry.paths);
    }
    watcher.start();
  }

  private async closeInternal(options: { keepUnsaved?: boolean } = {}): Promise<void> {
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
      this.autosave = undefined;
    }
    if (this.open === undefined) {
      return;
    }
    if (this.open.dirty && options.keepUnsaved !== true) {
      await this.save({ reason: 'close' });
    }
    this.open.watcher.stop();
    // Parsed keystores are decrypted key material: they must not outlive the project they
    // belong to, and a reopened project re-reads (and re-authorises) every file anyway.
    this.keystoreCache.clear();
    // A contract memo belongs to this project's cache folder; a reopen reads it again.
    this.asyncApiContracts.clear();
    this.asyncApiInfo.clear();
    this.openApiDocuments.clear();
    for (const iface of this.open.project.interfaces) {
      this.engine.close(iface.id);
    }
    this.open = undefined;
  }

  /**
   * Writes the project to disk. Also invoked by the autosave timer and on `before-quit`.
   *
   * Saves are serialised through {@link saveQueue}: a manual save and the before-quit save can
   * otherwise overlap, and `saveProject` prunes the files its own snapshot no longer mentions —
   * two interleaved runs would have the later prune delete a file the earlier write had just
   * put there. Queued saves are not coalesced: each one still writes the model as it stands
   * when its turn comes, which is what a `close`/`quit` save has to do.
   */
  save(options: { reason: string; backups?: readonly string[] } = { reason: 'manual' }): Promise<ProjectSaveResult> {
    // The timer is cancelled up front, not inside the queued work: whatever is queued already
    // writes whatever the model holds by then, so a pending autosave has nothing left to do.
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
      this.autosave = undefined;
    }
    const next = this.saveQueue.then(
      () => this.saveNow(options),
      () => this.saveNow(options),
    );
    // The chain itself must never stay rejected, or one failed save would poison every later
    // one; the caller's own `await` still sees the rejection.
    this.saveQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** One save, run with the queue held; see {@link save}. */
  private async saveNow(options: { reason: string; backups?: readonly string[] }): Promise<ProjectSaveResult> {
    const open = this.open;
    if (open === undefined) {
      return { saved: false, written: 0, removed: 0 };
    }
    // Capture the model being written before the await: `mutate` can replace `open.project`
    // with a newer one while the write is in flight, and bookkeeping below must describe the
    // model that was actually saved, not whatever happens to be open afterwards.
    const model = open.project;
    const result = await saveProject(model, open.dir, {
      ...(open.lastWritten !== undefined ? { previous: open.lastWritten } : {}),
      writer: PROJECT_WRITER,
      ...(options.backups !== undefined ? { backups: options.backups } : {}),
      ...(this.fs !== undefined ? { fs: this.fs } : {}),
    });
    open.watcher.expect([...result.written, ...result.removed]);
    open.lastWritten = projectFiles(model, { writer: PROJECT_WRITER });
    open.baseline = open.lastWritten;
    if (open.project === model) {
      open.dirty = false;
    } else {
      // A mutation landed mid-write: `lastWritten` now describes disk, but the newer edit
      // never made it out, so stay dirty and schedule another autosave to pick it up.
      this.markDirty();
    }
    open.lastSavedAt = new Date().toISOString();
    this.emitChanged();
    if (result.written.length > 0 || result.removed.length > 0) {
      this.hooks.onSaved?.({ reason: options.reason, written: result.written, removed: result.removed });
    }
    return {
      saved: true,
      savedAt: open.lastSavedAt,
      written: result.written.length,
      removed: result.removed.length,
      ...(options.backups !== undefined ? { backups: result.backups } : {}),
    };
  }

  /**
   * Whether edits should write themselves out. Off unless the user turned it on: a project
   * folder is theirs, and a tool that writes to it behind them is one they cannot experiment
   * in. `undefined` preferences (tests that inject none) take the same default as a real user
   * who has never opened Settings.
   */
  private autosaveEnabled(): boolean {
    return this.prefs()?.editor.autosave ?? DEFAULT_PREFERENCES.editor.autosave;
  }

  /**
   * Records that the model no longer matches disk, and — only with autosave on — schedules the
   * write. With it off the project simply stays dirty until {@link save} is called: by ⌘S, by
   * closing the workspace, or by quitting, none of which this flag touches.
   */
  private markDirty(): void {
    const open = this.require();
    open.dirty = true;
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
      this.autosave = undefined;
    }
    if (!this.autosaveEnabled()) {
      return;
    }
    this.autosave = setTimeout(() => {
      this.autosave = undefined;
      void this.save({ reason: 'autosave' });
    }, AUTOSAVE_DEBOUNCE_MS);
    this.autosave.unref?.();
  }

  /**
   * Picks up an outstanding edit when autosave is switched on mid-session, so turning it on
   * does not leave the one change the user made just before doing so sitting unwritten.
   */
  onAutosaveEnabled(): void {
    if (this.open?.dirty === true && this.autosave === undefined && this.autosaveEnabled()) {
      this.markDirty();
    }
  }

  /** Applies one change to the model, marks the project dirty and schedules an autosave. */
  async mutate(change: ProjectChange): Promise<{
    project: ProjectWire;
    createdId?: string;
    createdRequestId?: string;
    createdEnvironmentId?: string;
    createdAttachmentId?: string;
    createdKeystoreId?: string;
    createdWssOutgoingId?: string;
    createdWssIncomingId?: string;
  }> {
    const open = this.require();
    const result = await applyChange(open.project, change, {
      addAttachmentFile: (input) => this.readAttachmentSource(open.dir, input),
      allowsKeystorePath: (path) => allowsReadPath([open.dir], this.picks, resolvePath(open.dir, path)),
      generate: (interfaceId, bindingName, operationName) => {
        const options = generateOptionsFrom(this.prefs());
        const generated = this.engine.generate({
          interfaceId,
          bindingName,
          operationName,
          ...(options !== undefined ? { options } : {}),
        });
        return Promise.resolve({
          envelopeXml: generated.envelopeXml,
          soapVersion: generated.soapVersion,
          ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
        });
      },
    });
    open.project = result.project;
    if (change.kind === 'remove-interface') {
      open.runtime.delete(change.interfaceId);
      this.engine.close(change.interfaceId);
    }
    if (change.kind === 'remove-grpc-api') {
      this.protoSets.delete(change.apiId);
    }
    if (change.kind === 'remove-api') {
      // The parsed definition belongs to the API's cache folder, which the removal takes with it.
      this.openApiDocuments.delete(change.apiId);
    }
    // Parsed keystores are decrypted key material keyed by entry id: a removed entry must not
    // leave its key in memory, and a re-entered password must not be shadowed by the previous
    // parse — the cache key cannot see a secret changing *underneath an unchanged ref*.
    if (change.kind === 'remove-keystore') {
      this.keystoreCache.delete(change.keystoreId);
    }
    if (change.kind === 'update-keystore' && change.patch.passwordSecretRef !== undefined) {
      this.keystoreCache.delete(change.keystoreId);
    }
    this.markDirty();
    this.emitChanged();
    return {
      project: this.snapshot() as ProjectWire,
      ...(result.createdId !== undefined ? { createdId: result.createdId } : {}),
      ...(result.createdRequestId !== undefined ? { createdRequestId: result.createdRequestId } : {}),
      ...(result.createdEnvironmentId !== undefined ? { createdEnvironmentId: result.createdEnvironmentId } : {}),
      ...(result.createdAttachmentId !== undefined ? { createdAttachmentId: result.createdAttachmentId } : {}),
      ...(result.createdKeystoreId !== undefined ? { createdKeystoreId: result.createdKeystoreId } : {}),
      ...(result.createdWssOutgoingId !== undefined ? { createdWssOutgoingId: result.createdWssOutgoingId } : {}),
      ...(result.createdWssIncomingId !== undefined ? { createdWssIncomingId: result.createdWssIncomingId } : {}),
    };
  }

  /** The keystore registry entry with this id, or `undefined` when no project has one. */
  private keystoreDef(keystoreId: string): KeystoreDef | undefined {
    const ref = this.open?.project.wss.keystores.find((candidate) => candidate.id === keystoreId);
    if (ref === undefined) {
      return undefined;
    }
    try {
      return toKeystoreDef(ref);
    } catch {
      return undefined;
    }
  }

  /**
   * Loads (and caches) one keystore's material.
   *
   * The cache key is the resolved path, its mtime and size, and the password ref: a keystore
   * re-exported over the same path, or a password the user replaced, invalidates the entry
   * without anyone having to remember to clear it. The parsed material never leaves main.
   *
   * @throws WirebenchError `keystore-outside-project` when the file may not be read,
   * `keystore-unreadable` when it is gone, or the loader's own `keystore-*` codes
   */
  private async loadKeystoreFor(def: KeystoreDef): Promise<Keystore> {
    const open = this.require();
    const path = resolvePath(open.dir, def.path);
    if (!(await allowsReadPath([open.dir], this.picks, path))) {
      throw new WirebenchError(
        'keystore-outside-project',
        `The keystore "${def.name}" is outside the project folder; add it again through the file picker.`,
        { details: { id: def.id } },
      );
    }
    let info: Stats;
    try {
      info = await stat(path);
    } catch (error) {
      throw new WirebenchError('keystore-unreadable', `The keystore file "${def.path}" could not be read.`, {
        details: { id: def.id },
        cause: error,
      });
    }
    const key = `${path}|${String(info.mtimeMs)}|${String(info.size)}|${def.passwordSecretRef ?? ''}`;
    const cached = this.keystoreCache.get(def.id);
    if (cached !== undefined && cached.key === key) {
      return cached.keystore;
    }
    const password = def.passwordSecretRef === undefined ? undefined : await this.secrets?.get(def.passwordSecretRef);
    const bytes = await readFile(path);
    const keystore = loadKeystore(bytes, { type: def.type, ...(password !== undefined ? { password } : {}) });
    this.keystoreCache.set(def.id, { key, keystore });
    return keystore;
  }

  /**
   * What the Keystores view shows for one row: whether the file loads, and the aliases it holds.
   * Deliberately returns *metadata only* — never a key or a certificate PEM — because this is
   * the one keystore result that crosses the context bridge.
   */
  async inspectKeystore(keystoreId: string): Promise<KeystoresInspectResponse> {
    const def = this.keystoreDef(keystoreId);
    if (def === undefined) {
      return { status: 'not-found', aliases: [] };
    }
    try {
      const keystore = await this.loadKeystoreFor(def);
      return {
        status: 'ok',
        aliases: keystore.aliases.map((alias) => ({
          alias: alias.alias,
          subject: alias.subject,
          issuer: alias.issuer,
          notAfter: alias.notAfter,
          fingerprintSha256: alias.fingerprintSha256,
          hasPrivateKey: alias.hasPrivateKey,
        })),
      };
    } catch (error) {
      const code = error instanceof WirebenchError ? error.code : 'keystore-invalid';
      const message = error instanceof Error ? error.message : String(error);
      const status =
        code === 'keystore-bad-password'
          ? 'bad-password'
          : code === 'keystore-outside-project'
            ? 'outside-project'
            : code === 'keystore-unreadable'
              ? 'not-found'
              : 'invalid';
      return { status, aliases: [], message };
    }
  }

  /**
   * The TLS options a send of `requestId` must use, or `undefined` when nothing in the
   * project or the preferences has anything to say about TLS.
   *
   * Three independent things are folded in here, all of which need main's file system or its
   * secret store and so cannot live in the synchronous {@link sendInputFor} whose result also
   * feeds the cURL export: the client identity (the request's keystore, else the global one
   * from preferences — request wins), the extra trust anchors from the preferred CA bundle,
   * and the resolved endpoint's `trustInvalid` opt-out.
   *
   * A selected-but-unloadable keystore throws rather than silently sending without a client
   * certificate: a mutual-TLS request that quietly degrades is the worst possible outcome.
   * A CA bundle that will not load is *not* fatal — it only ever adds anchors, so a bad path
   * leaves verification exactly as strict as it was.
   */
  /**
   * Resolves one REST send the way this project is actually open: the API's base URL under the
   * active environment (a linked project's own first, then the workspace's), property expansion
   * across every scope, the folder chain's credentials, and the settings ladder.
   *
   * Synchronous and material-free, like `sendInputFor`: the credentials come back as `secretRef`s
   * and the TLS identity is resolved separately, so the same result can feed the cURL export and
   * the preflight badge without touching the keychain.
   */
  restSend(requestId: string, draft?: RestRequestPatchWire): RestSendResolution | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const project = this.open.project;
    const context = this.workspaceContext?.();
    const preferences = this.prefs();
    return resolveRestSend({
      project,
      requestId,
      ...(draft !== undefined ? { draft } : {}),
      scopes: this.scopesFor(),
      ...(preferences !== undefined ? { preferences } : {}),
      resolveBaseUrl: (api) =>
        context === undefined
          ? resolveApiBaseUrl(project, project.activeEnvironmentId, api)
          : resolveWorkspaceApiBaseUrl({
              workspace: context.workspace,
              project,
              projectSlug: context.projectSlug,
              api,
            }),
      ...(this.restCookiesFor(requestId) !== undefined ? { cookies: this.restCookiesFor(requestId)! } : {}),
    });
  }

  /**
   * The credentials configured on one API, folder or REST request — its own, not its chain's.
   *
   * What the Auth inspector edits and what the OAuth2 channels read: a token is obtained for the
   * entity that configures it, not for whatever request happened to ask.
   */
  restAuthOf(ownerId: string): AuthConfig | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const project = this.open.project;
    const api = project.apis.find((candidate) => candidate.id === ownerId);
    if (api !== undefined) {
      return api.auth;
    }
    const folder = findRestFolder(project, ownerId);
    if (folder !== undefined) {
      return folder.auth;
    }
    return findRestRequest(project, ownerId)?.auth;
  }

  /**
   * What History names a REST send by: the request, its API, and the folder path inside it.
   *
   * The REST counterpart of {@link requestMeta}, and shaped to the same three slots, so a history
   * row needs no per-protocol branching: the API's name takes the interface's place and the folder
   * path the operation's.
   */
  restMeta(
    requestId: string,
  ): { readonly requestName: string; readonly apiName: string; readonly folderPath: string } | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    for (const api of this.open.project.apis) {
      const found = restPathWithin(api, requestId, []);
      if (found !== undefined) {
        return { requestName: found.request.name, apiName: api.name, folderPath: found.folders.join(' / ') };
      }
    }
    return undefined;
  }

  /**
   * The cookies this REST request's own last response set, when its *send cookies* setting is on.
   *
   * Session-only and per request, deliberately: there is no jar, so one request's send never
   * depends on another's, and nothing about cookies reaches disk.
   */
  private restCookiesFor(requestId: string): readonly Cookie[] | undefined {
    const request = this.open === undefined ? undefined : findRestRequest(this.open.project, requestId);
    if (request?.settings.sendCookies !== true) {
      return undefined;
    }
    return this.restCookies.get(requestId);
  }

  /** Remembers what a REST response set, for the next send of that same request. */
  rememberRestCookies(requestId: string, cookies: readonly Cookie[]): void {
    if (cookies.length === 0) {
      this.restCookies.delete(requestId);
      return;
    }
    this.restCookies.set(requestId, cookies);
  }

  /**
   * The TLS material a REST send needs: the trust anchors, the client identity its settings select,
   * and its own `trustInvalid` flag. The REST counterpart of {@link tlsFor}, reading the request's
   * settings rather than a SOAP request's properties and an endpoint's flag.
   */
  async restTlsFor(requestId: string): Promise<TlsOptionsWire | undefined> {
    if (this.open === undefined) {
      return undefined;
    }
    const request = findRestRequest(this.open.project, requestId);
    const identity = await this.clientIdentityFor(request?.settings.sslKeystoreRef);
    const ca = await this.trustAnchors();
    const trustInvalid = request?.settings.trustInvalid === true;
    if (identity === undefined && ca === undefined && !trustInvalid) {
      return undefined;
    }
    return {
      ...(identity !== undefined ? identity : {}),
      ...(ca !== undefined ? { ca: [...ca] } : {}),
      ...(trustInvalid ? { rejectUnauthorized: false } : {}),
    };
  }

  /**
   * Resolves one gRPC call the way this project is open: the API's target under the active
   * environment (the same override slot a REST base URL has, keyed by the API's slug), property
   * expansion, the folder chain's credentials as refs, and the settings ladder. Synchronous and
   * material-free like {@link restSend}; the `.proto` set and the secrets are resolved by the caller.
   */
  grpcSend(requestId: string, draft?: GrpcRequestPatchWire): GrpcSendResolution | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const project = this.open.project;
    const context = this.workspaceContext?.();
    const preferences = this.prefs();
    return resolveGrpcSend({
      project,
      requestId,
      ...(draft !== undefined ? { draft } : {}),
      scopes: this.scopesFor(),
      ...(preferences !== undefined ? { preferences } : {}),
      resolveTarget: (api) => {
        const asApi = { slug: api.slug, baseUrl: api.target };
        return context === undefined
          ? resolveApiBaseUrl(project, project.activeEnvironmentId, asApi)
          : resolveWorkspaceApiBaseUrl({
              workspace: context.workspace,
              project,
              projectSlug: context.projectSlug,
              api: asApi,
            });
      },
    });
  }

  /** The credentials configured on one gRPC API, folder or request — its own, not its chain's. */
  grpcAuthOf(ownerId: string): AuthConfig | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const project = this.open.project;
    const api = project.grpcApis.find((candidate) => candidate.id === ownerId);
    if (api !== undefined) {
      return api.auth;
    }
    return findGrpcFolder(project, ownerId)?.auth ?? findGrpcRequest(project, ownerId)?.auth;
  }

  /** What History names a gRPC send by: the request, its API, and the folder path inside it. */
  grpcMeta(
    requestId: string,
  ): { readonly requestName: string; readonly apiName: string; readonly folderPath: string } | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const located = locateGrpcRequest(this.open.project, requestId);
    if (located === undefined) {
      return undefined;
    }
    return {
      requestName: located.request.name,
      apiName: located.api.name,
      folderPath: located.folders.map((folder) => folder.name).join(' / '),
    };
  }

  /** The TLS material a gRPC call needs, read from the request's settings as {@link restTlsFor} does. */
  async grpcTlsFor(requestId: string): Promise<TlsOptionsWire | undefined> {
    if (this.open === undefined) {
      return undefined;
    }
    const request = findGrpcRequest(this.open.project, requestId);
    const identity = await this.clientIdentityFor(request?.settings.sslKeystoreRef);
    const ca = await this.trustAnchors();
    const trustInvalid = request?.settings.trustInvalid === true;
    if (identity === undefined && ca === undefined && !trustInvalid) {
      return undefined;
    }
    return {
      ...(identity !== undefined ? identity : {}),
      ...(ca !== undefined ? { ca: [...ca] } : {}),
      ...(trustInvalid ? { rejectUnauthorized: false } : {}),
    };
  }

  /** What History names a WebSocket send by: the request, its API, and the folder path inside it. */
  wsMeta(
    requestId: string,
  ): { readonly requestName: string; readonly apiName: string; readonly folderPath: string } | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const located = locateWsRequest(this.open.project, requestId);
    if (located === undefined) {
      return undefined;
    }
    return {
      requestName: located.request.name,
      apiName: located.api.name,
      folderPath: located.folders.map((folder) => folder.name).join(' / '),
    };
  }

  /** The TLS material a WebSocket call needs, read from the request's settings as {@link grpcTlsFor} does. */
  async wsTlsFor(requestId: string): Promise<TlsOptionsWire | undefined> {
    if (this.open === undefined) {
      return undefined;
    }
    const request = findWsRequest(this.open.project, requestId);
    const identity = await this.clientIdentityFor(request?.settings.sslKeystoreRef);
    const ca = await this.trustAnchors();
    const trustInvalid = request?.settings.trustInvalid === true;
    if (identity === undefined && ca === undefined && !trustInvalid) {
      return undefined;
    }
    return {
      ...(identity !== undefined ? identity : {}),
      ...(ca !== undefined ? { ca: [...ca] } : {}),
      ...(trustInvalid ? { rejectUnauthorized: false } : {}),
    };
  }

  /**
   * Resolves one WebSocket call the way this project is open: the API's target under the active
   * environment (the same override slot a REST/gRPC target has, keyed by the API's slug), property
   * expansion, the folder chain's credentials as refs, and the settings ladder. Synchronous and
   * material-free like {@link grpcSend}; secrets are resolved by the caller.
   */
  wsSend(requestId: string, draft?: WsRequestPatchWire): WsSendResolution | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const project = this.open.project;
    const context = this.workspaceContext?.();
    const preferences = this.prefs();
    return resolveWsSend({
      project,
      requestId,
      ...(draft !== undefined ? { draft } : {}),
      scopes: this.scopesFor(),
      ...(preferences !== undefined ? { preferences } : {}),
      resolveTarget: (api) => {
        const asApi = { slug: api.slug, baseUrl: api.url };
        return context === undefined
          ? resolveApiBaseUrl(project, project.activeEnvironmentId, asApi)
          : resolveWorkspaceApiBaseUrl({
              workspace: context.workspace,
              project,
              projectSlug: context.projectSlug,
              api: asApi,
            });
      },
    });
  }

  /** The gRPC API that is, or that holds, `entityId`. */
  private grpcApiOf(entityId: string): GrpcApi | undefined {
    const project = this.require().project;
    return project.grpcApis.find((api) => api.id === entityId) ?? grpcApiOwning(project, entityId);
  }

  /**
   * The loaded `.proto` set of the gRPC API that is, or holds, `entityId`, parsed from the API's
   * definition cache and kept for the session.
   *
   * @throws ProjectError `not-found` for an id no gRPC API owns, `definition-cache-missing` for an
   * API whose files were never cached — a send then has no schema to encode against, and says so
   * rather than guessing
   */
  grpcProtoSetFor(entityId: string): Promise<ProtoSet> {
    const api = this.grpcApiOf(entityId);
    if (api === undefined) {
      throw new ProjectError('not-found', `No gRPC API owns "${entityId}"`, { details: { id: entityId } });
    }
    const cached = this.protoSets.get(api.id);
    if (cached !== undefined) {
      return cached;
    }
    const dir = this.require().dir;
    const loading = readGrpcDefinitionCache(apiDefinitionDir(dir, api.slug)).then((cache) =>
      cache.kind === 'proto'
        ? loadProtoSet(cache.sources, { roots: cache.manifest.roots })
        : protoSetFromDescriptorSet(cache.descriptors, { roots: cache.manifest.roots }),
    );
    // A failed load is not remembered: the user may fix the cache (a re-import) and try again.
    loading.catch(() => {
      this.protoSets.delete(api.id);
    });
    this.protoSets.set(api.id, loading);
    return loading;
  }

  /** The services and files of a gRPC API's cached definition, for the method picker and the card. */
  async grpcDefinition(apiId: string): Promise<{
    readonly services: readonly GrpcServiceDescriptor[];
    readonly files: readonly { readonly path: string; readonly size: number }[];
    readonly source: string;
    readonly fetchedAt: string;
    readonly roots: readonly string[];
    readonly kind: 'proto' | 'reflection';
    readonly reflectionVersion?: 'v1' | 'v1alpha';
  }> {
    const api = this.requireGrpcApi(apiId);
    const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.require().dir, api.slug));
    const set = await this.grpcProtoSetFor(apiId);
    // A discovered definition is one binary file; an imported one is the `.proto` files themselves.
    const files =
      cache.kind === 'proto'
        ? cache.manifest.files.map((file) => ({ path: file.path, size: file.bytes }))
        : [{ path: cache.manifest.file.path, size: cache.manifest.file.bytes }];
    return {
      services: describeServices(set),
      files,
      source: cache.manifest.source,
      fetchedAt: cache.manifest.fetchedAt,
      roots: cache.manifest.roots,
      kind: cache.kind === 'proto' ? 'proto' : 'reflection',
      ...(cache.kind === 'descriptors' && cache.manifest.reflectionVersion !== undefined
        ? { reflectionVersion: cache.manifest.reflectionVersion }
        : {}),
    };
  }

  /** A sample message for one type of a gRPC API's definition, as pretty JSON text. */
  async grpcSample(apiId: string, type: string): Promise<string> {
    return sampleMessageText(await this.grpcProtoSetFor(apiId), type);
  }

  /**
   * The fields of the message reached by walking `path` — a chain of JSON object keys — down from
   * `type`, for the message editor's completion provider.
   *
   * A path that names nothing answers no fields rather than failing: the provider asks about a
   * document the user is in the middle of typing, where a key that resolves to nothing is the
   * normal case. An unknown `type` still fails, since that is the caller's own mistake.
   */
  async grpcFields(apiId: string, type: string, path: readonly string[]): Promise<MessageDescriptor | undefined> {
    return describeMessageAt(await this.grpcProtoSetFor(apiId), type, path);
  }

  /** The open project's gRPC API with `apiId`, or a `not-found` error. */
  private requireGrpcApi(apiId: string): GrpcApi {
    const api = this.require().project.grpcApis.find((candidate) => candidate.id === apiId);
    if (api === undefined) {
      throw new ProjectError('not-found', `No gRPC API with id "${apiId}"`, { details: { id: apiId } });
    }
    return api;
  }

  /**
   * Writes a gRPC API's definition cache, in whichever of the two forms it arrived in, and tells the
   * watcher the files are this host's own work — an import would otherwise end with a "changed on
   * disk — reload" banner over its own write.
   */
  private async writeGrpcDefinition(
    definitionDir: string,
    source: string,
    roots: readonly string[],
    definition: GrpcDefinitionInput,
  ): Promise<void> {
    if (definition.kind === 'proto') {
      const manifest = await writeProtoDefinitionCache(definition.sources, definitionDir, { source, roots });
      this.expectOnDisk([
        join(definitionDir, 'manifest.yaml'),
        ...manifest.files.map((file) => join(definitionDir, PROTOS_DIR, ...protoPathSegments(file.path))),
      ]);
      return;
    }
    await writeDescriptorDefinitionCache(definition.descriptors, definitionDir, {
      source,
      roots,
      reflectionVersion: definition.version,
    });
    this.expectOnDisk([join(definitionDir, 'manifest.yaml'), join(definitionDir, DESCRIPTORS_FILE)]);
  }

  /**
   * Places an imported or discovered gRPC API in the project, caching what it was made of under its
   * own folder once the slug is settled — as {@link addApi} does for an OpenAPI import.
   * Saves immediately: an import is never lost to a crash.
   */
  async addGrpcApi(
    input: {
      readonly api: GrpcApi;
      readonly roots: readonly string[];
      /** Where the user pointed at, recorded on the API as its definition's source. */
      readonly source: string;
      readonly cache?: boolean;
      /** The version the user asked for, remembered so a refresh asks the same way. */
      readonly requestedVersion?: GrpcReflectionVersion;
    } & GrpcDefinitionInput,
  ): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.require();
    const taken = new Set([
      ...open.project.apis.map((api) => api.slug),
      ...open.project.grpcApis.map((api) => api.slug),
      ...open.project.interfaces.map((iface) => iface.slug),
    ]);
    const slug = uniqueSlug(input.api.name, taken);
    const cache = input.cache ?? this.prefs()?.wsdl.cacheDefinitions ?? true;
    if (cache) {
      await this.writeGrpcDefinition(apiDefinitionDir(open.dir, slug), input.source, input.roots, input);
    }
    const api: GrpcApi = {
      ...input.api,
      slug,
      order: open.project.interfaces.length + open.project.apis.length + open.project.grpcApis.length,
      definition: {
        kind: input.kind === 'proto' ? 'proto' : 'reflection',
        source: input.source,
        cache,
        roots: [...input.roots],
        ...(input.kind === 'reflection'
          ? {
              reflectionVersion: input.requestedVersion ?? 'auto',
              ...(input.trustInvalid ? { trustInvalid: true } : {}),
            }
          : {}),
      },
    };
    open.project = { ...open.project, grpcApis: [...open.project.grpcApis, api] };
    open.dirty = true;
    this.protoSets.delete(api.id);
    // The schema was just resolved for the import; keep it rather than re-reading the cache on the
    // first send.
    this.protoSets.set(
      api.id,
      Promise.resolve(
        input.kind === 'proto'
          ? loadProtoSet(input.sources, { roots: input.roots })
          : protoSetFromDescriptorSet(input.descriptors, { roots: input.roots }),
      ),
    );
    await this.save({ reason: 'import' });
    return { project: this.snapshot() as ProjectWire, apiId: api.id };
  }

  /**
   * Asks a reflection-sourced API's server to describe itself again, rewrites its cache and brings
   * the request tree in line with what came back.
   *
   * Nothing is deleted: {@link reconcileGrpcApi} keeps a request whose method is gone and badges it
   * orphaned instead, and adds one for a method the server has gained.
   *
   * @throws ProjectError `not-found` for an id no gRPC API owns, `definition-not-discovered` for an
   * API that was imported from files rather than discovered
   */
  async refreshGrpcDefinition(
    apiId: string,
    options: { readonly version?: GrpcReflectionVersion; readonly signal?: AbortSignal } = {},
  ): Promise<{
    readonly project: ProjectWire;
    readonly summary: ProtoImportSummary & { readonly name: string; readonly target: string };
    readonly reconciled: GrpcReconcileResult;
    readonly version: 'v1' | 'v1alpha';
  }> {
    const open = this.require();
    const api = this.requireGrpcApi(apiId);
    const definition = api.definition;
    if (definition === undefined || definition.kind !== 'reflection') {
      throw new ProjectError(
        'definition-not-discovered',
        `"${api.name}" was imported from .proto files; there is no server to ask`,
        { details: { apiId } },
      );
    }
    const version = options.version ?? definition.reflectionVersion ?? 'auto';
    const trustInvalid = definition.trustInvalid === true;
    const tlsOptions = await this.grpcDiscoveryTls(trustInvalid);
    const expanded = expand(api.target, this.scopesFor()).text.trim();
    const discovered = await reflectProtoSet({
      // An API whose target is still blank is asked at the address it was discovered from.
      target: expanded === '' ? definition.source : expanded,
      tls: api.tls,
      metadata: [],
      timeoutMs: GRPC_REFLECTION_TIMEOUT_MS,
      version,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(tlsOptions !== undefined ? { tlsOptions } : {}),
    });
    const reconciled = reconcileGrpcApi(api, discovered.set);
    const next: GrpcApi = {
      ...reconciled.api,
      definition: {
        ...definition,
        roots: [...discovered.roots],
        reflectionVersion: version,
      },
    };
    if (definition.cache) {
      await this.writeGrpcDefinition(apiDefinitionDir(open.dir, api.slug), definition.source, discovered.roots, {
        kind: 'reflection',
        descriptors: descriptorSetBytes(discovered.files),
        version: discovered.version,
      });
    }
    open.project = {
      ...open.project,
      grpcApis: open.project.grpcApis.map((candidate) => (candidate.id === api.id ? next : candidate)),
    };
    open.dirty = true;
    this.protoSets.set(api.id, Promise.resolve(discovered.set));
    await this.save({ reason: 'import' });
    const services = describeServices(discovered.set);
    return {
      project: this.snapshot() as ProjectWire,
      summary: {
        name: next.name,
        target: next.target,
        files: discovered.files.size,
        services: services.length,
        methods: services.reduce((total, service) => total + service.methods.length, 0),
        deprecated: services.reduce(
          (total, service) => total + service.methods.filter((method) => method.deprecated === true).length,
          0,
        ),
      },
      reconciled: { ...reconciled, api: next },
      version: discovered.version,
    };
  }

  /** The TLS material a discovery uses: the configured trust anchors, and the user's trust decision. */
  async grpcDiscoveryTls(trustInvalid: boolean): Promise<TlsOptions | undefined> {
    const ca = await this.trustAnchors();
    if (ca === undefined && !trustInvalid) {
      return undefined;
    }
    return { ...(ca !== undefined ? { ca: [...ca] } : {}), ...(trustInvalid ? { rejectUnauthorized: false } : {}) };
  }

  async tlsFor(requestId: string): Promise<TlsOptionsWire | undefined> {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    const identity = await this.clientIdentityFor(location?.request.properties.sslKeystoreRef);
    const ca = await this.trustAnchors();
    const trustInvalid =
      location !== undefined &&
      this.resolveEndpointFor(this.open.project, location.iface, location.request).endpoint?.trustInvalid === true;
    if (identity === undefined && ca === undefined && !trustInvalid) {
      return undefined;
    }
    return {
      ...(identity !== undefined ? identity : {}),
      ...(ca !== undefined ? { ca: [...ca] } : {}),
      // Only ever `false`, and only from an endpoint the user explicitly flagged: there is no
      // global "trust everything", and `ssl.trustAll` is pinned false at the preference level.
      ...(trustInvalid ? { rejectUnauthorized: false } : {}),
    };
  }

  /**
   * The `cert`/`key` the handshake presents: the request's own keystore when it selects one,
   * otherwise the global `ssl.clientKeystoreRef` from preferences. The request wins, so a
   * request configured for a particular mutual-TLS service is not quietly overridden by a
   * default meant for everything else.
   */
  private async clientIdentityFor(requestKeystoreId: string | undefined): Promise<TlsOptionsWire | undefined> {
    const globalRef = this.prefs()?.ssl.clientKeystoreRef;
    const keystoreId =
      requestKeystoreId !== undefined && requestKeystoreId.length > 0
        ? requestKeystoreId
        : globalRef !== undefined && globalRef.length > 0
          ? globalRef
          : undefined;
    if (keystoreId === undefined) {
      return undefined;
    }
    const def = this.keystoreDef(keystoreId);
    if (def === undefined) {
      throw new WirebenchError(
        'keystore-missing',
        keystoreId === globalRef
          ? 'The keystore selected in Preferences is not in this project.'
          : 'This request selects a keystore the project no longer has.',
        { details: { keystoreId } },
      );
    }
    const keystore = await this.loadKeystoreFor(def);
    const identity = toTlsClientIdentity(keystore, def.defaultAlias);
    // `cert`/`key` only: a keystore says who *we* are. It never contributes `ca`, because Node
    // reads `ca` as a replacement trust store — see `toTlsClientIdentity`.
    return { cert: identity.cert, key: identity.key };
  }

  /**
   * The extra trust anchors from the preferred CA bundle, split into one PEM per certificate,
   * or `undefined` when no bundle is configured or it cannot be read.
   *
   * The path goes through the same read check every other user-named file does
   * ({@link allowsReadPath}): inside the project folder, or picked through a native dialog this
   * session. A bundle that fails either test, or fails to parse, adds nothing — which leaves
   * verification stricter, never looser, so failing quietly here is safe in the one direction
   * that matters.
   */
  private async trustAnchors(): Promise<readonly string[] | undefined> {
    const path = this.prefs()?.ssl.caBundlePath;
    const open = this.open;
    if (path === undefined || path.length === 0 || open === undefined) {
      return undefined;
    }
    const resolved = resolvePath(open.dir, path);
    if (!(await allowsReadPath([open.dir], this.picks, resolved))) {
      return undefined;
    }
    try {
      const anchors = splitPemBundle(await readFile(resolved, 'utf-8'));
      return anchors.length > 0 ? anchors : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The proxy a send to `url` must go through, or `undefined` for a direct connection.
   *
   * The stored `passwordRef` is resolved here — in main, against the OS keychain — and only
   * the resolved {@link ProxyOptionsWire} ever reaches the transport; the reference itself
   * never becomes a password on any wire the renderer can see. `resolveSystem` is injected by
   * the app (a wrapper around `session.resolveProxy`) so this class stays Electron-free.
   *
   * @throws WirebenchError `proxy-unsupported` when the system's answer is a SOCKS proxy, which
   * undici cannot dial: the send fails saying so rather than quietly going direct into a
   * firewall that drops it.
   */
  async proxyFor(url: string): Promise<ProxyOptionsWire | undefined> {
    const proxy = this.prefs()?.proxy;
    if (proxy === undefined || proxy.mode === 'none') {
      return undefined;
    }
    if (proxy.mode === 'system') {
      // The PAC lookup is skipped for an excluded host: `session.resolveProxy` can be slow
      // (it may run a PAC script), and a host the user has already said to reach directly has
      // nothing to gain from asking.
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return undefined;
      }
      if (isExcluded(hostname, proxy.excludes)) {
        return undefined;
      }
      const pac = await this.resolveSystemProxy?.(url);
      return resolveProxyFor(url, { mode: 'system', excludes: proxy.excludes }, { resolveSystem: () => pac });
    }
    const config: ProxyConfig = {
      mode: 'manual',
      host: proxy.host ?? '',
      port: proxy.port ?? 0,
      excludes: proxy.excludes,
      ...(proxy.username !== undefined ? { username: proxy.username } : {}),
      ...(proxy.passwordRef !== undefined ? { passwordRef: proxy.passwordRef } : {}),
    };
    const password =
      proxy.passwordRef !== undefined && proxy.passwordRef.length > 0
        ? await this.getSecret(proxy.passwordRef)
        : undefined;
    return resolveProxyFor(url, config, { ...(password !== undefined ? { password } : {}) });
  }

  /** The incoming WS-Security configuration with this id, or `undefined` when there is none. */
  private wssIncomingConfig(configId: string): WssIncomingConfig | undefined {
    const ref = this.open?.project.wss.incoming.find((candidate) => candidate.id === configId);
    if (ref === undefined) {
      return undefined;
    }
    try {
      return toWssIncomingConfig(ref);
    } catch {
      return undefined;
    }
  }

  /** The outgoing WS-Security configuration with this id, or `undefined` when there is none. */
  private wssOutgoingConfig(configId: string): WssOutgoingConfig | undefined {
    const ref = this.open?.project.wss.outgoing.find((candidate) => candidate.id === configId);
    if (ref === undefined) {
      return undefined;
    }
    try {
      return toWssOutgoingConfig(ref);
    } catch {
      return undefined;
    }
  }

  /**
   * The {@link WssContext} every WS-Security operation runs against: keystores read through the
   * same containment check every other read uses, and secrets decrypted through the secret
   * store. Both closures stay inside main — a resolved password never crosses the bridge.
   */
  private wssContext(): WssContext {
    return createWssContext({
      keystores: async (ref) => {
        const def = this.keystoreDef(ref);
        return def === undefined ? undefined : await this.loadKeystoreFor(def);
      },
      secrets: async (ref) => await this.secrets?.get(ref),
    });
  }

  /**
   * The WS-Security half of a send of `requestId`, or `undefined` when the request selects
   * neither an outgoing nor an incoming configuration. Async and secret-bearing, so — exactly like {@link tlsFor} — it is
   * kept out of the synchronous {@link sendInputFor} whose result also feeds the cURL export
   * and the renderer.
   *
   * A selected-but-missing configuration throws rather than sending an unsecured request: a
   * WS-Security send that quietly degrades is as bad as a mutual-TLS one that does.
   *
   * @param requestId the request about to be sent
   * @returns the configuration, the context and the request's WSS property overrides
   * @throws WirebenchError `wss-config-missing` when the project no longer has the configuration
   */
  /**
   * True when `requestId` selects an outgoing WS-Security configuration — synchronous and
   * secret-free, unlike {@link wssFor}, so `request.curl` can decide whether to note "WS-Security
   * is not included" without resolving a keystore just to check.
   */
  hasOutgoingWss(requestId: string): boolean {
    if (this.open === undefined) {
      return false;
    }
    const outgoingId = findRequest(this.open.project, requestId)?.request.wssOutgoingRef;
    return outgoingId !== undefined && outgoingId.length > 0;
  }

  wssFor(requestId: string): Promise<SoapSendWss | undefined> {
    if (this.open === undefined) {
      return Promise.resolve(undefined);
    }
    const location = findRequest(this.open.project, requestId);
    const outgoingId = location?.request.wssOutgoingRef;
    const incomingId = location?.request.wssIncomingRef;
    const selected = (id: string | undefined): string | undefined =>
      id === undefined || id.length === 0 ? undefined : id;
    if (location === undefined || (selected(outgoingId) === undefined && selected(incomingId) === undefined)) {
      return Promise.resolve(undefined);
    }
    const missing = (configId: string): Promise<never> =>
      Promise.reject(
        new WirebenchError(
          'wss-config-missing',
          'This request selects a WS-Security configuration the project no longer has.',
          { details: { configId } },
        ),
      );
    const outgoingRef = selected(outgoingId);
    const outgoing = outgoingRef === undefined ? undefined : this.wssOutgoingConfig(outgoingRef);
    if (outgoingRef !== undefined && outgoing === undefined) {
      return missing(outgoingRef);
    }
    const incomingRef = selected(incomingId);
    const incoming = incomingRef === undefined ? undefined : this.wssIncomingConfig(incomingRef);
    if (incomingRef !== undefined && incoming === undefined) {
      return missing(incomingRef);
    }
    const properties = location.request.properties;
    return Promise.resolve({
      ...(outgoing !== undefined ? { outgoing } : {}),
      ...(incoming !== undefined ? { incoming } : {}),
      ctx: this.wssContext(),
      requestProperties: {
        ...(properties.wssPasswordType !== undefined ? { wssPasswordType: properties.wssPasswordType } : {}),
        ...(properties.wssTimeToLive !== undefined ? { wssTimeToLive: properties.wssTimeToLive } : {}),
      },
    });
  }

  /** The envelope a WS-Security editor action starts from: what the editor holds, else the saved one. */
  private envelopeFor(requestId: string, envelopeXml?: string): string {
    if (envelopeXml !== undefined) {
      return envelopeXml;
    }
    const location = this.open === undefined ? undefined : findRequest(this.open.project, requestId);
    if (location === undefined) {
      throw new WirebenchError('not-found', `No request with id "${requestId}"`, { details: { requestId } });
    }
    return location.request.envelopeXml;
  }

  /**
   * The WSDL-derived default `wsa:Action` for a request's operation, as the import recorded it.
   * An interface that never hydrated (or an operation the current WSDL no longer exposes)
   * yields `''`, which the header builder treats as "no default action".
   */
  defaultWsaActionFor(requestId: string): string {
    if (this.open === undefined) {
      return '';
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return '';
    }
    const summary = this.open.runtime.get(location.iface.id)?.summary;
    return summary?.wsa?.defaultActionByOperation[`${location.operation.bindingName}|${location.operation.name}`] ?? '';
  }

  /**
   * The WS-Addressing half of a send of `requestId`, or `undefined` when the effective
   * configuration is disabled. Unlike {@link wssFor} this is synchronous and carries no secret,
   * so it rides on {@link sendInputFor}'s result rather than being folded in at send time.
   */
  wsaFor(requestId: string): { config: WsaConfig; defaultAction: string } | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const config = effectiveWsa(location.iface.wsa, location.request.wsa);
    return config.enabled ? { config, defaultAction: this.defaultWsaActionFor(requestId) } : undefined;
  }

  /**
   * Bakes the request's effective WS-Addressing headers into an envelope — the editor action,
   * as opposed to the send path, which writes the same headers on their way to the wire.
   *
   * @param requestId the request whose configuration to use
   * @param envelopeXml the envelope to address; the saved one when omitted
   * @throws WirebenchError `wsa-disabled` when the effective configuration is off
   */
  insertWsaHeaders(requestId: string, envelopeXml?: string): string {
    const wsa = this.wsaFor(requestId);
    if (wsa === undefined) {
      throw new WirebenchError('wsa-disabled', 'WS-Addressing is not enabled for this request.', {
        details: { requestId },
      });
    }
    const location = this.open === undefined ? undefined : findRequest(this.open.project, requestId);
    const request = location?.request;
    const endpoint =
      this.open === undefined || location === undefined
        ? ''
        : (this.resolveEndpointFor(this.open.project, location.iface, location.request).url ?? '');
    return applyWsaHeaders(this.envelopeFor(requestId, envelopeXml), wsa.config, {
      endpoint,
      ...(request?.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      defaultAction: wsa.defaultAction,
      uuid: () => randomUUID(),
      envelopeVersion: request?.soapVersion ?? '1.1',
    });
  }

  /**
   * Strips every `wsa:*` header, of either version, from the request's envelope text.
   *
   * @param requestId the request whose envelope is being edited
   * @param envelopeXml the envelope to clean; the saved one when omitted
   */
  removeWsaHeadersFrom(requestId: string, envelopeXml?: string): string {
    return stripWsaHeaders(this.envelopeFor(requestId, envelopeXml));
  }

  /**
   * Applies the request's own outgoing configuration to an envelope, for the preview and the
   * "apply to editor" action. The caller redacts the result before it leaves main.
   *
   * @param requestId the request whose configuration to use
   * @param envelopeXml the envelope to secure; the saved one when omitted
   * @returns the secured envelope
   * @throws WirebenchError `wss-config-missing` when the request selects no (or an unknown) configuration
   */
  async previewOutgoingWss(requestId: string, envelopeXml?: string): Promise<string> {
    const wss = await this.wssFor(requestId);
    if (wss?.outgoing === undefined) {
      throw new WirebenchError('wss-config-missing', 'This request has no outgoing WS-Security configuration.', {
        details: { requestId },
      });
    }
    return await applyOutgoingWss(this.envelopeFor(requestId, envelopeXml), wss.outgoing, wss.ctx, {
      ...(wss.requestProperties !== undefined ? { requestProperties: wss.requestProperties } : {}),
    });
  }

  /**
   * Applies one ad-hoc entry to an envelope — the "Add WSS Username Token…" / "Add
   * WS-Timestamp…" actions, which involve no stored configuration at all.
   *
   * @param requestId the request whose envelope is being edited
   * @param entry the single entry to write
   * @param envelopeXml the envelope to secure; the saved one when omitted
   * @returns the secured envelope
   */
  async insertWssEntry(requestId: string, entry: WssEntry, envelopeXml?: string): Promise<string> {
    const config: WssOutgoingConfig = {
      id: 'ad-hoc',
      name: 'Ad-hoc',
      mustUnderstand: false,
      entries: [entry],
    };
    return await applyOutgoingWss(this.envelopeFor(requestId, envelopeXml), config, this.wssContext());
  }

  /**
   * Strips the `wsse:Security` header the request's configuration writes (the ultimate
   * receiver's when it selects none).
   *
   * @param requestId the request whose envelope is being edited
   * @param envelopeXml the envelope to clean; the saved one when omitted
   * @returns the envelope without that header
   */
  removeOutgoingWssFrom(requestId: string, envelopeXml?: string): string {
    const configId =
      this.open === undefined ? undefined : findRequest(this.open.project, requestId)?.request.wssOutgoingRef;
    const actor = configId === undefined ? undefined : this.wssOutgoingConfig(configId)?.actor;
    const envelope = this.envelopeFor(requestId, envelopeXml);
    return actor === undefined ? removeOutgoingWss(envelope) : removeOutgoingWss(envelope, actor);
  }

  /**
   * Appends an attachment from bytes the renderer already holds — the drag-and-drop path.
   *
   * A dropped file's path is not evidence of anything (see {@link allowsAttachmentPath}), so a
   * drop never names one: the renderer sends what the browser sandbox handed it, and those
   * bytes go straight into `attachments/<sha256>`. A drop is therefore always a copy — there is
   * no path to reference — which is also why {@link MAX_DROPPED_ATTACHMENT_BYTES} caps it: the
   * bytes travel through IPC and are held in memory twice on the way.
   *
   * @param requestId the request to attach to
   * @param input the dropped file's name, its browser-sniffed media type (may be empty) and bytes
   * @returns the new attachment's id
   */
  async addAttachmentBytes(
    requestId: string,
    input: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array },
  ): Promise<string> {
    const open = this.require();
    if (input.bytes.byteLength > MAX_DROPPED_ATTACHMENT_BYTES) {
      throw new ProjectError(
        'attachment-too-large',
        `"${input.name}" is larger than the ${String(MAX_DROPPED_ATTACHMENT_BYTES / (1024 * 1024))} MiB drop limit`,
        { details: { name: input.name, size: input.bytes.byteLength, limit: MAX_DROPPED_ATTACHMENT_BYTES } },
      );
    }
    const name = sanitizeDroppedName(input.name);
    const contentType = input.contentType.trim().length > 0 ? input.contentType : contentTypeForPath(name);
    const { sha256, size } = await putAttachment(open.dir, input.bytes, {
      originalName: name,
      contentType,
    });
    const result = appendAttachment(open.project, requestId, {
      name,
      contentType,
      size,
      source: { kind: 'cache', sha256 },
    });
    open.project = result.project;
    this.markDirty();
    this.emitChanged();
    if (result.createdAttachmentId === undefined) {
      throw new ProjectError('not-found', 'The attachment was not appended');
    }
    return result.createdAttachmentId;
  }

  /**
   * Turns the path an `add-attachment` names into the bytes' size and their {@link AttachmentSource}:
   * copied into `attachments/<sha256>` when the change asks for it (so the project stays
   * self-contained and survives the original being moved), or referenced where it lies.
   *
   * The path arrives over IPC, so it is checked by {@link allowsAttachmentPath} *before* any
   * `stat` or `readFile`: without that, a renderer could name `~/.ssh/id_rsa` and have main
   * read it into the project cache — or, with `copyToCache: false`, ship it to whatever
   * endpoint the next send goes to.
   */
  private async readAttachmentSource(
    projectDir: string,
    input: { path: string; copyToCache: boolean; contentType: string },
  ): Promise<{ size: number; source: AttachmentSource }> {
    // Relative against the project folder, matching `resolveAttachmentPath` and the inline-file
    // resolver, so all three agree on which file a given string means.
    const path = resolvePath(projectDir, input.path);
    if (!(await this.allowsAttachmentPath(projectDir, path))) {
      throw new ProjectError(
        'attachment-outside-project',
        `The file "${input.path}" is outside the project and was not picked through the Add dialog`,
        { details: { path: input.path } },
      );
    }
    if (!input.copyToCache) {
      const info = await stat(path);
      return { size: info.size, source: { kind: 'path', path } };
    }
    const bytes = await readFile(path);
    const { sha256, size } = await putAttachment(projectDir, new Uint8Array(bytes), {
      originalName: basename(path),
      contentType: input.contentType,
    });
    return { size, source: { kind: 'cache', sha256 } };
  }

  /**
   * Imports a WSDL into the open project: resolves it (refreshing the definition cache under
   * the new interface's folder), records its endpoints and operations, and generates one
   * `Request 1` per operation. Saves immediately, so an import is never lost to a crash.
   */
  async addInterface(input: {
    source: ImportSourceWire;
    /** `password` never appears here: the caller sends a `secretRef`, resolved just below. */
    auth?: { username: string; passwordRef: string };
    /** When true, the resolved auth (by ref, never plaintext) is saved onto the interface. */
    useForRequests?: boolean;
    token?: string;
  }): Promise<{ project: ProjectWire; interfaceId: string }> {
    const open = this.require();
    const interfaceId = generateId();
    const taken = new Set(open.project.interfaces.map((iface) => iface.slug));

    const resolvedAuth =
      input.auth !== undefined
        ? await resolveEndpointAuth(
            { type: 'basic', username: input.auth.username, passwordRef: input.auth.passwordRef },
            (ref) => this.getSecret(ref),
          )
        : undefined;

    // The interface's name (and therefore its slug) comes from the WSDL, which is only known
    // once the import has run — so the cache is written under a provisional folder that is
    // renamed into place afterwards.
    const provisionalSlug = uniqueSlug(`importing-${interfaceId}`, taken);
    const summary = await this.engine.importForProject(
      {
        interfaceId,
        source: input.source,
        cache: { dir: definitionCacheDir(open.dir, provisionalSlug), mode: 'refresh' },
        ...(resolvedAuth?.username !== undefined && resolvedAuth.password !== undefined
          ? { auth: { username: resolvedAuth.username, password: resolvedAuth.password } }
          : {}),
        ...(input.token !== undefined ? { token: input.token } : {}),
      },
      { onProgress: (event) => this.hooks.onProgress?.(event) },
    );

    const slug = uniqueSlug(summary.name, taken);
    if (slug !== provisionalSlug) {
      await renameWithRetry(interfaceDir(open.dir, provisionalSlug), interfaceDir(open.dir, slug));
    }

    const endpoints = endpointsFrom(summary);
    const savedAuth: EndpointAuth | undefined =
      input.useForRequests === true && input.auth !== undefined
        ? { type: 'basic', username: input.auth.username, passwordRef: input.auth.passwordRef, preemptive: true }
        : undefined;
    const iface: Interface = {
      ...createInterface(summary.name, {
        id: interfaceId,
        slug,
        definitionUrl: summary.definitionUrl,
        targetNamespace: summary.targetNamespace,
        order: open.project.interfaces.length,
        // The WSDL preference is the default for a newly imported interface; the Details
        // panel's "Cache definition" toggle is what changes it afterwards, per interface.
        cacheDefinition: this.prefs()?.wsdl.cacheDefinitions ?? true,
        endpoints,
        operations: operationsFrom(summary),
      }),
      ...(savedAuth !== undefined ? { auth: savedAuth } : {}),
      // A WSDL that declares WS-Addressing turns it on for the interface straight away: the
      // alternative is the user discovering the requirement from a runtime fault.
      wsa: {
        ...DEFAULT_WSA_CONFIG,
        enabled: summary.wsa?.enabled ?? false,
        version: summary.wsa?.version ?? '2005/08',
      },
    };

    open.project = { ...open.project, interfaces: [...open.project.interfaces, iface] };
    open.runtime.set(interfaceId, { hydration: 'ready', summary });

    const generateOptions = generateOptionsFrom(this.prefs());
    for (const operation of summary.operations) {
      const generated = this.engine.generate({
        interfaceId,
        bindingName: operation.binding,
        operationName: operation.name,
        ...(generateOptions !== undefined ? { options: generateOptions } : {}),
      });
      open.project = addRequest(open.project, {
        interfaceId,
        bindingName: operation.binding,
        operationName: operation.name,
        name: 'Request 1',
        generated: {
          envelopeXml: generated.envelopeXml,
          soapVersion: generated.soapVersion,
          ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
        },
      }).project;
    }

    open.dirty = true;
    await this.save({ reason: 'import' });
    return { project: this.snapshot() as ProjectWire, interfaceId };
  }

  /**
   * Imports a legacy single-XML SOAP project into the open project: resolves each interface from
   * the definition the file carried (writing it to the interface's definition cache, so the
   * project reopens offline), adds interfaces with their saved requests, environments and new
   * properties, writes the file's scripts under `imported-scripts/`, and saves once.
   *
   * A document the file holds no copy of is fetched over `http(s)` only, never from a `file:`
   * location, because the path would come from the imported file rather than from the user. An
   * interface that cannot be resolved is left out and reported, and the rest still import.
   */
  async importLegacyProject(input: {
    project: LegacyProject;
    token?: string;
  }): Promise<{ project: ProjectWire; report: LegacyImportReport; environmentNames: string[] }> {
    const open = this.require();
    const taken = new Set(open.project.interfaces.map((iface) => iface.slug));
    const network = createDefaultFetchDocument();
    const summaries = new Map<string, InterfaceSummary>();

    const resolved: ResolvedLegacyInterface[] = [];
    for (const legacy of input.project.interfaces) {
      const id = generateId();
      const slug = uniqueSlug(legacy.name, taken);
      taken.add(slug);
      const base = { legacy, id, slug };
      const root = definitionRootOf(legacy.cache, legacy.definitionUrl);
      if (root === undefined) {
        resolved.push({ ...base, resolved: false, problem: 'the project file names no definition for it.' });
        continue;
      }
      const fetchedFromNetwork: string[] = [];
      let refusedLocal: string | undefined;
      const fetchDocument = fetchDocumentFromCache(legacy.cache, {
        fallback: (location, signal) => {
          if (!/^https?:/i.test(location)) {
            refusedLocal = location;
            throw new ProjectError('legacy-local-definition', `${location} is not in the project file`, {
              details: { location },
            });
          }
          return network(location, signal);
        },
        onFallback: (location) => fetchedFromNetwork.push(location),
      });
      try {
        const summary = await this.engine.importForProject(
          {
            interfaceId: id,
            source: { kind: 'url', url: root },
            cache: { dir: definitionCacheDir(open.dir, slug), mode: 'refresh' },
            fetchDocument,
            ...(input.token !== undefined ? { token: input.token } : {}),
          },
          { onProgress: (event) => this.hooks.onProgress?.(event) },
        );
        summaries.set(id, summary);
        resolved.push({
          ...base,
          resolved: true,
          definitionUrl: summary.definitionUrl,
          targetNamespace: summary.targetNamespace,
          operations: summary.operations.map((operation) => ({
            bindingName: operation.binding,
            name: operation.name,
            soapVersion: operation.soapVersion,
            ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
          })),
          fetchedFromNetwork,
        });
      } catch (error) {
        const problem =
          refusedLocal !== undefined
            ? `the project file holds no copy of ${refusedLocal}, and a local path it names is never read. Import that WSDL on its own.`
            : error instanceof Error
              ? error.message
              : String(error);
        resolved.push({ ...base, resolved: false, problem });
      }
    }

    const mapped = mapLegacyProject(input.project, resolved, {
      environmentNames: new Set(open.project.environments.map((environment) => environment.name)),
      environmentSlugs: new Set(open.project.environments.map((environment) => environment.slug)),
      propertyNames: new Set(Object.keys(open.project.properties)),
      firstInterfaceOrder: open.project.interfaces.length + open.project.apis.length + open.project.grpcApis.length,
      firstEnvironmentOrder: open.project.environments.length,
    });

    const cacheDefinition = this.prefs()?.wsdl.cacheDefinitions ?? true;
    const interfaces = mapped.interfaces.map((iface): Interface => {
      const summary = summaries.get(iface.id);
      if (summary !== undefined) {
        open.runtime.set(iface.id, { hydration: 'ready', summary });
      }
      return {
        ...iface,
        cacheDefinition,
        // As for a WSDL import: a definition that declares WS-Addressing turns it on for the interface.
        wsa: {
          ...DEFAULT_WSA_CONFIG,
          enabled: summary?.wsa?.enabled ?? false,
          version: summary?.wsa?.version ?? '2005/08',
        },
      };
    });

    const scriptsRoot = resolvePath(open.dir, IMPORTED_SCRIPTS_DIR);
    for (const script of mapped.scripts) {
      const target = resolvePath(open.dir, ...script.path.split('/'));
      // `mapLegacyProject` slugifies every segment; this guards that promise against a symlink too.
      if (!(await isInsideAny([scriptsRoot], target))) {
        continue;
      }
      await mkdir(resolvePath(target, '..'), { recursive: true });
      await writeFileAtomic(nodeFs, target, Buffer.from(script.source, 'utf8'));
    }

    open.project = {
      ...open.project,
      ...(open.project.description === undefined && input.project.description !== undefined
        ? { description: input.project.description }
        : {}),
      properties: { ...open.project.properties, ...mapped.properties },
      interfaces: [...open.project.interfaces, ...interfaces],
      environments: [...open.project.environments, ...mapped.environments],
    };
    open.dirty = true;
    await this.save({ reason: 'import' });
    return {
      project: this.snapshot() as ProjectWire,
      report: mapped.report,
      environmentNames: mapped.environments.map((environment) => environment.name),
    };
  }

  /** The open project's interface with `interfaceId`, or a `not-found` error. */
  private requireInterface(interfaceId: string): Interface {
    const open = this.require();
    const iface = open.project.interfaces.find((candidate) => candidate.id === interfaceId);
    if (iface === undefined) {
      throw new ProjectError('not-found', `No interface with id "${interfaceId}"`, {
        details: { id: interfaceId },
      });
    }
    return iface;
  }

  /**
   * Turns the renderer's Update Definition source into an engine source.
   *
   * A `url` is taken as written (the engine fetches it); a `path` is only accepted when it is
   * inside the project folder or the user picked it through an Open dialog this session — the
   * same rule every other main-side file read follows, so a renderer can never name an
   * arbitrary file to read.
   */
  private async updateSource(source: DefinitionUpdateSource): Promise<ImportSourceWire> {
    if (source.kind === 'url') {
      return { kind: 'url', url: source.url };
    }
    const open = this.require();
    const path = resolvePath(open.dir, source.path);
    if (!(await allowsReadPath([open.dir], this.picks, path))) {
      throw new ProjectError('path-not-allowed', `"${source.path}" is outside the project and was not picked`, {
        details: { path: source.path },
      });
    }
    return { kind: 'file', path };
  }

  /** The Basic credentials an interface's own auth resolves to, for re-fetching its WSDL. */
  private async importAuthFor(iface: Interface): Promise<{ username: string; password: string } | undefined> {
    // WSDL import/re-fetch keeps Basic (the import dialog offers nothing else); an interface
    // whose own auth is a token scheme resolves to no re-fetch credentials.
    const basicAuth = iface.auth !== undefined && isEndpointAuth(iface.auth) ? iface.auth : undefined;
    const resolved =
      basicAuth !== undefined ? await resolveEndpointAuth(basicAuth, (ref) => this.getSecret(ref)) : undefined;
    return resolved?.username !== undefined && resolved.password !== undefined
      ? { username: resolved.username, password: resolved.password }
      : undefined;
  }

  /**
   * Previews an Update Definition: fetches `source` and diffs it against the definition the
   * interface is currently using. Nothing is stored, cached or changed — this is what the
   * dialog shows before the user commits.
   */
  async planDefinitionUpdate(interfaceId: string, source: DefinitionUpdateSource): Promise<UpdatePlanWire> {
    const iface = this.requireInterface(interfaceId);
    const current = this.engine.resultFor(interfaceId);
    const auth = await this.importAuthFor(iface);
    const next = await this.engine.importPreview(await this.updateSource(source), auth);
    return toUpdatePlanWire(planUpdate(current, next));
  }

  /**
   * Applies an Update Definition: re-imports `source` (refreshing the interface's definition
   * cache, so a reopen sees the new WSDL offline), reconciles the project against it per
   * `options`, and saves — writing `<request>.xml.bak` backups first when asked.
   */
  async applyDefinitionUpdate(
    interfaceId: string,
    source: DefinitionUpdateSource,
    options: DefinitionUpdateOptions,
  ): Promise<Omit<ApplyUpdateWire, 'project'>> {
    const open = this.require();
    const iface = this.requireInterface(interfaceId);
    const previous = this.engine.resultFor(interfaceId);
    const auth = await this.importAuthFor(iface);
    // Fetched into a scratch result only: nothing about the live `ImportResult` or the
    // definition cache changes here. If the save below fails, the interface must look exactly
    // as it did before this call — see the fix1 finding on this method.
    const next = await this.engine.importPreview(await this.updateSource(source), auth);
    const plan = planUpdate(previous, next);
    const applied = applyUpdate(open.project, interfaceId, plan, next, options);

    const priorProject = open.project;
    const priorDirty = open.dirty;
    open.project = applied.project;
    open.dirty = true;
    let saveResult: ProjectSaveResult;
    try {
      // The backups must be copied from the bytes currently on disk, so they are handed to the
      // very save that overwrites them rather than written out of band afterwards.
      saveResult = await this.save({ reason: 'update-definition', backups: applied.backups });
    } catch (error) {
      // Roll the in-memory model back: the live `ImportResult`/definition cache were never
      // touched, so undoing `open.project`/`open.dirty` is enough to leave everything as it
      // was before this call.
      open.project = priorProject;
      open.dirty = priorDirty;
      throw error;
    }

    // Only a successful save may make the new definition live.
    await writeDefinitionCache(next.bundle, definitionCacheDir(open.dir, iface.slug));
    const summary = this.engine.commitResult(interfaceId, next, next.bundle.root.location);
    open.runtime.set(interfaceId, { hydration: 'ready', summary });

    return {
      plan: toUpdatePlanWire(plan),
      requestsCreated: [...applied.requestsCreated],
      requestsRecreated: [...applied.requestsRecreated],
      requestsOrphaned: [...applied.requestsOrphaned],
      // The actual timestamped `.xml.bak` paths the save wrote, not the pre-timestamp names
      // `applyUpdate` requested — see `save.ts`'s timestamped-backup policy.
      backups: [...(saveResult.backups ?? [])],
    };
  }

  /**
   * Places an imported API in the project, caching the documents it was made of.
   *
   * The API arrives fully mapped (`importOpenApi` in the engine) and is placed here, because only
   * the project knows which slugs are taken and where the cache goes. The cache is written under
   * the API's own folder *after* the slug is settled, so unlike a WSDL import there is no
   * provisional folder to rename — and a cancelled import has therefore written nothing at all.
   *
   * Saves immediately, as a WSDL import does: an import is never lost to a crash.
   */
  async addApi(input: {
    readonly api: RestApi;
    readonly documents: readonly ResolvedDocument[];
    /** Where the user pointed at, recorded on the API as its definition's source. */
    readonly source: string;
    /** The `openapi` string the document declared. */
    readonly declaredVersion: string;
    /** Write the definition cache. Defaults to the WSDL caching preference, as an import does. */
    readonly cache?: boolean;
  }): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.require();
    const taken = new Set([
      ...open.project.apis.map((api) => api.slug),
      ...open.project.interfaces.map((iface) => iface.slug),
    ]);
    const slug = uniqueSlug(input.api.name, taken);
    const cache = input.cache ?? this.prefs()?.wsdl.cacheDefinitions ?? true;

    if (cache) {
      await writeApiDefinitionCache(input.documents, apiDefinitionDir(open.dir, slug), {
        declaredVersion: input.declaredVersion,
      });
    }

    const api: RestApi = {
      ...input.api,
      slug,
      order: open.project.interfaces.length + open.project.apis.length,
      definition: { source: input.source, cache, version: input.declaredVersion },
    };
    open.project = { ...open.project, apis: [...open.project.apis, api] };
    open.dirty = true;
    this.openApiDocuments.delete(api.id);
    await this.save({ reason: 'import' });
    return { project: this.snapshot() as ProjectWire, apiId: api.id };
  }

  /**
   * Places a WebSocket API imported from an AsyncAPI document, caching the documents it was made
   * of under `apis/<slug>/definition/` with the root as `asyncapi.yaml` — the same cache layout an
   * OpenAPI import writes, so Update Definition can read the old document back.
   *
   * The API arrives fully mapped (`importAsyncApi` in the engine); only the slug, the order and the
   * definition record are settled here. Credentials the document describes arrive empty and stay
   * so: the import never has a secret to write. Saves immediately, as every import does.
   */
  async importAsyncApi(input: {
    readonly api: WsApi;
    readonly documents: readonly ResolvedDocument[];
    /** Where the user pointed at, recorded on the API as its definition's source. */
    readonly source: string;
    /** The `asyncapi` string the document declared. */
    readonly declaredVersion: string;
    /** The server key the API was mapped against, kept so an update maps against the same one. */
    readonly server?: string;
    /** Write the definition cache. Defaults to the definition-caching preference. */
    readonly cache?: boolean;
  }): Promise<{ project: ProjectWire; apiId: string }> {
    const open = this.require();
    const slug = uniqueSlug(input.api.name, takenApiSlugs(open.project));
    // One definition-caching preference covers every import kind; it lives under `wsdl` for history.
    const cache = input.cache ?? this.prefs()?.wsdl.cacheDefinitions ?? true;

    if (cache) {
      await writeApiDefinitionCache(input.documents, apiDefinitionDir(open.dir, slug), {
        declaredVersion: input.declaredVersion,
        rootFile: 'asyncapi.yaml',
      });
    }

    const project = open.project;
    const api: WsApi = {
      ...input.api,
      slug,
      order: project.interfaces.length + project.apis.length + project.grpcApis.length + project.wsApis.length,
      definition: {
        kind: 'asyncapi',
        source: input.source,
        cache,
        ...(input.server !== undefined ? { server: input.server } : {}),
      },
    };
    open.project = { ...project, wsApis: [...project.wsApis, api] };
    open.dirty = true;
    await this.save({ reason: 'import' });
    // Read the cache just written, so the Definition card has the version and servers at once.
    // The memo is dropped again: a live session reads the contract when it first needs it.
    await this.asyncApiContractFor(api.id).catch(() => undefined);
    this.asyncApiContracts.delete(api.id);
    return { project: this.snapshot() as ProjectWire, apiId: api.id };
  }

  /** The open project's AsyncAPI-imported WebSocket API with `apiId`, or a `not-found` error. */
  private requireAsyncApi(apiId: string): WsApi & { readonly definition: NonNullable<WsApi['definition']> } {
    const api = this.require().project.wsApis.find((candidate) => candidate.id === apiId);
    if (api?.definition?.kind !== 'asyncapi') {
      throw new ProjectError('not-found', `No AsyncAPI-imported API with id "${apiId}"`, { details: { id: apiId } });
    }
    return api as WsApi & { readonly definition: NonNullable<WsApi['definition']> };
  }

  /**
   * The contract an AsyncAPI-imported API was made from, parsed from its definition cache — never
   * the network — and kept for the session; `undefined` for an API with no cached definition. A
   * failed read is not remembered, so a fixed cache is read again on the next ask. An update drops it.
   */
  asyncApiContractFor(apiId: string): Promise<AsyncApiDocument | undefined> {
    const known = this.asyncApiContracts.get(apiId);
    if (known !== undefined) {
      return known;
    }
    const api = this.require().project.wsApis.find((candidate) => candidate.id === apiId);
    if (api?.definition?.kind !== 'asyncapi' || !api.definition.cache) {
      return Promise.resolve(undefined);
    }
    const dir = apiDefinitionDir(this.require().dir, api.slug);
    const loading = readApiDefinitionCache(dir).then(async (cached) => {
      const offline = createCachedApiFetch(cached.manifest, dir, (location) =>
        Promise.reject(
          new ProjectError('definition-cache-missing', `"${location}" is not in this API's definition cache`, {
            details: { location },
          }),
        ),
      );
      const parsed = await parseAsyncApi(
        { kind: 'url', url: cached.manifest.rootLocation },
        { fetchDocument: offline },
      );
      this.rememberAsyncApiInfo(apiId, parsed.document);
      return parsed.document;
    });
    loading.catch(() => {
      if (this.asyncApiContracts.get(apiId) === loading) {
        this.asyncApiContracts.delete(apiId);
      }
    });
    this.asyncApiContracts.set(apiId, loading);
    return loading;
  }

  /**
   * The messages of the channel a WebSocket request was imported from, for checking its live frames;
   * `undefined` (not a promise) when the request has no contract link, so a session without one
   * never starts a checker. The promise rejects when the cache cannot be read.
   */
  wsContractFor(requestId: string): Promise<ChannelMessages | undefined> | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const request = findWsRequest(this.open.project, requestId);
    const api = wsApiOwning(this.open.project, requestId);
    if (request?.contract === undefined || api?.definition?.kind !== 'asyncapi') {
      return undefined;
    }
    const channel = request.contract.channel;
    return this.asyncApiContractFor(api.id).then((document) =>
      document === undefined ? undefined : asyncApiChannelMessages(document, channel),
    );
  }

  /**
   * The OpenAPI document a REST API was imported from, parsed from its definition cache — never the
   * network — and kept for the session. A failed read is not remembered, so a fixed cache is read
   * again on the next ask.
   *
   * @throws ProjectError `not-found` when `apiId` is not a REST API of this project.
   */
  openApiDocumentFor(apiId: string): Promise<OpenApiDocument> {
    const known = this.openApiDocuments.get(apiId);
    if (known !== undefined) {
      return known;
    }
    const api = this.requireApi(apiId);
    const dir = apiDefinitionDir(this.require().dir, api.slug);
    const loading = readApiDefinitionCache(dir).then(async (cached) => {
      const offline = createCachedApiFetch(cached.manifest, dir, (location) =>
        Promise.reject(
          new ProjectError('definition-cache-missing', `"${location}" is not in this API's definition cache`, {
            details: { location },
          }),
        ),
      );
      const parsed = await parseOpenApi({ kind: 'url', url: cached.manifest.rootLocation }, { fetchDocument: offline });
      return parsed.document;
    });
    loading.catch(() => {
      if (this.openApiDocuments.get(apiId) === loading) {
        this.openApiDocuments.delete(apiId);
      }
    });
    this.openApiDocuments.set(apiId, loading);
    return loading;
  }

  /**
   * What a REST request's response is checked against: the operation it calls — its import link when
   * `sent`'s method is the link's and its URL fits the link's path, or else the one operation `sent`'s
   * method and URL match — and that operation's declared
   * responses. `undefined` (not a promise) when the request's API has no cached definition, so such
   * a send never touches the checker; the promise rejects when the cache cannot be read.
   */
  restContractFor(
    requestId: string,
    sent: { readonly method: string; readonly url: string },
  ): Promise<RestContractTarget> | undefined {
    if (this.open === undefined) {
      return undefined;
    }
    const request = findRestRequest(this.open.project, requestId);
    const api = restApiOwning(this.open.project, requestId);
    if (request === undefined || api?.definition?.cache !== true) {
      return undefined;
    }
    // `sent.url` is the expanded URL and may carry a secret: it stays in memory for the match and is
    // never logged or stored.
    const link = request.contract;
    const baseUrls = [api.baseUrl, ...api.servers.map((server) => server.url)];
    return this.openApiDocumentFor(api.id).then((document) => {
      // The import link names the operation only while the request still calls it: a request whose
      // method or URL was edited since (or a clone pointed elsewhere) is matched afresh.
      const linked =
        link !== undefined &&
        link.method.toLowerCase() === sent.method.toLowerCase() &&
        matchOperation([link], sent.method, sent.url, baseUrls) !== undefined;
      const operation = linked
        ? { method: link.method, path: link.path }
        : matchOperation(document.operations, sent.method, sent.url, baseUrls);
      if (operation === undefined) {
        return {};
      }
      const declared = document.operations.find(
        (candidate) =>
          candidate.method.toLowerCase() === operation.method.toLowerCase() && candidate.path === operation.path,
      );
      return declared?.responses === undefined ? { operation } : { operation, responses: declared.responses };
    });
  }

  /**
   * The schema of the JSON body a REST request's operation declares, for the body editor's form: the
   * operation found as `restContractFor` finds it (the import link while the request still calls it,
   * else a match on the saved method and URL), and its first JSON media type (`application/json` or
   * `*+json`). The schema is an acyclic copy (`toWireSchema`), because a cyclic graph cannot cross
   * IPC. `undefined` when there is no cached definition, no matching operation, or no JSON body.
   */
  async restBodySchema(requestId: string): Promise<{ mediaType: string; schema: JsonSchema } | undefined> {
    if (this.open === undefined) {
      return undefined;
    }
    const request = findRestRequest(this.open.project, requestId);
    const api = restApiOwning(this.open.project, requestId);
    if (request === undefined || api?.definition?.cache !== true) {
      return undefined;
    }
    const link = request.contract;
    const baseUrls = [api.baseUrl, ...api.servers.map((server) => server.url)];
    const document = await this.openApiDocumentFor(api.id);
    const linked =
      link !== undefined &&
      link.method.toLowerCase() === request.method.toLowerCase() &&
      matchOperation([link], request.method, request.url, baseUrls) !== undefined;
    const operation = linked
      ? { method: link.method, path: link.path }
      : matchOperation(document.operations, request.method, request.url, baseUrls);
    if (operation === undefined) {
      return undefined;
    }
    const declared = document.operations.find(
      (candidate) =>
        candidate.method.toLowerCase() === operation.method.toLowerCase() && candidate.path === operation.path,
    );
    const content = declared?.requestBody?.content ?? {};
    for (const [mediaType, media] of Object.entries(content)) {
      const bare = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
      if ((bare === 'application/json' || bare.endsWith('+json')) && media.schema !== undefined) {
        return { mediaType, schema: toWireSchema(media.schema) };
      }
    }
    return undefined;
  }

  /** Where an AsyncAPI-imported API's definition came from, as the user gave it, for an update to re-read. */
  asyncApiSource(apiId: string): string {
    return this.requireAsyncApi(apiId).definition.source;
  }

  /** What updating `apiId` to `next` would change, compared with the cached document. Changes nothing. */
  async planAsyncApiUpdate(apiId: string, next: AsyncApiDocument): Promise<AsyncApiUpdatePlan> {
    return planAsyncApiUpdate(await this.cachedAsyncApi(apiId), next);
  }

  /**
   * Applies `next` to `apiId`: nothing is deleted (a channel that went away orphans its request),
   * the definition cache is rewritten with the new documents, the memoised contract is dropped so
   * the next session is checked against the new one, and the project is saved.
   */
  async applyAsyncApiUpdate(
    apiId: string,
    next: ParsedAsyncApi,
  ): Promise<{
    readonly project: ProjectWire;
    readonly plan: AsyncApiUpdatePlan;
    readonly applied: Omit<AsyncApiApplyResult, 'api'>;
  }> {
    const open = this.require();
    const api = this.requireAsyncApi(apiId);
    const old = await this.cachedAsyncApi(apiId);
    const plan = planAsyncApiUpdate(old, next.document);
    const { api: updated, ...applied } = applyAsyncApiUpdate(api, old, next.document, {
      ...(api.definition.server !== undefined ? { server: api.definition.server } : {}),
    });
    if (api.definition.cache) {
      await writeApiDefinitionCache(next.documents, apiDefinitionDir(open.dir, api.slug), {
        declaredVersion: next.document.declaredVersion,
        rootFile: 'asyncapi.yaml',
      });
    }
    this.asyncApiContracts.delete(apiId);
    this.rememberAsyncApiInfo(apiId, next.document);
    open.project = {
      ...open.project,
      wsApis: open.project.wsApis.map((candidate) => (candidate.id === apiId ? updated : candidate)),
    };
    open.dirty = true;
    await this.save({ reason: 'update-definition' });
    return { project: this.snapshot() as ProjectWire, plan, applied };
  }

  /** Keeps what the Definition card shows of a cached document: its version and WebSocket servers. */
  private rememberAsyncApiInfo(apiId: string, document: AsyncApiDocument): void {
    this.asyncApiInfo.set(apiId, {
      version: document.declaredVersion,
      servers: document.servers
        .filter((server) => ['ws', 'wss'].includes(server.protocol.toLowerCase()))
        .map((server) => server.key),
    });
  }

  /** The cached document an update compares against; an API with no cache cannot be updated. */
  private async cachedAsyncApi(apiId: string): Promise<AsyncApiDocument> {
    this.requireAsyncApi(apiId);
    const old = await this.asyncApiContractFor(apiId);
    if (old === undefined) {
      throw new ProjectError(
        'definition-cache-missing',
        'This API did not cache its definition, so there is nothing to compare an update against',
        {
          details: { apiId },
        },
      );
    }
    return old;
  }

  /** The open project's API with `apiId`, or a `not-found` error. */
  private requireApi(apiId: string): RestApi {
    const api = this.require().project.apis.find((candidate) => candidate.id === apiId);
    if (api === undefined) {
      throw new ProjectError('not-found', `No API with id "${apiId}"`, { details: { id: apiId } });
    }
    return api;
  }

  /**
   * The documents cached for `apiId`, read from its own folder.
   *
   * Nothing is re-fetched to answer this: an API whose definition was not cached has no documents
   * to show, and says so with `definition-cache-missing` rather than reaching the network behind
   * the user's back.
   */
  async apiDefinitionDocuments(apiId: string): Promise<{
    readonly documents: readonly { location: string; size: number }[];
    readonly rootLocation: string;
    readonly fetchedAt: string;
    readonly declaredVersion?: string;
  }> {
    // A gRPC API's cache holds `.proto` files rather than documents; the same card lists them by
    // import path, and says `proto` where an OpenAPI card says the document's version.
    const grpc = this.require().project.grpcApis.find((candidate) => candidate.id === apiId);
    if (grpc !== undefined) {
      const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.require().dir, grpc.slug));
      return {
        documents:
          cache.kind === 'proto'
            ? cache.manifest.files.map((file) => ({ location: file.path, size: file.bytes }))
            : [{ location: cache.manifest.file.path, size: cache.manifest.file.bytes }],
        rootLocation: cache.manifest.source,
        fetchedAt: cache.manifest.fetchedAt,
        declaredVersion: cache.kind === 'proto' ? 'proto' : 'descriptors',
      };
    }
    const api = this.requireApi(apiId);
    const cached = await readApiDefinitionCache(apiDefinitionDir(this.require().dir, api.slug));
    return {
      documents: cached.manifest.documents.map((document) => ({ location: document.location, size: document.bytes })),
      rootLocation: cached.manifest.rootLocation,
      fetchedAt: cached.manifest.fetchedAt,
      ...(cached.manifest.declaredVersion !== undefined ? { declaredVersion: cached.manifest.declaredVersion } : {}),
    };
  }

  /**
   * One cached document's text, matched by the location the manifest records.
   *
   * The renderer names a location, never a path: a document the manifest does not list is an
   * `unknown-document` error, so this can never be turned into a read of an arbitrary file.
   */
  async apiDefinitionText(apiId: string, location: string): Promise<string> {
    const grpc = this.require().project.grpcApis.find((candidate) => candidate.id === apiId);
    if (grpc !== undefined) {
      const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.require().dir, grpc.slug));
      if (cache.kind === 'descriptors') {
        // A discovered definition is a binary descriptor set, not text; there is nothing to show.
        throw new ProjectError(
          'definition-not-text',
          'This API was discovered from a running server, so its definition is a binary descriptor set rather than .proto text',
          { details: { apiId, location } },
        );
      }
      const text = cache.sources.get(location);
      if (text === undefined) {
        throw new ProjectError('not-found', `No file "${location}" in this API's definition`, {
          details: { apiId, location },
        });
      }
      return text;
    }
    const api = this.requireApi(apiId);
    const cached = await readApiDefinitionCache(apiDefinitionDir(this.require().dir, api.slug));
    const document = cached.documents.find((candidate) => candidate.location === location);
    if (document === undefined) {
      throw new ProjectError('not-found', `No document "${location}" in this API's definition`, {
        details: { apiId, location },
      });
    }
    return document.text;
  }

  /** Writes every cached document of `apiId` into `dir`, byte for byte, returning the file names. */
  async exportApiDefinitionTo(apiId: string, dir: string): Promise<string[]> {
    const grpc = this.require().project.grpcApis.find((candidate) => candidate.id === apiId);
    if (grpc !== undefined) {
      const cache = await readGrpcDefinitionCache(apiDefinitionDir(this.require().dir, grpc.slug));
      if (cache.kind === 'descriptors') {
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(nodeFs, join(dir, cache.manifest.file.path), Buffer.from(cache.descriptors));
        return [cache.manifest.file.path];
      }
      const written: string[] = [];
      for (const [path, text] of cache.sources) {
        // The import paths were validated as safe segments when the cache was written, so joining
        // them under `dir` cannot leave it.
        await mkdir(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
        await writeFileAtomic(nodeFs, join(dir, ...path.split('/')), Buffer.from(text, 'utf8'));
        written.push(path);
      }
      return written;
    }
    const api = this.requireApi(apiId);
    const cacheDir = apiDefinitionDir(this.require().dir, api.slug);
    const cached = await readApiDefinitionCache(cacheDir);
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const entry of cached.manifest.documents) {
      const document = cached.documents.find((candidate) => candidate.location === entry.location);
      if (document === undefined) {
        continue;
      }
      // Atomic: a name appearing in the directory must mean the bytes are all there. Exporting
      // non-atomically let a reader that waited for the *listing* — as `openapi-import.spec.ts`
      // does — open a file that existed but was still empty.
      await writeFileAtomic(nodeFs, join(dir, entry.file), Buffer.from(document.bytes));
      written.push(entry.file);
    }
    return written;
  }

  /** Writes the definition bundle of `interfaceId` into `dir`, returning the file names written. */
  async exportDefinitionTo(interfaceId: string, dir: string): Promise<string[]> {
    this.requireInterface(interfaceId);
    const result = await exportDefinition(this.engine.resultFor(interfaceId).bundle, dir);
    return result.files.map((file) => file.file);
  }

  /** Renders the documentation for `interfaceId`, titled with the interface's own name. */
  definitionDocs(interfaceId: string, format: 'html' | 'markdown'): string {
    const iface = this.requireInterface(interfaceId);
    return generateDocs(this.engine.resultFor(interfaceId), { format, title: iface.name });
  }

  /**
   * Re-imports every interface from its definition cache, one at a time so a project with
   * many interfaces does not open dozens of parallel resolves. A failure marks that interface
   * `failed` and adds a problem — it never fails the open.
   */
  private async hydrateAll(): Promise<void> {
    const open = this.open;
    if (open === undefined) {
      return;
    }
    for (const iface of open.project.interfaces) {
      if (this.open !== open) {
        return; // The project was closed or replaced while hydrating.
      }
      try {
        // The interface's own auth must be resolved for hydration exactly as it is for the
        // first import: a WSDL behind Basic auth is otherwise re-fetched anonymously and the
        // whole interface fails to hydrate on reopen. WSDL import/re-fetch keeps Basic, so a
        // token-scheme owner resolves to no re-fetch credentials, same as `importAuthFor`.
        const basicAuth = iface.auth !== undefined && isEndpointAuth(iface.auth) ? iface.auth : undefined;
        const resolvedAuth =
          basicAuth !== undefined ? await resolveEndpointAuth(basicAuth, (ref) => this.getSecret(ref)) : undefined;
        const summary = await this.engine.importForProject({
          interfaceId: iface.id,
          source: { kind: 'url', url: iface.definitionUrl },
          cache: { dir: definitionCacheDir(open.dir, iface.slug), mode: 'prefer-cache' },
          ...(resolvedAuth?.username !== undefined && resolvedAuth.password !== undefined
            ? { auth: { username: resolvedAuth.username, password: resolvedAuth.password } }
            : {}),
        });
        open.runtime.set(iface.id, { hydration: 'ready', summary });
        this.hooks.onHydration?.({ interfaceId: iface.id, status: 'ready' });
      } catch (error) {
        const message = errorMessage(error);
        open.runtime.set(iface.id, { hydration: 'failed' });
        open.problems = [...open.problems, { code: 'hydration-failed', message, file: iface.slug }];
        this.hooks.onHydration?.({ interfaceId: iface.id, status: 'failed', message });
      }
      this.emitChanged();
    }
    // The Definition card's version and servers come from each AsyncAPI API's cached document.
    for (const api of open.project.wsApis) {
      if (this.open !== open) {
        return;
      }
      if (api.definition?.kind === 'asyncapi' && api.definition.cache) {
        if ((await this.asyncApiContractFor(api.id).catch(() => undefined)) !== undefined) {
          this.emitChanged();
        }
      }
    }
  }
}

/** The request with this id inside `container`, and the names of the folders enclosing it. */
function restPathWithin(
  container: { readonly folders: readonly RestFolder[]; readonly requests: readonly RestRequestDef[] },
  requestId: string,
  enclosing: readonly string[],
): { readonly request: RestRequestDef; readonly folders: readonly string[] } | undefined {
  const own = container.requests.find((request) => request.id === requestId);
  if (own !== undefined) {
    return { request: own, folders: enclosing };
  }
  for (const folder of container.folders) {
    const deeper = restPathWithin(folder, requestId, [...enclosing, folder.name]);
    if (deeper !== undefined) {
      return deeper;
    }
  }
  return undefined;
}

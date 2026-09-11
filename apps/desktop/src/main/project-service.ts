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
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { isInsideAny } from './path-containment.js';
import type { ReadPicks } from './dialog-picks.js';
import {
  createInterface,
  applyUpdate,
  createProject,
  definitionCacheDir,
  exportDefinition,
  generateDocs,
  generateId,
  interfaceDir,
  attachmentFile,
  attachmentsDir,
  createFileAttachmentResolver,
  loadProject,
  ProjectError,
  planUpdate,
  putAttachment,
  resolveAuthEndpoint,
  resolveEndpoint,
  resolveScopes,
  projectFiles,
  saveProject,
  toSendInput,
  uniqueSlug,
  writeDefinitionCache,
} from '@wirebench/engine';
import type {
  Attachment,
  AttachmentResolvers,
  AttachmentSource,
  Endpoint,
  FsLike,
  Preferences,
  Interface,
  OperationDef,
  Project,
  ProjectFiles,
  ProxyConfig,
  PropertyScopes,
  SendAttachmentOptions,
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
  RecentProject,
  SoapSendInputWire,
  ProxyOptionsWire,
  TlsOptionsWire,
  UpdatePlanWire,
} from '../shared/wire-types.js';
import type { EndpointAuth } from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import { generateOptionsFrom } from './generate-options.js';
import type { GlobalProperties } from './global-properties.js';
import type { PreferencesService } from './preferences.js';
import type { PreflightResult } from './expansion-preflight.js';
import { preflightRequest } from './expansion-preflight.js';
import { resolveEndpointAuth } from './secret-resolver.js';
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
import type { InterfaceRuntime } from './project-wire.js';
import { findRequest, toProjectWire, toUpdatePlanWire } from './project-wire.js';
import { ProjectWatcher } from './project-watch.js';
import type { RecentProjects } from './recent-projects.js';

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

/** Events the service raises; the IPC layer forwards them to the renderer. */
export interface ProjectServiceHooks {
  /** After any mutation, save, open, close or reload. `null` means no project is open. */
  readonly onChanged?: (project: ProjectWire | null) => void;
  /** Files under the project folder changed outside the app. */
  readonly onChangedOnDisk?: (paths: readonly string[]) => void;
  /** One interface's definition finished (or failed) re-importing. */
  readonly onHydration?: (event: { interfaceId: string; status: HydrationStatus; message?: string }) => void;
  /** Import progress, forwarded from the engine. */
  readonly onProgress?: (event: EngineProgressEvent) => void;
}

/** The mutable state of one open project. */
interface OpenProject {
  project: Project;
  readonly dir: string;
  dirty: boolean;
  lastSavedAt: string | undefined;
  problems: ProjectProblemWire[];
  readonly runtime: Map<string, InterfaceRuntime>;
  lastWritten: ProjectFiles | undefined;
  readonly watcher: ProjectWatcher;
}

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
 * actually read — see {@link ProjectService.attachmentResolvers}'s `resolver`.
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

/** Owns the open project: its model, its folder, its autosave timer and its watcher. */
export class ProjectService {
  private open: OpenProject | undefined;
  /** Parsed keystores, keyed by entry id; see {@link loadKeystoreFor} for the invalidation key. */
  private readonly keystoreCache = new Map<string, { key: string; keystore: Keystore }>();
  private autosave: NodeJS.Timeout | undefined;
  private hydrating: Promise<void> | undefined;

  constructor(
    private readonly engine: EngineService,
    private readonly recent: RecentProjects,
    private readonly hooks: ProjectServiceHooks = {},
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
    const endpoint =
      overrides?.endpoint ??
      resolveEndpoint(this.open.project, this.open.project.activeEnvironmentId, iface, request).url;
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
    const globals = this.globals?.get() ?? {};
    if (this.open === undefined) {
      return { project: {}, global: globals, system: process.env };
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
    );
  }

  /** Resolves a `secretRef` to plaintext for the duration of one import/send call. */
  private async getSecret(ref: string): Promise<string | undefined> {
    return this.secrets?.get(ref);
  }

  /**
   * The auth that should apply when sending `requestId`: request auth overrides its endpoint's,
   * which overrides its interface's (see `effectiveAuth`). `undefined` when the request is
   * unknown or nothing configures auth at any level.
   */
  authFor(requestId: string): EndpointAuth | undefined {
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
    });
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
    await this.recent.remember(input.dir, this.require().project.name);
    this.emitChanged();
    return this.snapshot() as ProjectWire;
  }

  /** Opens an existing project folder, then hydrates its definitions in the background. */
  async openProject(dir: string): Promise<ProjectWire> {
    const { project, problems } = await loadProject(dir);
    await this.closeInternal();
    this.adopt(
      project,
      dir,
      problems.map((problem) => ({ code: problem.code, message: problem.message, file: problem.file })),
    );
    await this.recent.remember(dir, project.name);
    this.emitChanged();
    this.hydrating = this.hydrateAll();
    return this.snapshot() as ProjectWire;
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

  /** Saves (when dirty) and closes the open project. */
  async close(): Promise<null> {
    await this.closeInternal();
    this.emitChanged();
    return null;
  }

  /** Resolves once the background hydration started by {@link openProject} has finished. */
  async whenHydrated(): Promise<void> {
    await this.hydrating;
  }

  private adopt(project: Project, dir: string, problems: ProjectProblemWire[]): void {
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
      watcher,
    };
    watcher.start();
  }

  private async closeInternal(): Promise<void> {
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
      this.autosave = undefined;
    }
    if (this.open === undefined) {
      return;
    }
    if (this.open.dirty) {
      await this.save({ reason: 'close' });
    }
    this.open.watcher.stop();
    // Parsed keystores are decrypted key material: they must not outlive the project they
    // belong to, and a reopened project re-reads (and re-authorises) every file anyway.
    this.keystoreCache.clear();
    for (const iface of this.open.project.interfaces) {
      this.engine.close(iface.id);
    }
    this.open = undefined;
  }

  /** Writes the project to disk. Also invoked by the autosave timer and on `before-quit`. */
  async save(
    options: { reason: string; backups?: readonly string[] } = { reason: 'manual' },
  ): Promise<ProjectSaveResult> {
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
      this.autosave = undefined;
    }
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
      writer: `wirebench (${options.reason})`,
      ...(options.backups !== undefined ? { backups: options.backups } : {}),
      ...(this.fs !== undefined ? { fs: this.fs } : {}),
    });
    open.watcher.expect([...result.written, ...result.removed]);
    open.lastWritten = projectFiles(model, { writer: `wirebench (${options.reason})` });
    if (open.project === model) {
      open.dirty = false;
    } else {
      // A mutation landed mid-write: `lastWritten` now describes disk, but the newer edit
      // never made it out, so stay dirty and schedule another autosave to pick it up.
      this.markDirty();
    }
    open.lastSavedAt = new Date().toISOString();
    this.emitChanged();
    return {
      saved: true,
      savedAt: open.lastSavedAt,
      written: result.written.length,
      removed: result.removed.length,
      ...(options.backups !== undefined ? { backups: result.backups } : {}),
    };
  }

  private markDirty(): void {
    const open = this.require();
    open.dirty = true;
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
    }
    this.autosave = setTimeout(() => {
      this.autosave = undefined;
      void this.save({ reason: 'autosave' });
    }, AUTOSAVE_DEBOUNCE_MS);
    this.autosave.unref?.();
  }

  /** Applies one change to the model, marks the project dirty and schedules an autosave. */
  async mutate(change: ProjectChange): Promise<{
    project: ProjectWire;
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
  async tlsFor(requestId: string): Promise<TlsOptionsWire | undefined> {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    const identity = await this.clientIdentityFor(location?.request.properties.sslKeystoreRef);
    const ca = await this.trustAnchors();
    const trustInvalid =
      location !== undefined &&
      resolveEndpoint(this.open.project, this.open.project.activeEnvironmentId, location.iface, location.request)
        .endpoint?.trustInvalid === true;
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
        : (resolveEndpoint(this.open.project, this.open.project.activeEnvironmentId, location.iface, location.request)
            .url ?? '');
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

  /** The recent-projects list, most recent first. */
  recentProjects(): Promise<RecentProject[]> {
    return this.recent.list();
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
      await rename(interfaceDir(open.dir, provisionalSlug), interfaceDir(open.dir, slug));
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
    const resolved =
      iface.auth !== undefined ? await resolveEndpointAuth(iface.auth, (ref) => this.getSecret(ref)) : undefined;
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
        // whole interface fails to hydrate on reopen.
        const resolvedAuth =
          iface.auth !== undefined ? await resolveEndpointAuth(iface.auth, (ref) => this.getSecret(ref)) : undefined;
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
  }
}

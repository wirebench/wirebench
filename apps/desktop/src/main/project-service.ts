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

import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { isInsideAny } from './path-containment.js';
import {
  createInterface,
  createProject,
  definitionCacheDir,
  generateId,
  interfaceDir,
  attachmentsDir,
  createFileAttachmentResolver,
  loadProject,
  ProjectError,
  putAttachment,
  resolveEndpoint,
  resolveScopes,
  projectFiles,
  saveProject,
  toSendInput,
  uniqueSlug,
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
  PropertyScopes,
  SendAttachmentOptions,
} from '@wirebench/engine';
import type {
  EngineProgressEvent,
  HydrationStatus,
  ImportSourceWire,
  InterfaceSummary,
  ProjectChange,
  ProjectProblemWire,
  ProjectSaveResult,
  ProjectWire,
  RecentProject,
  SoapSendInputWire,
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
import { addRequest, applyChange, projectNameFromDir } from './project-mutations.js';
import type { InterfaceRuntime } from './project-wire.js';
import { findRequest, toProjectWire } from './project-wire.js';
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
  ) {}

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
      attachmentResolvers: this.attachmentResolvers(this.open, request.attachments),
    });
    if (input.attachmentOptions === undefined) {
      return undefined;
    }
    return { attachments: input.attachments ?? [], attachmentOptions: input.attachmentOptions };
  }

  /**
   * The resolvers a send reads attachment (and inline-file) bytes through.
   *
   * `resolver` is the engine's own project-folder resolver. `resolveFile` is the guarded one:
   * the renderer can put any `file:<path>` it likes into an envelope, so a read is allowed only
   * inside the project folder or its attachment cache, or at the exact absolute path one of
   * this request's own `path`-source attachments already names — a path the user picked
   * explicitly. Anything else is refused rather than silently read.
   */
  private attachmentResolvers(open: OpenProject, attachments: readonly Attachment[]): AttachmentResolvers {
    const projectDir = open.dir;
    const roots = [projectDir, attachmentsDir(projectDir)];
    const declared = new Set(
      attachments
        .filter((attachment) => attachment.source.kind === 'path')
        .map((attachment) => resolvePath(projectDir, (attachment.source as { path: string }).path)),
    );
    const resourceRoot = open.project.settings.resourceRoot;
    return {
      resolver: createFileAttachmentResolver(projectDir, resourceRoot),
      resolveFile: async (path: string): Promise<Uint8Array> => {
        const resolved = resolvePath(projectDir, path);
        if (!declared.has(resolved) && !(await isInsideAny(roots, resolved))) {
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
    return preflightRequest(open.project, requestId, this.scopesFor(activeId), activeId);
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
    const endpoint = location.request.endpointId
      ? location.iface.endpoints.find((candidate) => candidate.id === location.request.endpointId)
      : undefined;
    return effectiveAuth(location.request.auth, endpoint?.auth, location.iface.auth);
  }

  /** The open project's id, or `undefined` when no project is open. Used to key its history file. */
  projectId(): string | undefined {
    return this.open?.project.id;
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
    for (const iface of this.open.project.interfaces) {
      this.engine.close(iface.id);
    }
    this.open = undefined;
  }

  /** Writes the project to disk. Also invoked by the autosave timer and on `before-quit`. */
  async save(options: { reason: string } = { reason: 'manual' }): Promise<ProjectSaveResult> {
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
  }> {
    const open = this.require();
    const result = await applyChange(open.project, change, {
      addAttachmentFile: (input) => this.readAttachmentSource(open.dir, input),
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
    this.markDirty();
    this.emitChanged();
    return {
      project: this.snapshot() as ProjectWire,
      ...(result.createdRequestId !== undefined ? { createdRequestId: result.createdRequestId } : {}),
      ...(result.createdEnvironmentId !== undefined ? { createdEnvironmentId: result.createdEnvironmentId } : {}),
      ...(result.createdAttachmentId !== undefined ? { createdAttachmentId: result.createdAttachmentId } : {}),
    };
  }

  /**
   * Turns the path an `add-attachment` names into the bytes' size and their {@link AttachmentSource}:
   * copied into `attachments/<sha256>` when the change asks for it (so the project stays
   * self-contained and survives the original being moved), or referenced where it lies.
   */
  private async readAttachmentSource(
    projectDir: string,
    input: { path: string; copyToCache: boolean; contentType: string },
  ): Promise<{ size: number; source: AttachmentSource }> {
    const path = resolvePath(input.path);
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

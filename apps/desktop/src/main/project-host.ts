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

import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { existsSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { resolve as resolvePath } from 'node:path';
import { isInsideAny, isInsideReal, realpathOfPrefix } from './path-containment.js';
import type { ReadPicks } from './dialog-picks.js';
import { resolveProxy, resolveTrustAnchors } from './network-options.js';
import { endpointCandidates, resolveEndpointTargets } from './certificate-expiry.js';
import type { KeystoreCertificates, ProjectCertificateSources } from './certificate-expiry.js';
import {
  appliesToProject,
  assertEnvironmentInScope,
  createProject,
  DEFAULT_PREFERENCES,
  DynamicValues,
  enabledProperties,
  environmentsForProject,
  generateMock,
  IMPORTED_SCRIPTS_DIR,
  isProtectedEnvironment,
  loadKeystore,
  loadProject,
  overlayCurrent,
  pemCertificates,
  ProjectError,
  projectFiles,
  proposeConversions,
  resolveEndpoint,
  resolveScopes,
  resolveWorkspaceEndpoint,
  resolveWorkspaceScopes,
  saveProject,
  soapInterfacesOf,
  toKeystoreDef,
  toTlsClientIdentity,
  WirebenchError,
  withCurrentValues,
  withSystemValuesReported,
  workspaceForProject,
} from '@wirebench/engine';
import type { ProtocolRegistry } from '@wirebench/engine';
import type {
  CurrentValues,
  Endpoint,
  EndpointSource,
  FsLike,
  Interface,
  IssuedTokenSource,
  Keystore,
  KeystoreDef,
  LevelProposal,
  PemCertificateSummary,
  Preferences,
  Project,
  ProjectFiles,
  PropertyMap,
  PropertyScopes,
  RunWorkspace,
  SoapRequestDef,
  Workspace,
} from '@wirebench/engine';
import type { HistoryEntryWire, ProjectChange, ProjectWire } from '../shared/wire-types.js';
import type {
  EngineProgressEvent,
  HydrationStatus,
  ProjectProblemWire,
  ProjectSaveResult,
  KeystoresInspectResponse,
  ProxyOptionsWire,
  ScriptConversionsResultWire,
  TlsOptionsWire,
} from '../shared/wire-base.js';
import type { EngineService } from './engine-service.js';
import { generateOptionsFrom } from './generate-options.js';
import type { GlobalProperties } from './global-properties.js';
import type { PreferencesService } from './preferences.js';
import type { PreflightResult } from './expansion-preflight.js';
import { preflightRequest } from './expansion-preflight.js';
import { writeNewFile } from './write-new-file.js';
import type { SecretStore } from './secrets.js';
import { allowsReadPath } from './path-access.js';
import { applyChange, projectNameFromDir } from './project-mutations.js';
import { conversionsResultWire, levelPath, listImportedScripts } from './convert-scripts.js';
import type { ScriptConversions } from './project-script-mutations.js';
import type { ProjectWireContext } from './project-wire.js';
import { findRequest, toProjectWire } from './project-wire.js';
import { ProjectWatcher, SELF_WRITE_TTL_MS } from './project-watch.js';
import { recordSecretValue } from './redact.js';
import { mergeUnsaved, overlayFs } from './unsaved-store.js';
import type { UnsavedProjectFiles } from './unsaved-store.js';
import type { SecretSourcesSnapshot } from './secret-sources-service.js';
import { refusedMockSlugs } from './project-mock-mutations.js';
import { refusedSequenceSlugs } from './project-sequence-mutations.js';
import { errorMessage } from './project-host-core.js';
import type { OpenProject } from './project-host-core.js';
import type { KindApiDefinitions, KindHostHooks, KindHosts } from './kinds/kind-main.js';
import type { ApiDefinitionDocuments } from './kinds/kind-main.js';
import { MAIN_KINDS } from './kinds/kind-main.js';
import type { KindId } from '../shared/kinds/kind-module.js';
import { switchedOffProjectFiles } from './kinds/enabled-kinds.js';

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
  /**
   * A request's newest REST history entry in this project, which a webhook callback's URL is read
   * from. Omitted, a callback always falls back to its target.
   */
  readonly newestRest?: (projectId: string, requestId: string) => HistoryEntryWire | undefined;
  /** The kinds this run has on (`WIREBENCH_KINDS`); a change through one that is off is refused. Absent, all. */
  readonly enabledKinds?: readonly KindId[];
  /**
   * The engine registry for this run (`WIREBENCH_KINDS`), passed to every load, save and send: a kind
   * that is off loads as placeholders and its files are left alone. Absent, the built-in one, all on.
   */
  readonly registry?: ProtocolRegistry;
}

/** What {@link ProjectHost.openProject} did with an unsaved-changes record it was handed. */
export type UnsavedRestoreOutcome =
  | { readonly status: 'restored'; readonly conflicts: readonly string[]; readonly dropped: readonly string[] }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly message: string };

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
 *
 * `projectId` is the id the manifest references the project by: the key of its entry in
 * `Workspace.activeEnvironments` and of its place in an environment's scope (#468).
 */
export type WorkspaceContext = () =>
  { readonly workspace: Workspace; readonly projectSlug: string; readonly projectId: string } | undefined;

/** What a {@link WorkspaceContext} answers, when the project is open inside a workspace. */
type WorkspaceContextValue = NonNullable<ReturnType<WorkspaceContext>>;

/** Owns the open project: its model, its folder, its autosave timer and its watcher. */
export class ProjectHost {
  open: OpenProject | undefined;
  /** Parsed keystores, keyed by entry id; see {@link loadKeystoreFor} for the invalidation key. */
  private readonly keystoreCache = new Map<string, { key: string; keystore: Keystore }>();
  private autosave: NodeJS.Timeout | undefined;
  /** Open {@link holdAutosave} holds: while any is, an edit marks the project dirty but schedules no write. */
  private autosaveHolds = 0;
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
  workspaceContext: WorkspaceContext | undefined;

  /**
   * The session's current values for this host's project, read afresh on every resolution (cookie
   * jar spec §5.2). Set by `WorkspaceService`; absent for a standalone project and in tests.
   */
  private currentValues: (() => CurrentValues | undefined) | undefined;

  /**
   * The session's issued-token cache, which the WS-Security preview only ever peeks at. Set by
   * `WorkspaceService`; absent for a standalone project and in tests, where a preview shows every
   * issued token as its placeholder.
   */
  issuedTokens: IssuedTokenSource | undefined;

  /** The workspace's secret sources, read afresh by every preflight. Set by `WorkspaceService`; absent standalone and in tests. */
  private secretSources: (() => SecretSourcesSnapshot | undefined) | undefined;

  constructor(
    readonly engine: EngineService,
    readonly hooks: ProjectHostHooks = {},
    /** Overrides the filesystem `saveProject` writes through. Test-only (deferred writes). */
    private readonly fs?: FsLike,
    /** The `${#Global#name}` scope. Omitted in tests that never expand properties. */
    private readonly globals?: Pick<GlobalProperties, 'get'>,
    /** Resolves `passwordRef`s at import time. Omitted in tests that never import with auth. */
    readonly secrets?: Pick<SecretStore, 'get'>,
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
    readonly picks?: ReadPicks,
    /**
     * Answers Chromium's PAC-style proxy string for a URL — the app passes a wrapper around
     * `session.resolveProxy`, so "System proxy" means exactly what the rest of Electron's
     * network stack means by it. Omitted in tests (and then `mode: 'system'` goes direct),
     * which is also what keeps this class free of any `electron` import.
     */
    private readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>,
  ) {
    this.kindHosts = Object.fromEntries(
      MAIN_KINDS.map((kind) => [kind.kind, kind.createHost(this)]),
    ) as unknown as KindHosts;
  }

  /** Each kind's share of this host (spec §5.3), built once with the host. */
  private readonly kindHosts: KindHosts;

  /** One kind's host: its caches and the methods that are about it alone. */
  kind<K extends keyof KindHosts>(kind: K): KindHosts[K] {
    return this.kindHosts[kind];
  }

  /**
   * Tells this host which workspace its project is open inside. Injected after construction
   * rather than through the constructor because the workspace owns the host, not the other way
   * round: `WorkspaceService` builds the host, then hands it a closure over the entry it just
   * created. Pass `undefined` to go back to standalone behaviour.
   */
  setWorkspaceContext(context: WorkspaceContext | undefined): void {
    this.workspaceContext = context;
  }

  /** Tells this host where its project's current values come from; `undefined` drops them. */
  setCurrentValues(source: (() => CurrentValues | undefined) | undefined): void {
    this.currentValues = source;
  }

  /** Tells this host where the open workspace's secret sources come from, for the preflight's early warnings. */
  setSecretSources(source: (() => SecretSourcesSnapshot | undefined) | undefined): void {
    this.secretSources = source;
  }

  /** Tells this host which issued-token cache its WS-Security preview peeks at; `undefined` drops it. */
  setIssuedTokens(source: IssuedTokenSource | undefined): void {
    this.issuedTokens = source;
  }

  /**
   * The URL a send of `request` would go to, resolved the way the project is actually open:
   * through the project's active workspace environment when there is a workspace context (spec §3.3 —
   * a linked project's own environment wins, then the workspace environment's override for
   * `<projectSlug>/<interfaceSlug>`, then the project's own resolution), and through the
   * project's own active environment when there is not.
   *
   * The single place the choice is made, so the send path, the TLS lookup, the WS-A `To`
   * header and the preflight badge can never disagree about where a request is going.
   */
  resolveEndpointFor(
    project: Project,
    iface: Interface,
    request: Pick<SoapRequestDef, 'endpointId' | 'endpointUrl'>,
    envId?: string,
  ): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint } {
    const context = this.workspaceContextFor(envId);
    if (context === undefined) {
      return resolveEndpoint(project, envId ?? project.activeEnvironmentId, iface, request);
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
   * Whether `envId` is absent (meaning the active environment) or names one of the open
   * project's environments. A named environment the project lacks resolves nothing rather than
   * silently falling back to the active one.
   */
  knowsEnvironment(project: Project, envId: string | undefined): boolean {
    if (envId === undefined) {
      return true;
    }
    const context = this.workspaceContext?.();
    const environments = context === undefined ? project.environments : context.workspace.environments;
    return environments.some((environment) => environment.id === envId);
  }

  /**
   * The workspace context resolution reads under `envId`, for this host's project (#468). With no
   * `envId` the workspace's resolution slot holds the project's own active environment (or nothing),
   * never another project's. Inside a workspace the environments that apply are the *workspace's*,
   * so a named `envId` is a workspace environment id: it must apply to the project, and the returned
   * context is a copy of the workspace with that environment active — the real workspace, and the
   * project's active environment, are never changed. `undefined` outside a workspace.
   *
   * @throws WorkspaceError `environment-out-of-scope` when `envId` does not apply to the project,
   * `environment-not-found` when it names no workspace environment.
   */
  private workspaceContextFor(envId: string | undefined): WorkspaceContextValue | undefined {
    const context = this.workspaceContext?.();
    if (context === undefined) {
      return undefined;
    }
    if (envId === undefined) {
      return { ...context, workspace: workspaceForProject(context.workspace, context.projectId) };
    }
    assertEnvironmentInScope(context.workspace, envId, context.projectId);
    return { ...context, workspace: { ...context.workspace, activeEnvironmentId: envId } };
  }

  /**
   * What the engine runs a send of `requestId` in: the open project, its folder, the environment
   * resolution reads under `envId` (the active one when absent), inside a workspace the workspace
   * with that environment active, and the enabled global properties. `undefined` when no project
   * is open or the environment is unknown. The request itself is
   * not looked up: the caller selects it from `project`.
   *
   * @throws WorkspaceError `environment-out-of-scope` when, inside a workspace, `envId` names a
   * workspace environment that does not apply to this project (#468).
   */
  runContextFor(
    _requestId: string,
    envId?: string,
  ):
    | {
        readonly project: Project;
        readonly projectDir: string;
        readonly environmentId?: string;
        readonly workspace?: RunWorkspace;
        readonly globals: PropertyMap;
        readonly current?: CurrentValues;
        readonly registry?: ProtocolRegistry;
      }
    | undefined {
    if (this.open === undefined || !this.knowsEnvironment(this.open.project, envId)) {
      return undefined;
    }
    const { project, dir } = this.open;
    const workspace = this.workspaceContextFor(envId);
    const current = this.currentValues?.();
    const environmentId =
      workspace === undefined ? (envId ?? project.activeEnvironmentId) : workspace.workspace.activeEnvironmentId;
    return {
      project,
      projectDir: dir,
      ...(environmentId !== undefined ? { environmentId } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      globals: this.enabledGlobals(),
      ...(current !== undefined ? { current } : {}),
      ...this.registryOption(),
    };
  }

  /** The run's registry as an engine option, or nothing for the built-in one. */
  private registryOption(): { readonly registry?: ProtocolRegistry } {
    return this.hooks.registry !== undefined ? { registry: this.hooks.registry } : {};
  }

  /**
   * The environments a request of this project can be sent under, in order, and the active
   * one: the workspace's when the project is open inside one (its own environments' ids mean
   * nothing to resolution there), else the project's. What *Send to environments…* names and
   * validates its environment ids against.
   */
  sendEnvironments(): {
    environments: { id: string; name: string; protected?: boolean }[];
    activeId: string | undefined;
  } {
    if (this.open === undefined) {
      return { environments: [], activeId: undefined };
    }
    const { project } = this.open;
    const context = this.workspaceContextFor(undefined);
    // Inside a workspace only the environments that apply to this project count (#468).
    const source =
      context === undefined
        ? { environments: this.open.project.environments, activeId: this.open.project.activeEnvironmentId }
        : {
            environments: environmentsForProject(context.workspace, context.projectId),
            activeId: context.workspace.activeEnvironmentId,
          };
    return {
      environments: [...source.environments]
        .sort((a, b) => a.order - b.order)
        .map((environment) => ({
          id: environment.id,
          name: environment.name,
          // Inside a workspace, the linked project environment's flag counts too (#345).
          ...(isProtectedEnvironment(project, environment) ? { protected: true } : {}),
        })),
      activeId: source.activeId,
    };
  }

  /** The current preferences, or the engine defaults when none were injected. */
  prefs(): Preferences | undefined {
    return this.preferences?.get();
  }

  /**
   * The property scopes a send (or a preflight) expands against: the open project's own
   * properties, the active environment's (or `envId`'s) overrides, the user's globals and the
   * process environment. With no project open only the global and system scopes are populated,
   * so an ad-hoc send still expands `${#Global#…}`.
   */
  scopesFor(envId?: string): PropertyScopes {
    // A `${#System#…}` value these scopes expand is recorded like a resolved secret, as a send's are (#181):
    // a pushed WebSocket message and a sequence step's callback assertions expand against them.
    // A fresh `${#Dynamic#…}` memo each call: one push or check shares its values, the next does not.
    return {
      ...withSystemValuesReported(this.unreportedScopesFor(envId), recordSecretValue),
      dynamic: new DynamicValues(),
    };
  }

  private unreportedScopesFor(envId?: string): PropertyScopes {
    const globals = this.enabledGlobals();
    const current = this.currentValues?.();
    if (this.open === undefined) {
      return { project: {}, global: overlayCurrent(globals, current?.global), system: process.env };
    }
    const context = this.workspaceContextFor(envId);
    const laid = withCurrentValues(
      {
        project: this.open.project,
        ...(context !== undefined ? { workspace: context.workspace } : {}),
        globals,
      },
      current,
    );
    if (context !== undefined) {
      // Inside a workspace the active environment is the workspace's entry for this project, and the project
      // manifest's own `activeEnvironmentId` is deliberately not read (spec §3.3) — so `envId`
      // names a workspace environment here, resolved without changing the active one.
      return resolveWorkspaceScopes({
        workspace: laid.workspace ?? context.workspace,
        project: laid.project,
        globals: laid.globals,
        system: process.env,
      });
    }
    return resolveScopes(laid.project, envId ?? this.open.project.activeEnvironmentId, laid.globals, process.env);
  }

  /** The enabled global properties, the `${#Global#…}` scope every send of this project reads. */
  private enabledGlobals(): PropertyMap {
    const globalsState = this.globals?.get();
    return globalsState === undefined ? {} : enabledProperties(globalsState.properties, globalsState.disabled);
  }

  /**
   * Resolves one saved request's endpoint under the active environment and reports every
   * property reference that would not expand. Nothing is sent; see {@link preflightRequest}.
   */
  preflight(requestId: string, envId?: string): PreflightResult {
    const open = this.require();
    // Inside a workspace the project manifest's own `activeEnvironmentId` names a project environment,
    // never one resolution reads (spec §3.3): `envId` goes through as asked, absent meaning the
    // project's active workspace environment (#468).
    const context = this.workspaceContextFor(envId);
    const activeId =
      context === undefined ? (envId ?? open.project.activeEnvironmentId) : context.workspace.activeEnvironmentId;
    return preflightRequest(
      open.project,
      requestId,
      this.scopesFor(context === undefined ? activeId : envId),
      activeId,
      this.kind('soap').defaultWsaActionFor(requestId),
      this.workspaceContext?.() === undefined
        ? undefined
        : (iface, request) => this.resolveEndpointFor(open.project, iface, request),
      this.secretSources?.(),
    );
  }

  /** Resolves a `secretRef` to plaintext for the duration of one import/send call. */
  async getSecret(ref: string): Promise<string | undefined> {
    return this.secrets?.get(ref);
  }

  /** The open project's id, or `undefined` when no project is open. Used to key its history file. */
  projectId(): string | undefined {
    return this.open?.project.id;
  }

  /** The current snapshot, or `null` when no project is open. */
  snapshot(): ProjectWire | null {
    if (this.open === undefined) {
      return null;
    }
    const kindOptions: Partial<ProjectWireContext> = {};
    for (const host of this.kindHostList()) {
      Object.assign(kindOptions, host.wireOptions?.());
    }
    return toProjectWire(this.open.project, {
      ...kindOptions,
      dir: this.open.dir,
      dirty: this.open.dirty,
      ...(this.open.lastSavedAt !== undefined ? { lastSavedAt: this.open.lastSavedAt } : {}),
      problems: this.open.problems,
      runtime: this.open.runtime,
      ...(this.open.switchedOff !== undefined ? { switchedOff: this.open.switchedOff } : {}),
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

  require(): OpenProject {
    if (this.open === undefined) {
      throw new ProjectError('no-project', 'No project is open');
    }
    return this.open;
  }

  emitChanged(): void {
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
    const loaded = await loadProject(dir, this.registryOption());
    let { project, problems } = loaded;
    const disk = projectFiles(loaded.project, this.registryOption());
    let restore: UnsavedRestoreOutcome | undefined;
    if (options.unsaved !== undefined) {
      const merge = mergeUnsaved(options.unsaved.baseline, disk, options.unsaved.unsaved);
      if (!merge.changed) {
        restore = { status: 'unchanged' };
      } else {
        try {
          ({ project, problems } = await loadProject(dir, {
            fs: overlayFs(dir, merge.files, disk.keys()),
            ...this.registryOption(),
          }));
          restore = { status: 'restored', conflicts: merge.conflicts, dropped: merge.dropped };
        } catch (error) {
          restore = { status: 'failed', message: errorMessage(error) };
        }
      }
    }
    const enabledKinds = this.hooks.enabledKinds;
    const switchedOff = enabledKinds === undefined ? [] : await switchedOffProjectFiles(dir, enabledKinds);
    await this.closeInternal();
    this.adopt(
      project,
      dir,
      problems.map((problem) => ({ code: problem.code, message: problem.message, file: problem.file })),
      disk,
    );
    if (switchedOff.length > 0 && this.open !== undefined) {
      this.open.switchedOff = switchedOff;
    }
    this.restore = restore;
    if (restore?.status === 'restored') {
      this.markDirty();
    }
    this.emitChanged();
    this.hydrating = Promise.all(this.kindHostList().map(async (host) => await host.hydrate?.())).then(() => undefined);
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
    return { baseline: open.baseline, unsaved: projectFiles(open.project, this.registryOption()) };
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
    this.open?.watcher.expect(paths, { snapshot: false });
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
      runtime: new Map(soapInterfacesOf(project).map((iface) => [iface.id, { hydration: 'pending' as const }])),
      lastWritten: undefined,
      baseline: baseline ?? projectFiles(project, this.registryOption()),
      watcher,
    };
    const now = Date.now();
    this.expectedOnDisk = this.expectedOnDisk.filter((entry) => entry.until > now);
    for (const entry of this.expectedOnDisk) {
      watcher.expect(entry.paths, { snapshot: false });
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
    for (const host of this.kindHostList()) {
      host.close?.(this.open.project);
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
    const files = projectFiles(model, { writer: PROJECT_WRITER, ...this.registryOption() });
    // Announce every path this write might touch (all it will write, plus anything it may remove)
    // before it starts, so the events of a save that has not finished — or of the autosave right
    // behind it — are never taken for an outside edit; `release` then keeps what was really written.
    // Before the first save of an opened project nothing records what is on disk, and the write also
    // prunes files the model no longer has (stale ones, a deleted or renamed folder): list them.
    const candidates = new Set([...files.keys(), ...(open.lastWritten?.keys() ?? [])]);
    if (open.lastWritten === undefined) {
      for (const path of open.watcher.managedOnDisk()) {
        candidates.add(path);
      }
    }
    const token = open.watcher.announce([...candidates]);
    let result: Awaited<ReturnType<typeof saveProject>> | undefined;
    try {
      result = await saveProject(model, open.dir, {
        ...(open.lastWritten !== undefined ? { previous: open.lastWritten } : {}),
        writer: PROJECT_WRITER,
        ...this.registryOption(),
        ...(options.backups !== undefined ? { backups: options.backups } : {}),
        ...(this.fs !== undefined ? { fs: this.fs } : {}),
      });
    } finally {
      // A failed save leaves the app's own partial writes on disk; those that are not kept below are
      // replayed as outside edits, which is right: disk now differs from the model.
      const touched = result !== undefined ? [...result.written, ...result.removed] : [];
      // A removed folder (a deleted interface or API) takes every file in it along: those are the app's too.
      const folders = result?.removed.map((path) => `${path}/`) ?? [];
      // A path renamed only by case (Foo to foo on a case-folding disk) is the app's too, under both names.
      const byFold = new Map<string, string[]>();
      for (const path of candidates) {
        byFold.set(path.toLowerCase(), [...(byFold.get(path.toLowerCase()) ?? []), path]);
      }
      const renamedByCase = [...byFold.values()].filter((group) => group.length > 1).flat();
      open.watcher.release(token, [
        ...touched,
        ...renamedByCase,
        ...[...candidates].filter((path) => folders.some((folder) => path.startsWith(folder))),
      ]);
    }
    open.lastWritten = files;
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
  markDirty(): void {
    const open = this.require();
    open.dirty = true;
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
      this.autosave = undefined;
    }
    if (!this.autosaveEnabled() || this.autosaveHolds > 0) {
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

  /**
   * Suspends autosave until the returned release is called: an edit still marks the project dirty,
   * but no timer is scheduled, and one already running is stopped. A manual save's secret review
   * holds it while the person decides, so the edit under review is not written behind the dialog.
   * An explicit {@link save} is not held. On the last release a dirty project schedules its
   * autosave as usual; releasing twice is harmless.
   */
  holdAutosave(): () => void {
    this.autosaveHolds += 1;
    if (this.autosave !== undefined) {
      clearTimeout(this.autosave);
      this.autosave = undefined;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.autosaveHolds -= 1;
      if (this.autosaveHolds === 0) {
        this.onAutosaveEnabled();
      }
    };
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
    converted?: ScriptConversionsResultWire;
  }> {
    const open = this.require();
    const workspaceProperties = this.workspaceContext?.()?.workspace.properties;
    // A backup's name depends on what is in `imported-scripts/` now, so a conversion lists it afresh.
    const takenBackups = change.kind === 'convert-scripts' ? await listImportedScripts(open.dir) : undefined;
    // Converting saves the whole model, so it would write unrelated unsaved edits past the manual
    // save's secret review: it refuses until the project is saved. Checked after the listing's await,
    // so no edit slips in between.
    if (change.kind === 'convert-scripts' && open.dirty) {
      throw new ProjectError(
        'project-dirty',
        'The project has unsaved changes. Save it first, then convert its scripts.',
      );
    }
    const before = open.project;
    const result = await applyChange(before, change, {
      ...(takenBackups !== undefined ? { takenBackups } : {}),
      ...(workspaceProperties !== undefined ? { workspaceProperties } : {}),
      ...(this.hooks.enabledKinds !== undefined ? { enabledKinds: this.hooks.enabledKinds } : {}),
      reservedSequenceSlugs: refusedSequenceSlugs(open.problems),
      reservedMockSlugs: refusedMockSlugs(open.problems),
      generateMock: (containerId, name, binding) =>
        generateMock(open.project, open.dir, containerId, { name, ...(binding !== undefined ? { binding } : {}) }),
      addAttachmentFile: (input) => this.kind('soap').readAttachmentSource(open.dir, input),
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
    if (result.conversions !== undefined) {
      return await this.convertScripts(before, result.project, result.conversions);
    }
    open.project = result.project;
    for (const host of this.kindHostList()) {
      host.afterChange?.(change);
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

  /**
   * The rest of a `convert-scripts` change (convert-imported-scripts spec §7): each applied level's
   * backups are written, each at its exact path and never over a file, then the converted model is
   * saved, whose save deletes the stale `.js` files. A backup that cannot be written stops the change
   * before the model is touched; the backups already written stay, as harmless text.
   *
   * @throws ProjectError `import-path-refused` or `backup-exists` from {@link writeImportedScripts};
   * `project-changed` when another edit landed while the backups were written
   */
  private async convertScripts(
    before: Project,
    converted: Project,
    conversions: ScriptConversions,
  ): Promise<{ project: ProjectWire; converted: ScriptConversionsResultWire }> {
    const open = this.require();
    const report = conversionsResultWire(conversions, (ownerId) => levelPath(before, ownerId));
    if (conversions.applied.length === 0) {
      return { project: this.snapshot() as ProjectWire, converted: report };
    }
    await this.writeImportedScripts(
      conversions.applied.flatMap((level) => level.backups),
      { strict: true },
    );
    // The backups were written for `before`; a model that moved on meanwhile, or a project closed or
    // reopened meanwhile, is not overwritten.
    if (this.open !== open || open.project !== before) {
      throw new ProjectError(
        'project-changed',
        'The project changed while its scripts were being converted; nothing was converted. Review them again.',
      );
    }
    open.project = converted;
    this.markDirty();
    this.emitChanged();
    await this.save({ reason: 'convert-scripts' });
    return { project: this.snapshot() as ProjectWire, converted: report };
  }

  /**
   * The review of converting imported scripts: every layered level at or below `rootId`, or in the
   * whole project, worked out from the model as it stands (unsaved edits included), its backups
   * named against a fresh listing of `imported-scripts/`.
   */
  async proposeConversions(rootId?: string): Promise<{ readonly project: Project; readonly levels: LevelProposal[] }> {
    const open = this.require();
    const taken = await listImportedScripts(open.dir);
    const project = open.project;
    return { project, levels: proposeConversions(project, rootId, taken) };
  }

  /**
   * Replaces the model with `update(model)` as one change — dirty, autosave scheduled, `changed`
   * raised — for a rewrite main computes itself rather than one `ProjectChange` (moving found
   * secrets behind `${secret:…}` tokens). `false`, changing nothing, when no project is open or
   * `update` returns the model it was given.
   */
  applyModelUpdate(update: (project: Project) => Project): boolean {
    if (this.open === undefined) {
      return false;
    }
    const next = update(this.open.project);
    if (next === this.open.project) {
      return false;
    }
    this.open.project = next;
    this.markDirty();
    this.emitChanged();
    return true;
  }

  /** The keystore registry entry with this id, or `undefined` when no project has one. */
  private keystoreDef(keystoreId: string): KeystoreDef | undefined {
    const ref = this.open?.project.keystores.find((candidate) => candidate.id === keystoreId);
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
   * One keystore's parsed material by its entry id, `undefined` when the project has no such entry:
   * what the engine signs, encrypts, verifies and decrypts with on a send. It reads through
   * {@link loadKeystoreFor}, so a file picked this session loads from outside the project folder.
   *
   * @throws WirebenchError `keystore-outside-project` | `keystore-unreadable` | `keystore-bad-password`
   */
  async keystoreFor(keystoreId: string): Promise<Keystore | undefined> {
    const def = this.keystoreDef(keystoreId);
    return def === undefined ? undefined : await this.loadKeystoreFor(def);
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
          ...(alias.keyOnly === true ? { keyOnly: true } : {}),
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
   * What this project contributes to the workspace's certificate check: the TLS endpoints it
   * names, resolved under every environment it can be sent under, and each keystore's
   * certificates (every alias's leaf and the chain it carries) or why the keystore did not load.
   * See `certificate-expiry.ts`.
   */
  async certificateSources(): Promise<ProjectCertificateSources> {
    const open = this.require();
    const context = this.workspaceContext?.();
    // Inside a workspace its environments override this project's endpoints under
    // `<projectSlug>/<slug>`; those overrides are this project's endpoints too — of the
    // environments that apply to the project only, as a send could never reach the others (#468).
    const overrides =
      context === undefined
        ? []
        : context.workspace.environments
            .filter((environment) => appliesToProject(environment, context.projectId))
            .flatMap((environment) =>
              Object.entries(environment.endpoints)
                .filter(([key]) => key.startsWith(`${context.projectSlug}/`))
                .map(([, url]) => url),
            );
    const envIds = [undefined, ...this.sendEnvironments().environments.map((environment) => environment.id)];
    const endpoints = resolveEndpointTargets(
      endpointCandidates(open.project, overrides),
      envIds.map((envId) => this.scopesFor(envId)),
    );
    const keystores: KeystoreCertificates[] = [];
    for (const ref of open.project.keystores) {
      const def = this.keystoreDef(ref.id);
      if (def === undefined) continue;
      try {
        const keystore = await this.loadKeystoreFor(def);
        // A keystore that also carries its CA holds that certificate in several places; report it once.
        const seen = new Set<string>();
        const certificates = keystore.aliases
          .flatMap((alias) =>
            pemCertificates([alias.certPem, ...alias.chainPem].join('\n')).map((cert) => ({
              ...cert,
              alias: alias.alias,
            })),
          )
          .filter((cert) => {
            if (seen.has(cert.fingerprint256)) return false;
            seen.add(cert.fingerprint256);
            return true;
          });
        keystores.push({ name: def.name, certificates });
      } catch (error) {
        keystores.push({ name: def.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { projectId: open.project.id, endpoints, keystores };
  }

  /**
   * The CA bundle's own certificates — not the system roots {@link trustAnchors} puts in front of
   * them — or none when no bundle is configured or it may not be read.
   */
  async caBundleCertificates(): Promise<PemCertificateSummary[]> {
    const anchors = await this.trustAnchors();
    if (anchors === undefined) return [];
    const roots = new Set(rootCertificates);
    return pemCertificates(anchors.filter((anchor) => !roots.has(anchor)).join('\n'));
  }

  /**
   * The TLS options a send of `requestId` must use, or `undefined` when nothing in the
   * project or the preferences has anything to say about TLS.
   *
   * Three independent things are folded in here, all of which need main's file system or its
   * secret store: the client identity (the request's keystore, else the global one
   * from preferences — request wins), the extra trust anchors from the preferred CA bundle,
   * and the resolved endpoint's `trustInvalid` opt-out.
   *
   * A selected-but-unloadable keystore throws rather than silently sending without a client
   * certificate: a mutual-TLS request that quietly degrades is the worst possible outcome.
   * A CA bundle that will not load is *not* fatal — it only ever adds anchors, so a bad path
   * leaves verification exactly as strict as it was.
   */
  async tlsFor(requestId: string, envId?: string): Promise<TlsOptionsWire | undefined> {
    if (this.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.open.project, requestId);
    const identity = await this.clientIdentityFor(location?.request.properties.sslKeystoreRef);
    const ca = await this.trustAnchors();
    const trustInvalid =
      location !== undefined &&
      this.resolveEndpointFor(this.open.project, location.iface, location.request, envId).endpoint?.trustInvalid ===
        true;
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
  async clientIdentityFor(requestKeystoreId: string | undefined): Promise<TlsOptionsWire | undefined> {
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
  async trustAnchors(): Promise<readonly string[] | undefined> {
    const open = this.open;
    if (open === undefined) return undefined;
    return resolveTrustAnchors({ caBundlePath: this.prefs()?.ssl.caBundlePath, roots: [open.dir], picks: this.picks });
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
    if (proxy === undefined) return undefined;
    // `ProxyOptions` (network-options.ts) and `ProxyOptionsWire` are the same shape.
    return resolveProxy({
      url,
      proxy,
      getSecret: (ref) => this.getSecret(ref),
      ...(this.resolveSystemProxy !== undefined ? { resolveSystemProxy: this.resolveSystemProxy } : {}),
    });
  }

  /**
   * Writes an importer's scripts under the open project's `imported-scripts/`, where nothing reads
   * them. A path that resolves outside that folder — a `..` segment, a symlink below it — is skipped
   * and reported. An existing file is never overwritten: the script goes to the first free `-2`,
   * `-3`, … name, inserted before the first `.` of the file name, and the move is reported. Each name
   * is taken by an exclusive create ({@link writeNewFile}), not by a check and then a write, so a
   * file or link that appears at a name in between is never replaced or followed.
   *
   * `strict` (a conversion's backups, whose converted header names each exact path): a path outside
   * the folder, or one already taken, throws instead of being skipped or moved, and the scripts after
   * it are not written.
   *
   * @returns the project-relative paths written, each `{ from, to }` a clash moved, and the paths skipped
   * @throws ProjectError `import-path-refused` when `imported-scripts` is a symbolic link or not a folder,
   * or, when `strict`, a path resolves outside it; `backup-exists` when `strict` and a path is taken
   */
  async writeImportedScripts(
    scripts: readonly { readonly path: string; readonly source: string }[],
    options: { readonly strict?: boolean } = {},
  ): Promise<{ written: string[]; renamed: { from: string; to: string }[]; skipped: string[] }> {
    const open = this.require();
    const scriptsRoot = resolvePath(open.dir, IMPORTED_SCRIPTS_DIR);
    // `isInsideAny` realpaths the root too, so a linked root would vouch for wherever it points.
    const rootInfo = await lstat(scriptsRoot).catch(() => undefined);
    if (rootInfo !== undefined && (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())) {
      throw new ProjectError(
        'import-path-refused',
        `${IMPORTED_SCRIPTS_DIR} in the project folder is ${
          rootInfo.isSymbolicLink() ? 'a symbolic link' : 'not a folder'
        }, so no imported script was written`,
        { details: { path: scriptsRoot } },
      );
    }
    const realScriptsRoot = resolvePath(await realpath(open.dir), IMPORTED_SCRIPTS_DIR);
    const contained = async (target: string) =>
      (await isInsideAny([scriptsRoot], target)) && isInsideReal(realScriptsRoot, await realpathOfPrefix(target));
    const written: string[] = [];
    const renamed: { from: string; to: string }[] = [];
    const skipped: string[] = [];
    for (const script of scripts) {
      const segments = script.path.split('/');
      const fileName = segments.pop() ?? '';
      const dot = fileName.indexOf('.');
      const stem = dot <= 0 ? fileName : fileName.slice(0, dot);
      const tail = dot <= 0 ? '' : fileName.slice(dot);
      let path = script.path;
      let target = resolvePath(open.dir, ...path.split('/'));
      // Importers slugify every segment; this guards that promise against `..` and a symlink too.
      if (!(await contained(target))) {
        if (options.strict === true) {
          throw new ProjectError(
            'import-path-refused',
            `${script.path} is outside ${IMPORTED_SCRIPTS_DIR} in the project folder, so it was not written`,
            { details: { path: script.path } },
          );
        }
        skipped.push(script.path);
        continue;
      }
      await mkdir(resolvePath(target, '..'), { recursive: true });
      const data = Buffer.from(script.source, 'utf8');
      for (let n = 2; !(await writeNewFile(target, data)); n += 1) {
        if (options.strict === true) {
          throw new ProjectError('backup-exists', `${script.path} already exists, so it was not overwritten`, {
            details: { path: script.path },
          });
        }
        path = [...segments, `${stem}-${String(n)}${tail}`].join('/');
        target = resolvePath(open.dir, ...path.split('/'));
      }
      written.push(path);
      if (path !== script.path) renamed.push({ from: script.path, to: path });
    }
    return { written, renamed, skipped };
  }

  /** Adds the properties whose names the project does not have yet (imports never overwrite), then saves. */
  async importProperties(
    properties: Readonly<Record<string, string>>,
    disabled: readonly string[],
  ): Promise<ProjectWire> {
    const open = this.require();
    const fresh = Object.fromEntries(
      Object.entries(properties).filter(([name]) => !Object.hasOwn(open.project.properties, name)),
    );
    const freshDisabled = disabled.filter((name) => Object.hasOwn(fresh, name));
    open.project = {
      ...open.project,
      properties: { ...open.project.properties, ...fresh },
      disabledProperties: [...new Set([...open.project.disabledProperties, ...freshDisabled])].sort(),
    };
    open.dirty = true;
    await this.save({ reason: 'import' });
    return this.snapshot() as ProjectWire;
  }

  /**
   * The documents cached for `apiId`, read from its own folder by the kind that owns the API.
   *
   * Nothing is re-fetched to answer this: an API whose definition was not cached has no documents
   * to show, and says so with `definition-cache-missing` rather than reaching the network behind
   * the user's back.
   */
  async apiDefinitionDocuments(apiId: string): Promise<ApiDefinitionDocuments> {
    return await this.apiDefinitionOwner(apiId).apiDefinitionDocuments(apiId);
  }

  /**
   * One cached document's text, matched by the location the manifest records.
   *
   * The renderer names a location, never a path: a document the manifest does not list is an
   * `unknown-document` error, so this can never be turned into a read of an arbitrary file.
   */
  async apiDefinitionText(apiId: string, location: string): Promise<string> {
    return await this.apiDefinitionOwner(apiId).apiDefinitionText(apiId, location);
  }

  /** Writes every cached document of `apiId` into `dir`, byte for byte, returning the file names. */
  async exportApiDefinitionTo(apiId: string, dir: string): Promise<string[]> {
    return await this.apiDefinitionOwner(apiId).exportApiDefinitionTo(apiId, dir);
  }

  /**
   * The host of the kind that owns `apiId` and caches its definition (spec §5.3).
   *
   * @throws ProjectError `not-found` when no kind does.
   */
  private apiDefinitionOwner(apiId: string): KindApiDefinitions {
    for (const host of this.kindHostList()) {
      if (host.apiDefinitions?.ownsApi(apiId) === true) {
        return host.apiDefinitions;
      }
    }
    throw new ProjectError('not-found', `No API with id "${apiId}"`, { details: { id: apiId } });
  }

  /** Every kind's host, in `MAIN_KINDS` order. */
  private kindHostList(): KindHostHooks[] {
    return MAIN_KINDS.map((kind) => this.kindHosts[kind.kind]);
  }
}

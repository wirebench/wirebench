/**
 * Owns the open workspace: the folder scan behind the picker, the manifest, one
 * {@link ProjectHost} per project reference, the `entityId → projectId` index every IPC
 * channel routes through, and `workspace-state.json`.
 *
 * Path authority (ADR-0005, extended by the workspaces spec §6): the only roots this class
 * ever touches are `<userData>/workspaces/<workspaceId>` and the absolute folder a *linked*
 * project reference names — and a linked path only ever enters the manifest from a native
 * dialog pick made in main. Nothing here accepts a path from the renderer, and deletion is
 * trash-only through the injected {@link WorkspaceServiceDeps.trash} (which is why there is no
 * `electron` import in this file, and no `rm` of anything under `userData`).
 *
 * Project operations (`addProject`, `removeProject`, `linkProject`, …), workspace environments
 * and `mutate` are deliberately absent — they land in later tasks rather than as stubs here.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  createWorkspace,
  loadWorkspace,
  saveWorkspace,
  WirebenchError,
  WorkspaceError,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACES_DIR,
  workspaceDir,
  workspaceManifestFile,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { FsLike, Workspace, WorkspaceProjectRef } from '@wirebench/engine';
import type { ReadPicks } from './dialog-picks.js';
import type { EngineService } from './engine-service.js';
import type { GlobalProperties } from './global-properties.js';
import type { HistoryService } from './history-service.js';
import type { PreferencesService } from './preferences.js';
import { ProjectHost } from './project-host.js';
import type { ProjectRouter } from './project-router.js';
import { RecentProjects } from './recent-projects.js';
import type { SecretStore } from './secrets.js';
import { WorkspaceState } from './workspace-state.js';
import type {
  EngineProgressEvent,
  ProjectWire,
  WorkspaceEnvironmentWire,
  WorkspaceProjectWire,
  WorkspaceSummaryWire,
  WorkspaceWire,
} from '../shared/wire-types.js';
import type { HydrationStatus } from '../shared/wire-types.js';

/**
 * What the service raises. Every project-scoped hook carries the `projectId` its host belongs
 * to, which is what lets one renderer hold several projects at once.
 */
export interface WorkspaceHooks {
  /** The open workspace changed (opened, closed, renamed, a project's status moved). */
  readonly onChanged?: (workspace: WorkspaceWire | null) => void;
  /** One project's model changed; `null` means that host closed. */
  readonly onProjectChanged?: (projectId: string, project: ProjectWire | null) => void;
  /** Files under one project's folder changed outside the app. */
  readonly onProjectChangedOnDisk?: (projectId: string, paths: readonly string[]) => void;
  /** One interface of one project finished (or failed) re-importing. */
  readonly onHydration?: (
    projectId: string,
    event: { interfaceId: string; status: HydrationStatus; message?: string },
  ) => void;
  /** Import progress, forwarded from whichever host raised it. */
  readonly onProgress?: (event: EngineProgressEvent) => void;
}

/** Everything {@link WorkspaceService} needs; all of it injected, none of it from `electron`. */
export interface WorkspaceServiceDeps {
  /** Electron's `userData` directory: `workspaces/` and `workspace-state.json` live under it. */
  readonly userDataDir: string;
  /** The single in-process engine every host shares. */
  readonly engine: EngineService;
  /** The `${#Global#name}` scope. Omitted in tests that never expand properties. */
  readonly globals?: Pick<GlobalProperties, 'get'>;
  /** Resolves `passwordRef`s at import time. Omitted in tests that never import with auth. */
  readonly secrets?: Pick<SecretStore, 'get'>;
  /** The user's preferences, folded into every send input. */
  readonly preferences?: Pick<PreferencesService, 'get'>;
  /** The session's native-dialog picks; the only evidence a path outside a project is readable. */
  readonly picks?: ReadPicks;
  /** Answers Chromium's PAC-style proxy string for a URL; omitted in tests. */
  readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>;
  /** One history file per open project. */
  readonly history: Pick<HistoryService, 'open' | 'close' | 'closeAll'>;
  readonly hooks?: WorkspaceHooks;
  /**
   * Moves a folder to the OS trash. Injected (`shell.trashItem` in the app, a folder move in
   * e2e) so this file stays free of `electron` — and so deletion can never become an `rm`.
   */
  readonly trash?: (path: string) => Promise<void>;
  /** Overrides the filesystem workspace/project writes go through. Test-only (deferred writes). */
  readonly fs?: FsLike;
  /** Clock, injectable so tests can pin `createdAt`/`lastOpenedAt`. */
  readonly now?: () => Date;
}

/** One project reference of the open workspace, plus the host that is (or is not) behind it. */
interface OpenProjectEntry {
  readonly ref: WorkspaceProjectRef;
  /** Absolute: `projects/<slug>` inside the workspace, or the linked folder's own path. */
  readonly dir: string;
  host: ProjectHost | undefined;
  /** The id the project's own `wirebench.yaml` carries once open; `ref.id` until then. */
  projectId: string;
  status: WorkspaceProjectWire['status'];
  message: string | undefined;
}

/** The open workspace: its manifest, its folder and its project entries in manifest order. */
interface OpenWorkspace {
  workspace: Workspace;
  readonly dir: string;
  readonly entries: OpenProjectEntry[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Workspace ids are ULIDs, and a workspace id is also a *folder name* — so anything that is
 * not one is refused before it can reach `join`. The id is the one workspace value that comes
 * straight from the renderer (the picker sends back a row's id), which is exactly why it is
 * checked here rather than trusted: `../../etc` must never become a path.
 */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns `id` when it is usable as a single folder name.
 *
 * @throws WorkspaceError `workspace-path-invalid` otherwise.
 */
function requireWorkspaceId(id: string): string {
  if (!WORKSPACE_ID.test(id)) {
    throw new WorkspaceError('workspace-path-invalid', `Not a workspace id: ${JSON.stringify(id)}`, {
      details: { workspaceId: id },
    });
  }
  return id;
}

/** Throws unless `path` is an absolute filesystem path — a relative linked ref is a corrupt ref. */
function requireAbsolute(path: string | undefined, slug: string): string {
  if (path === undefined || !isAbsolute(path)) {
    throw new WorkspaceError('workspace-path-invalid', `Linked project "${slug}" has no absolute path.`, {
      details: { slug, path },
    });
  }
  return path;
}

/**
 * Owns the open workspace and every host under it, and routes each IPC call to the right one.
 *
 * Only ever one workspace is open at a time: {@link open} closes the current one first, so the
 * set of hosts, the history files and the entity index are always those of a single workspace.
 */
export class WorkspaceService implements ProjectRouter {
  /** The open workspace, or `undefined` when the user is at the picker. */
  private current: OpenWorkspace | undefined;
  /** `entityId → projectId`, rebuilt from each host's snapshot whenever one changes. */
  private readonly index = new Map<string, string>();
  private readonly state: WorkspaceState;
  private readonly now: () => Date;
  /** Why the last {@link openLast} (or {@link close} save) failed; see {@link lastError}. */
  private failure: string | undefined;

  constructor(private readonly deps: WorkspaceServiceDeps) {
    this.state = new WorkspaceState(deps.userDataDir);
    this.now = deps.now ?? ((): Date => new Date());
  }

  // ——— listing ————————————————————————————————————————————————————————————————————————————

  /**
   * Every workspace on disk: the directory scan of `<userData>/workspaces/*`, decorated with
   * `lastOpenedAt` from `workspace-state.json`.
   *
   * A folder whose manifest is missing or corrupt is listed with `unreadable: true` and its
   * folder name standing in for the display name — never dropped, because the user can still
   * reveal it in the file manager and repair it by hand. Sorted most-recently-opened first,
   * then by name.
   */
  async list(): Promise<WorkspaceSummaryWire[]> {
    const root = join(this.deps.userDataDir, WORKSPACES_DIR);
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const { lastOpenedAt } = await this.state.read();
    const rows: WorkspaceSummaryWire[] = [];
    for (const name of names) {
      const dir = join(root, name);
      if (!existsSync(workspaceManifestFile(dir))) {
        continue;
      }
      const stamp = lastOpenedAt[name];
      try {
        const { workspace } = await loadWorkspace(dir, this.fsOption());
        rows.push({
          id: workspace.id,
          name: workspace.name,
          dir,
          projectCount: workspace.projects.length,
          createdAt: workspace.createdAt,
          ...(stamp !== undefined ? { lastOpenedAt: stamp } : {}),
        });
      } catch {
        rows.push({
          id: name,
          name,
          dir,
          projectCount: 0,
          createdAt: '',
          ...(stamp !== undefined ? { lastOpenedAt: stamp } : {}),
          unreadable: true,
        });
      }
    }
    rows.sort((left, right) => {
      const byStamp = (right.lastOpenedAt ?? '').localeCompare(left.lastOpenedAt ?? '');
      return byStamp !== 0 ? byStamp : left.name.localeCompare(right.name);
    });
    return rows;
  }

  /**
   * The message of the last failure that was swallowed rather than thrown — today only
   * {@link openLast}'s (which must never throw at startup) and a failed close-time save.
   * Cleared by the next successful {@link open}.
   */
  lastError(): string | undefined {
    return this.failure;
  }

  // ——— lifecycle ——————————————————————————————————————————————————————————————————————————

  /** Creates a workspace folder (named by its ULID, never by the display name) and opens it. */
  async create(name: string): Promise<WorkspaceWire> {
    const workspace = createWorkspace(name, { now: this.now });
    const dir = workspaceDir(this.deps.userDataDir, workspace.id);
    await mkdir(dir, { recursive: true });
    await saveWorkspace(workspace, dir, this.fsOption());
    // Created up front so the folder is recognisably a workspace even before it has projects.
    await mkdir(join(dir, WORKSPACE_PROJECTS_DIR), { recursive: true });
    return await this.open(workspace.id);
  }

  /**
   * Closes whatever is open, then opens `id`: loads the manifest and brings up one host per
   * project reference, sequentially (a workspace with a dozen projects must not fan out a dozen
   * parallel imports; each host's hydration then runs as its own background job as before).
   *
   * A project whose folder is gone, or that will not open, becomes a `missing`/`error` row with
   * no host behind it — the workspace still opens. That is the whole point of the per-project
   * status: a broken project can never cost the user their workspace.
   */
  async open(id: string): Promise<WorkspaceWire> {
    await this.close();
    const dir = workspaceDir(this.deps.userDataDir, requireWorkspaceId(id));
    const { workspace } = await loadWorkspace(dir, this.fsOption());
    const open: OpenWorkspace = { workspace, dir, entries: [] };
    this.current = open;
    this.failure = undefined;

    for (const ref of workspace.projects) {
      const entry: OpenProjectEntry = {
        ref,
        dir: ref.source === 'internal' ? workspaceProjectDir(dir, ref.slug) : requireAbsolute(ref.path, ref.slug),
        host: undefined,
        projectId: ref.id,
        status: 'loading',
        message: undefined,
      };
      open.entries.push(entry);
      await this.openEntry(entry);
    }

    await this.state.remember(id, this.now().toISOString());
    this.deps.hooks?.onChanged?.(this.snapshot());
    return this.requireSnapshot();
  }

  /** Brings up one project's host, recording the outcome on `entry` rather than throwing. */
  private async openEntry(entry: OpenProjectEntry): Promise<void> {
    if (!existsSync(entry.dir)) {
      entry.status = 'missing';
      entry.message = `The project folder is gone: ${entry.dir}`;
      return;
    }
    const host = new ProjectHost(
      this.deps.engine,
      // Retired in a later task; until then a host still wants one, backed by the app's own
      // `userData` so it never writes inside a workspace or a linked folder.
      new RecentProjects(this.deps.userDataDir),
      {
        onChanged: (project) => {
          if (project !== null) {
            entry.projectId = project.id;
          }
          // The index is the routing table for every `ipc/*` channel, so it is rebuilt from the
          // hosts' own snapshots on *every* change — an import, a rename or a removal all add
          // or drop entity ids, and a stale table would route a request to the wrong project.
          this.reindex();
          this.deps.hooks?.onProjectChanged?.(entry.projectId, project);
        },
        onChangedOnDisk: (paths) => {
          this.deps.hooks?.onProjectChangedOnDisk?.(entry.projectId, paths);
        },
        onHydration: (event) => {
          this.deps.hooks?.onHydration?.(entry.projectId, event);
        },
        onProgress: (event) => {
          this.deps.hooks?.onProgress?.(event);
        },
      },
      this.deps.fs,
      this.deps.globals,
      this.deps.secrets,
      this.deps.preferences,
      this.deps.picks,
      this.deps.resolveSystemProxy,
    );
    try {
      const project = await host.openProject(entry.dir);
      entry.host = host;
      entry.projectId = project.id;
      entry.status = 'ready';
      entry.message = undefined;
      this.reindex();
      // History has to be open before anything can record a send against this project.
      await this.deps.history.open(project.id);
    } catch (error) {
      entry.status = 'error';
      entry.message = errorMessage(error);
      entry.host = undefined;
      await host.close().catch(() => undefined);
    }
  }

  /**
   * Reopens the workspace recorded in `workspace-state.json`, or `null` when there is none or
   * it will not open. Never throws: a broken workspace has to leave the user at the picker with
   * an error ({@link lastError}), not at a dead app.
   */
  async openLast(): Promise<WorkspaceWire | null> {
    const { lastOpenedWorkspaceId } = await this.state.read();
    if (lastOpenedWorkspaceId === undefined) {
      return null;
    }
    try {
      return await this.open(lastOpenedWorkspaceId);
    } catch (error) {
      this.failure = errorMessage(error);
      await this.close().catch(() => undefined);
      return null;
    }
  }

  /** Saves every open project, stops every host and detaches every history file. */
  async close(): Promise<null> {
    const open = this.current;
    if (open === undefined) {
      return null;
    }
    try {
      await this.saveAll('close');
    } catch (error) {
      // A failed final save must not strand the app with a half-closed workspace; the message
      // is kept so the caller (or the picker) can surface it.
      this.failure = errorMessage(error);
    }
    for (const entry of open.entries) {
      await entry.host?.close().catch(() => undefined);
    }
    this.deps.history.closeAll();
    this.index.clear();
    this.current = undefined;
    this.deps.hooks?.onChanged?.(null);
    return null;
  }

  // ——— manifest ———————————————————————————————————————————————————————————————————————————

  /** Renames a workspace — the open one, or any other on disk — and returns the fresh list. */
  async rename(id: string, name: string): Promise<WorkspaceSummaryWire[]> {
    const open = this.current;
    if (open !== undefined && open.workspace.id === id) {
      open.workspace = { ...open.workspace, name };
      await saveWorkspace(open.workspace, open.dir, this.fsOption());
      this.deps.hooks?.onChanged?.(this.snapshot());
    } else {
      const dir = workspaceDir(this.deps.userDataDir, requireWorkspaceId(id));
      const { workspace } = await loadWorkspace(dir, this.fsOption());
      await saveWorkspace({ ...workspace, name }, dir, this.fsOption());
    }
    return await this.list();
  }

  /**
   * Moves a workspace folder to the trash (never an `rm`), closing it first when it is the open
   * one, and returns the list without it. The renderer's confirmation happens before this call.
   */
  async delete(id: string): Promise<WorkspaceSummaryWire[]> {
    const dir = workspaceDir(this.deps.userDataDir, requireWorkspaceId(id));
    if (this.current?.workspace.id === id) {
      await this.close();
    }
    const trash = this.deps.trash;
    if (trash === undefined) {
      throw new WirebenchError('trash-unavailable', 'Deleting a workspace needs a trash implementation.', {
        details: { workspaceId: id },
      });
    }
    await trash(dir);
    await this.state.forget(id);
    return await this.list();
  }

  // ——— snapshot ———————————————————————————————————————————————————————————————————————————

  /** The open workspace as the renderer sees it, or `null` when none is open. */
  snapshot(): WorkspaceWire | null {
    const open = this.current;
    if (open === undefined) {
      return null;
    }
    const workspace = open.workspace;
    return {
      id: workspace.id,
      name: workspace.name,
      ...(workspace.description !== undefined ? { description: workspace.description } : {}),
      dir: open.dir,
      properties: { ...workspace.properties },
      environments: workspace.environments.map((environment): WorkspaceEnvironmentWire => ({
        id: environment.id,
        name: environment.name,
        slug: environment.slug,
        order: environment.order,
        properties: { ...environment.properties },
        endpoints: { ...environment.endpoints },
      })),
      ...(workspace.activeEnvironmentId !== undefined ? { activeEnvironmentId: workspace.activeEnvironmentId } : {}),
      projects: open.entries.map((entry): WorkspaceProjectWire => {
        const project = entry.host?.snapshot();
        return {
          id: entry.projectId,
          name: project?.name ?? entry.ref.slug,
          slug: entry.ref.slug,
          source: entry.ref.source,
          dir: entry.dir,
          status: entry.status,
          ...(entry.message !== undefined ? { message: entry.message } : {}),
        };
      }),
    };
  }

  /** Saves every open project at once — `project.save` saves the workspace, not one project. */
  async saveAll(reason: string): Promise<void> {
    const results = await Promise.allSettled(this.hosts().map(async (host) => await host.save({ reason })));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
  }

  // ——— hosts and routing ——————————————————————————————————————————————————————————————————

  /** Every open host, in manifest order. Projects that are missing or failed contribute none. */
  hosts(): readonly ProjectHost[] {
    return (this.current?.entries ?? []).flatMap((entry) => (entry.host !== undefined ? [entry.host] : []));
  }

  /**
   * The host of `projectId`.
   *
   * @throws WirebenchError `unknown-project` when no open project has that id.
   */
  hostFor(projectId: string): ProjectHost {
    const host = this.current?.entries.find((entry) => entry.projectId === projectId)?.host;
    if (host === undefined) {
      throw new WirebenchError('unknown-project', `No open project with id "${projectId}"`, {
        details: { projectId },
      });
    }
    return host;
  }

  /**
   * The host owning `entityId` — a project, interface, request, environment, keystore or
   * WS-Security configuration id. This is how every entity-addressed IPC channel finds its
   * project without the renderer having to say which one.
   *
   * @throws WirebenchError `unknown-entity` when no open project holds it.
   */
  hostOfEntity(entityId: string): ProjectHost {
    const projectId = this.index.get(entityId);
    if (projectId === undefined) {
      throw new WirebenchError('unknown-entity', `No open project holds the entity "${entityId}"`, {
        details: { entityId },
      });
    }
    return this.hostFor(projectId);
  }

  /** Rebuilds {@link index} from every open host's snapshot. */
  private reindex(): void {
    this.index.clear();
    for (const entry of this.current?.entries ?? []) {
      const project = entry.host?.snapshot();
      if (project === null || project === undefined) {
        continue;
      }
      const add = (id: string): void => {
        this.index.set(id, project.id);
      };
      add(project.id);
      for (const iface of project.interfaces) {
        add(iface.id);
      }
      for (const request of project.requests) {
        add(request.id);
      }
      for (const environment of project.environments) {
        add(environment.id);
      }
      for (const keystore of project.keystores) {
        add(keystore.id);
      }
      for (const config of project.wssOutgoing) {
        add(config.id);
      }
      for (const config of project.wssIncoming) {
        add(config.id);
      }
    }
  }

  /** `loadWorkspace`/`saveWorkspace` options, carrying the injected filesystem when there is one. */
  private fsOption(): { fs: FsLike } | undefined {
    return this.deps.fs !== undefined ? { fs: this.deps.fs } : undefined;
  }

  private requireSnapshot(): WorkspaceWire {
    const snapshot = this.snapshot();
    if (snapshot === null) {
      throw new WorkspaceError('workspace-not-found', 'No workspace is open.');
    }
    return snapshot;
  }

  // ——— ProjectRouter ——————————————————————————————————————————————————————————————————————
  // Each method resolves its host from the id it already receives, then forwards unchanged.

  /** @inheritdoc */
  projectSnapshot(projectId: string): ProjectWire | null {
    return this.current?.entries.find((entry) => entry.projectId === projectId)?.host?.snapshot() ?? null;
  }

  /** @inheritdoc */
  projectId(entityId: string): string | undefined {
    return this.index.get(entityId);
  }

  /** @inheritdoc */
  mutate(...[projectId, change]: Parameters<ProjectRouter['mutate']>): ReturnType<ProjectRouter['mutate']> {
    return this.hostFor(projectId).mutate(change);
  }

  /** @inheritdoc */
  save(...[projectId, options]: Parameters<ProjectRouter['save']>): ReturnType<ProjectRouter['save']> {
    return options === undefined ? this.hostFor(projectId).save() : this.hostFor(projectId).save(options);
  }

  /** @inheritdoc */
  proxyFor(...[projectId, url]: Parameters<ProjectRouter['proxyFor']>): ReturnType<ProjectRouter['proxyFor']> {
    return this.hostFor(projectId).proxyFor(url);
  }

  /** @inheritdoc */
  scopesFor(...[requestId, envId]: Parameters<ProjectRouter['scopesFor']>): ReturnType<ProjectRouter['scopesFor']> {
    return this.hostOfEntity(requestId).scopesFor(envId);
  }

  /** @inheritdoc */
  preflight(...args: Parameters<ProjectRouter['preflight']>): ReturnType<ProjectRouter['preflight']> {
    return this.hostOfEntity(args[0]).preflight(...args);
  }

  /** @inheritdoc */
  authFor(...args: Parameters<ProjectRouter['authFor']>): ReturnType<ProjectRouter['authFor']> {
    return this.hostOfEntity(args[0]).authFor(...args);
  }

  /** @inheritdoc */
  requestMeta(...args: Parameters<ProjectRouter['requestMeta']>): ReturnType<ProjectRouter['requestMeta']> {
    return this.hostOfEntity(args[0]).requestMeta(...args);
  }

  /** @inheritdoc */
  requestSource(...args: Parameters<ProjectRouter['requestSource']>): ReturnType<ProjectRouter['requestSource']> {
    return this.hostOfEntity(args[0]).requestSource(...args);
  }

  /** @inheritdoc */
  buildLiveSendInput(
    ...args: Parameters<ProjectRouter['buildLiveSendInput']>
  ): ReturnType<ProjectRouter['buildLiveSendInput']> {
    return this.hostOfEntity(args[0]).buildLiveSendInput(...args);
  }

  /** @inheritdoc */
  sendInputFor(...args: Parameters<ProjectRouter['sendInputFor']>): ReturnType<ProjectRouter['sendInputFor']> {
    return this.hostOfEntity(args[0]).sendInputFor(...args);
  }

  /** @inheritdoc */
  sendAttachmentsFor(
    ...args: Parameters<ProjectRouter['sendAttachmentsFor']>
  ): ReturnType<ProjectRouter['sendAttachmentsFor']> {
    return this.hostOfEntity(args[0]).sendAttachmentsFor(...args);
  }

  /** @inheritdoc */
  dumpFileFor(...args: Parameters<ProjectRouter['dumpFileFor']>): ReturnType<ProjectRouter['dumpFileFor']> {
    return this.hostOfEntity(args[0]).dumpFileFor(...args);
  }

  /** @inheritdoc */
  tlsFor(...args: Parameters<ProjectRouter['tlsFor']>): ReturnType<ProjectRouter['tlsFor']> {
    return this.hostOfEntity(args[0]).tlsFor(...args);
  }

  /** @inheritdoc */
  wssFor(...args: Parameters<ProjectRouter['wssFor']>): ReturnType<ProjectRouter['wssFor']> {
    return this.hostOfEntity(args[0]).wssFor(...args);
  }

  /** @inheritdoc */
  hasOutgoingWss(...args: Parameters<ProjectRouter['hasOutgoingWss']>): ReturnType<ProjectRouter['hasOutgoingWss']> {
    return this.hostOfEntity(args[0]).hasOutgoingWss(...args);
  }

  /** @inheritdoc */
  validationTargetFor(
    ...args: Parameters<ProjectRouter['validationTargetFor']>
  ): ReturnType<ProjectRouter['validationTargetFor']> {
    return this.hostOfEntity(args[0]).validationTargetFor(...args);
  }

  /** @inheritdoc */
  insertWsaHeaders(
    ...args: Parameters<ProjectRouter['insertWsaHeaders']>
  ): ReturnType<ProjectRouter['insertWsaHeaders']> {
    return this.hostOfEntity(args[0]).insertWsaHeaders(...args);
  }

  /** @inheritdoc */
  removeWsaHeadersFrom(
    ...args: Parameters<ProjectRouter['removeWsaHeadersFrom']>
  ): ReturnType<ProjectRouter['removeWsaHeadersFrom']> {
    return this.hostOfEntity(args[0]).removeWsaHeadersFrom(...args);
  }

  /** @inheritdoc */
  previewOutgoingWss(
    ...args: Parameters<ProjectRouter['previewOutgoingWss']>
  ): ReturnType<ProjectRouter['previewOutgoingWss']> {
    return this.hostOfEntity(args[0]).previewOutgoingWss(...args);
  }

  /** @inheritdoc */
  insertWssEntry(...args: Parameters<ProjectRouter['insertWssEntry']>): ReturnType<ProjectRouter['insertWssEntry']> {
    return this.hostOfEntity(args[0]).insertWssEntry(...args);
  }

  /** @inheritdoc */
  removeOutgoingWssFrom(
    ...args: Parameters<ProjectRouter['removeOutgoingWssFrom']>
  ): ReturnType<ProjectRouter['removeOutgoingWssFrom']> {
    return this.hostOfEntity(args[0]).removeOutgoingWssFrom(...args);
  }

  /** @inheritdoc */
  resolveAttachmentPath(
    ...args: Parameters<ProjectRouter['resolveAttachmentPath']>
  ): ReturnType<ProjectRouter['resolveAttachmentPath']> {
    return this.hostOfEntity(args[0]).resolveAttachmentPath(...args);
  }

  /** @inheritdoc */
  addAttachmentBytes(
    ...args: Parameters<ProjectRouter['addAttachmentBytes']>
  ): ReturnType<ProjectRouter['addAttachmentBytes']> {
    return this.hostOfEntity(args[0]).addAttachmentBytes(...args);
  }

  /** @inheritdoc */
  planDefinitionUpdate(
    ...args: Parameters<ProjectRouter['planDefinitionUpdate']>
  ): ReturnType<ProjectRouter['planDefinitionUpdate']> {
    return this.hostOfEntity(args[0]).planDefinitionUpdate(...args);
  }

  /** @inheritdoc */
  applyDefinitionUpdate(
    ...args: Parameters<ProjectRouter['applyDefinitionUpdate']>
  ): ReturnType<ProjectRouter['applyDefinitionUpdate']> {
    return this.hostOfEntity(args[0]).applyDefinitionUpdate(...args);
  }

  /** @inheritdoc */
  exportDefinitionTo(
    ...args: Parameters<ProjectRouter['exportDefinitionTo']>
  ): ReturnType<ProjectRouter['exportDefinitionTo']> {
    return this.hostOfEntity(args[0]).exportDefinitionTo(...args);
  }

  /** @inheritdoc */
  definitionDocs(...args: Parameters<ProjectRouter['definitionDocs']>): ReturnType<ProjectRouter['definitionDocs']> {
    return this.hostOfEntity(args[0]).definitionDocs(...args);
  }

  /** @inheritdoc */
  inspectKeystore(...args: Parameters<ProjectRouter['inspectKeystore']>): ReturnType<ProjectRouter['inspectKeystore']> {
    return this.hostOfEntity(args[0]).inspectKeystore(...args);
  }
}

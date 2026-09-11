/**
 * Owns the open workspace: the folder scan behind the picker, the manifest, one
 * {@link ProjectHost} per project reference, the `entityId → projectId` index every IPC
 * channel routes through, and `workspace-state.json`.
 *
 * Path authority (ADR-0005, extended by the workspaces spec §6): the only roots this class
 * ever touches are `<userData>/workspaces/<workspaceId>`, the absolute folder a *linked*
 * project reference names, and a folder the user just chose in a native dialog — and a linked
 * or exported path only ever enters the manifest (or a write) from that dialog pick, made in
 * main and recorded in `DialogPicks`. Nothing here accepts a path from the renderer, and
 * deletion is trash-only through the injected {@link WorkspaceServiceDeps.trash} (never an
 * `rm` of anything under `userData`, and never anything at all under a linked root).
 *
 * The one `electron` dependency is `./native-dialogs.js` — the folder picker itself, which is
 * the whole point of these methods taking a `WebContents`.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  attachmentsDir,
  createProject,
  createWorkspace,
  createWorkspaceEnvironment,
  definitionCacheDir,
  INTERFACES_DIR,
  loadProject,
  loadWorkspace,
  ProjectError,
  reidentifyProject,
  saveProject,
  saveWorkspace,
  uniqueSlug,
  WirebenchError,
  WorkspaceError,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACES_DIR,
  workspaceDir,
  workspaceManifestFile,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { FsLike, Project, Workspace, WorkspaceEnvironment, WorkspaceProjectRef } from '@wirebench/engine';
import type { WebContents } from 'electron';
import type { RecordsReadPicks, RecordsWritePicks, ReadPicks } from './dialog-picks.js';
import { pickFolder, pickFolderToWrite } from './native-dialogs.js';
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
  WorkspaceChange,
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
  /**
   * The session's native-dialog picks; the only evidence a path outside a project is readable.
   * The hosts consume the read-check half; the link/import/export/locate pickers *record* into
   * it, which is why the full `DialogPicks` shape is wanted here and not just {@link ReadPicks}.
   */
  readonly picks?: ReadPicks & RecordsReadPicks & RecordsWritePicks;
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
  /** Mutable because `locateProject` re-points a linked reference at a new folder in place. */
  ref: WorkspaceProjectRef;
  /** Absolute: `projects/<slug>` inside the workspace, or the linked folder's own path. */
  dir: string;
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

/** Copies a directory tree verbatim when it is there, and does nothing when it is not. */
async function copyTreeIfPresent(source: string, target: string): Promise<void> {
  if (!existsSync(source)) {
    return;
  }
  await cp(source, target, { recursive: true });
}

/**
 * Copies the parts of a project folder that `projectFiles` does not describe: the attachment
 * blobs and every interface's `definition/` cache.
 *
 * `saveProject` writes the *model* — the YAML the project is defined by. The bytes the user
 * attached and the WSDL/XSD documents the definition cache holds are not in that model, so a
 * copy made with `saveProject` alone would open with every interface un-hydrated and every
 * attachment gone. They are copied byte-for-byte rather than re-fetched: an export must not
 * depend on the original service still being reachable.
 */
async function copyProjectPayload(source: string, target: string): Promise<void> {
  await copyTreeIfPresent(attachmentsDir(source), attachmentsDir(target));
  let interfaces: string[];
  try {
    interfaces = (await readdir(join(source, INTERFACES_DIR), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const slug of interfaces) {
    await copyTreeIfPresent(definitionCacheDir(source, slug), definitionCacheDir(target, slug));
  }
}

/** Whether `dir` holds nothing (a folder that does not exist counts as empty). */
async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/**
 * Loads the project stored in `dir`, turning "there is no project here" into the workspace-level
 * code the picker shows. Any other {@link ProjectError} (a malformed file, a too-new format) is
 * left alone: the user picked a real project folder, and the reason it will not load is the
 * project's, not the workspace's.
 *
 * @throws WorkspaceError `project-folder-missing` when the folder holds no `wirebench.yaml`.
 */
async function loadPickedProject(dir: string): Promise<Project> {
  try {
    return (await loadProject(dir)).project;
  } catch (error) {
    if (error instanceof ProjectError && error.code === 'project-not-found') {
      throw new WorkspaceError('project-folder-missing', `No project in ${dir}`, { details: { dir } });
    }
    throw error;
  }
}

/**
 * Owns the open workspace and every host under it, and routes each IPC call to the right one.
 *
 * Only ever one workspace is open at a time: {@link open} closes the current one first, so the
 * set of hosts, the history files and the entity index are always those of a single workspace.
 */
/**
 * The environment `environmentId` names, or a `WorkspaceError` — a change addressed at an
 * environment that is not there is a renderer bug, and applying it as a no-op would hide it.
 *
 * @throws WorkspaceError `environment-not-found`.
 */
function requireEnvironment(workspace: Workspace, environmentId: string): WorkspaceEnvironment {
  const environment = workspace.environments.find((candidate) => candidate.id === environmentId);
  if (environment === undefined) {
    throw new WorkspaceError('environment-not-found', `No environment with id "${environmentId}" in this workspace.`, {
      details: { environmentId },
    });
  }
  return environment;
}

/** `workspace` with no active environment — the field dropped, not set to `undefined`. */
function withoutActiveEnvironment(workspace: Workspace): Workspace {
  const copy: Omit<Workspace, 'activeEnvironmentId'> & { activeEnvironmentId?: string } = { ...workspace };
  delete copy.activeEnvironmentId;
  return copy;
}

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

    // Past this point the service holds hosts, history files and a `current` — so anything that
    // still throws has to put it back at the picker rather than leave it half-open.
    try {
      for (const ref of workspace.projects) {
        let projectDir: string;
        try {
          projectDir =
            ref.source === 'internal' ? workspaceProjectDir(dir, ref.slug) : requireAbsolute(ref.path, ref.slug);
        } catch (error) {
          // A corrupt reference (a linked ref with no absolute path) is a broken *project*, not a
          // broken workspace: it becomes an `error` row like any other one that will not open.
          open.entries.push({
            ref,
            dir: ref.path ?? '',
            host: undefined,
            projectId: ref.id,
            status: 'error',
            message: errorMessage(error),
          });
          continue;
        }
        const entry: OpenProjectEntry = {
          ref,
          dir: projectDir,
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
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
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
    // The host resolves properties and endpoints through the workspace from here on. The
    // closure re-reads `this.current` and `entry.ref` every time, so an environment switch or a
    // relocated linked project is picked up without touching the host again.
    host.setWorkspaceContext(() => {
      const open = this.current;
      return open === undefined ? undefined : { workspace: open.workspace, projectSlug: entry.ref.slug };
    });
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
    // Resolved *before* the close: a service with no trash must refuse outright rather than drop
    // the user at the picker and then throw with the folder still on disk.
    const trash = this.deps.trash;
    if (trash === undefined) {
      throw new WirebenchError('trash-unavailable', 'Deleting a workspace needs a trash implementation.', {
        details: { workspaceId: id },
      });
    }
    if (this.current?.workspace.id === id) {
      await this.close();
    }
    await trash(dir);
    await this.state.forget(id);
    return await this.list();
  }

  // ——— projects ———————————————————————————————————————————————————————————————————————————
  //
  // Not one of these takes a path. `addProject` and `removeProject` are named by id alone;
  // link, import, export and locate run the native folder picker in main and record what came
  // back. A renderer that could name a folder here would be a way out of every containment rule
  // the app has, which is why the `WebContents` — and nothing else — crosses the boundary.

  /**
   * Creates an empty project inside the workspace at `projects/<uniqueSlug(name)>` and opens it.
   *
   * Two projects may share a display name; only the slug (and the ULID) has to be unique.
   */
  async addProject(name: string): Promise<{ workspace: WorkspaceWire; projectId: string }> {
    const open = this.requireOpen();
    const slug = uniqueSlug(name, this.takenSlugs());
    const project = createProject(name);
    const dir = workspaceProjectDir(open.dir, slug);
    await mkdir(dir, { recursive: true });
    await saveProject(project, dir, this.fsOption());
    await this.adoptProject(open, { id: project.id, slug, source: 'internal' }, dir);
    return { workspace: this.requireSnapshot(), projectId: project.id };
  }

  /**
   * Drops a project from the workspace: its host is closed, its history file detached and its
   * reference removed from the manifest.
   *
   * `deleteFiles` only ever applies to an **internal** project, and only ever moves the folder
   * to the trash. A linked project's folder is the user's own, outside the workspace: removing
   * the link never touches a byte of it, whatever `deleteFiles` says. The trash call comes
   * *after* the manifest is saved, so a trash that fails cannot leave the manifest pointing at
   * a folder the workspace no longer believes in.
   *
   * @throws WorkspaceError `project-not-in-workspace` when no reference has that id.
   */
  async removeProject(projectId: string, options: { deleteFiles: boolean }): Promise<WorkspaceWire> {
    const open = this.requireOpen();
    const index = open.entries.findIndex((candidate) => candidate.projectId === projectId);
    if (index === -1) {
      throw new WorkspaceError('project-not-in-workspace', `No project with id "${projectId}" in this workspace.`, {
        details: { projectId },
      });
    }
    const entry = open.entries[index] as OpenProjectEntry;
    const trashFolder = options.deleteFiles && entry.ref.source === 'internal';
    const trash = this.deps.trash;
    // Resolved before anything is closed: refusing outright beats removing the project and then
    // failing to put its folder anywhere.
    if (trashFolder && trash === undefined) {
      throw new WirebenchError('trash-unavailable', 'Deleting a project folder needs a trash implementation.', {
        details: { projectId },
      });
    }
    await entry.host?.close().catch(() => undefined);
    this.deps.history.close(entry.projectId);
    open.entries.splice(index, 1);
    this.reindex();
    await this.saveManifest(open);
    if (trashFolder && trash !== undefined) {
      await trash(entry.dir);
    }
    this.deps.hooks?.onChanged?.(this.snapshot());
    return this.requireSnapshot();
  }

  /**
   * Adds an existing project folder to the workspace *in place* — the files stay where they are
   * and the manifest records their absolute path.
   *
   * The folder is realpath'd before anything else, so the containment root a linked project's
   * host enforces is the real directory rather than a symlink that could be re-pointed later.
   * A project whose id is already open is refused rather than opened twice: two hosts over one
   * id would make the entity index ambiguous, and the renderer's answer to the refusal is
   * "import a copy" (which re-identifies).
   *
   * @returns the workspace, or `null` when the user cancelled the dialog.
   * @throws WorkspaceError `project-folder-missing` when the folder holds no project,
   * `project-already-in-workspace` (with `details.projectId`) when it is already here.
   */
  async linkProject(sender: WebContents): Promise<WorkspaceWire | null> {
    const open = this.requireOpen();
    const picked = await pickFolder(sender, { title: 'Link project folder' }, this.requirePicks());
    if (picked === undefined) {
      return null;
    }
    const dir = await realpath(picked);
    const project = await loadPickedProject(dir);
    if (open.entries.some((entry) => entry.ref.id === project.id || entry.projectId === project.id)) {
      throw new WorkspaceError('project-already-in-workspace', `"${project.name}" is already in this workspace.`, {
        details: { projectId: project.id },
      });
    }
    await this.adoptProject(
      open,
      { id: project.id, slug: uniqueSlug(project.name, this.takenSlugs()), source: 'linked', path: dir },
      dir,
    );
    return this.requireSnapshot();
  }

  /**
   * Copies an existing project folder *into* the workspace under fresh ids.
   *
   * Re-identification is what lets the copy coexist with its source — including when the source
   * is itself linked into the same workspace — because entity ids have to stay globally unique
   * inside one open workspace. `secretRef`s are deliberately left alone: they name the user's
   * keychain entries, not the project's.
   *
   * @returns the workspace, or `null` when the user cancelled the dialog.
   */
  async importProjectFolder(sender: WebContents): Promise<WorkspaceWire | null> {
    const open = this.requireOpen();
    const picked = await pickFolder(sender, { title: 'Import project folder' }, this.requirePicks());
    if (picked === undefined) {
      return null;
    }
    const source = await realpath(picked);
    const copy = reidentifyProject(await loadPickedProject(source));
    const slug = uniqueSlug(copy.name, this.takenSlugs());
    const dir = workspaceProjectDir(open.dir, slug);
    await mkdir(dir, { recursive: true });
    await saveProject(copy, dir, this.fsOption());
    await copyProjectPayload(source, dir);
    await this.adoptProject(open, { id: copy.id, slug, source: 'internal' }, dir);
    return this.requireSnapshot();
  }

  /**
   * Writes a copy of one open project into a folder the user picks, ids kept.
   *
   * The target must be empty: export writes a whole project folder, and quietly merging one
   * into a directory that already holds files is how a user loses the files that were there.
   * The model written is the host's current one, unsaved edits included.
   *
   * @returns the folder written to, or `null` when the user cancelled the dialog.
   * @throws WorkspaceError `export-target-not-empty` when the chosen folder holds anything.
   */
  async exportProject(projectId: string, sender: WebContents): Promise<{ dir: string } | null> {
    const entry = this.requireEntry(projectId);
    const model = entry.host?.model();
    if (model === undefined) {
      throw new WirebenchError('unknown-project', `Project "${projectId}" is not open.`, { details: { projectId } });
    }
    const picked = await pickFolderToWrite(sender, this.requirePicks(), { title: 'Export project to folder' });
    if (picked === undefined) {
      return null;
    }
    const dir = await realpath(picked);
    if (!(await isEmptyDir(dir))) {
      throw new WorkspaceError('export-target-not-empty', `"${dir}" is not empty.`, { details: { dir } });
    }
    await saveProject(model, dir, this.fsOption());
    await copyProjectPayload(entry.dir, dir);
    return { dir };
  }

  /**
   * Re-points a linked project whose folder has moved at the folder the user picks.
   *
   * The picked folder has to hold the *same* project: locating is "this project moved", not
   * "use this other project instead", and silently swapping one project for another would
   * strand every history entry and every saved request that names the old ids.
   *
   * @returns the workspace, or `null` when the user cancelled the dialog.
   * @throws WorkspaceError `project-folder-mismatch` when the folder holds a different project.
   */
  async locateProject(projectId: string, sender: WebContents): Promise<WorkspaceWire | null> {
    const open = this.requireOpen();
    const entry = this.requireEntry(projectId);
    if (entry.ref.source !== 'linked' || entry.status !== 'missing') {
      throw new WirebenchError(
        'project-not-relocatable',
        'Only a linked project whose folder is gone can be located.',
        {
          details: { projectId, source: entry.ref.source, status: entry.status },
        },
      );
    }
    const picked = await pickFolder(sender, { title: 'Locate project folder' }, this.requirePicks());
    if (picked === undefined) {
      return null;
    }
    const dir = await realpath(picked);
    const project = await loadPickedProject(dir);
    if (project.id !== entry.ref.id) {
      throw new WorkspaceError('project-folder-mismatch', `"${dir}" holds a different project.`, {
        details: { projectId: entry.ref.id, foundProjectId: project.id, dir },
      });
    }
    entry.ref = { ...entry.ref, path: dir };
    entry.dir = dir;
    entry.status = 'loading';
    entry.message = undefined;
    await this.openEntry(entry);
    await this.saveManifest(open);
    this.deps.hooks?.onChanged?.(this.snapshot());
    return this.requireSnapshot();
  }

  /** Appends one reference, brings its host up, writes the manifest and raises `onChanged`. */
  private async adoptProject(open: OpenWorkspace, ref: WorkspaceProjectRef, dir: string): Promise<void> {
    const entry: OpenProjectEntry = {
      ref,
      dir,
      host: undefined,
      projectId: ref.id,
      status: 'loading',
      message: undefined,
    };
    open.entries.push(entry);
    await this.openEntry(entry);
    await this.saveManifest(open);
    this.deps.hooks?.onChanged?.(this.snapshot());
  }

  /** Rewrites the manifest's project list from the entries, which are the source of truth. */
  private async saveManifest(open: OpenWorkspace): Promise<void> {
    open.workspace = { ...open.workspace, projects: open.entries.map((entry) => entry.ref) };
    await saveWorkspace(open.workspace, open.dir, this.fsOption());
  }

  /** Every slug already used in the open workspace — what `uniqueSlug` is asked to avoid. */
  private takenSlugs(): ReadonlySet<string> {
    return new Set((this.current?.entries ?? []).map((entry) => entry.ref.slug));
  }

  private requireOpen(): OpenWorkspace {
    if (this.current === undefined) {
      throw new WorkspaceError('workspace-not-found', 'No workspace is open.');
    }
    return this.current;
  }

  /**
   * The entry for `projectId`, open or not — `missing` and `error` projects can still be
   * removed and located, which is exactly when the user needs to.
   *
   * @throws WorkspaceError `project-not-in-workspace`.
   */
  private requireEntry(projectId: string): OpenProjectEntry {
    const entry = this.requireOpen().entries.find((candidate) => candidate.projectId === projectId);
    if (entry === undefined) {
      throw new WorkspaceError('project-not-in-workspace', `No project with id "${projectId}" in this workspace.`, {
        details: { projectId },
      });
    }
    return entry;
  }

  /** The pick recorder every dialog-driven operation writes its choice into. */
  private requirePicks(): ReadPicks & RecordsReadPicks & RecordsWritePicks {
    const picks = this.deps.picks;
    if (picks === undefined) {
      throw new WirebenchError('picks-unavailable', 'A native folder pick needs the session dialog picks.');
    }
    return picks;
  }

  // ——— environments and properties ———————————————————————————————————————————————————————

  /**
   * Applies one {@link WorkspaceChange} to the open workspace: its name, its `${#Workspace#…}`
   * properties, or one of its environments. Every change is written through `saveWorkspace`
   * before it is announced, so what the renderer is shown is always what is on disk.
   *
   * `properties` and `endpoints` in an `update-workspace-environment` patch **replace** the
   * whole map (like a project `EnvironmentPatchWire`): removing a key is sending the map
   * without it. Removing the active environment clears `activeEnvironmentId` — an id pointing
   * at an environment that no longer exists would silently resolve to "no environment" on the
   * next send, which is the same outcome said out loud.
   *
   * @returns the fresh snapshot, plus the id of the environment an `add-workspace-environment`
   * created (the UI has to select and focus it).
   * @throws WorkspaceError `workspace-not-found` when none is open, `environment-not-found`
   * when a change names an environment this workspace does not have.
   */
  async mutate(change: WorkspaceChange): Promise<{ workspace: WorkspaceWire; createdEnvironmentId?: string }> {
    const open = this.requireOpen();
    let createdEnvironmentId: string | undefined;

    switch (change.kind) {
      case 'rename-workspace':
        open.workspace = { ...open.workspace, name: change.name };
        break;
      case 'set-workspace-property':
        open.workspace = {
          ...open.workspace,
          properties: { ...open.workspace.properties, [change.name]: change.value },
        };
        break;
      case 'remove-workspace-property': {
        const properties = { ...open.workspace.properties };
        delete properties[change.name];
        open.workspace = { ...open.workspace, properties };
        break;
      }
      case 'add-workspace-environment': {
        const environment = createWorkspaceEnvironment(
          change.name,
          new Set(open.workspace.environments.map((candidate) => candidate.slug)),
        );
        createdEnvironmentId = environment.id;
        open.workspace = { ...open.workspace, environments: [...open.workspace.environments, environment] };
        break;
      }
      case 'update-workspace-environment': {
        const existing = requireEnvironment(open.workspace, change.environmentId);
        const updated: WorkspaceEnvironment = {
          ...existing,
          ...(change.patch.name !== undefined ? { name: change.patch.name } : {}),
          ...(change.patch.properties !== undefined ? { properties: { ...change.patch.properties } } : {}),
          ...(change.patch.endpoints !== undefined ? { endpoints: { ...change.patch.endpoints } } : {}),
        };
        open.workspace = {
          ...open.workspace,
          environments: open.workspace.environments.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        };
        break;
      }
      case 'remove-workspace-environment': {
        requireEnvironment(open.workspace, change.environmentId);
        const environments = open.workspace.environments.filter((candidate) => candidate.id !== change.environmentId);
        const base =
          open.workspace.activeEnvironmentId === change.environmentId
            ? withoutActiveEnvironment(open.workspace)
            : open.workspace;
        open.workspace = { ...base, environments };
        break;
      }
    }

    await saveWorkspace(open.workspace, open.dir, this.fsOption());
    this.deps.hooks?.onChanged?.(this.snapshot());
    return {
      workspace: this.requireSnapshot(),
      ...(createdEnvironmentId !== undefined ? { createdEnvironmentId } : {}),
    };
  }

  /**
   * Switches the workspace's active environment, or clears it with `null`. Every open host
   * resolves its endpoints and `${#Env#…}` properties through the workspace, so this is the one
   * switch behind the status bar's `● dev ▾`.
   *
   * @throws WorkspaceError `environment-not-found` when `environmentId` names no environment of
   * this workspace — an id the renderer could only have made up, and silently ignoring it would
   * leave the UI showing an environment that is not applied.
   */
  async setActiveEnvironment(environmentId: string | null): Promise<WorkspaceWire> {
    const open = this.requireOpen();
    if (environmentId === null) {
      open.workspace = withoutActiveEnvironment(open.workspace);
    } else {
      requireEnvironment(open.workspace, environmentId);
      open.workspace = { ...open.workspace, activeEnvironmentId: environmentId };
    }
    await saveWorkspace(open.workspace, open.dir, this.fsOption());
    this.deps.hooks?.onChanged?.(this.snapshot());
    return this.requireSnapshot();
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
  projectMutate(
    ...[projectId, change]: Parameters<ProjectRouter['projectMutate']>
  ): ReturnType<ProjectRouter['projectMutate']> {
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
  addInterface(
    ...[projectId, input]: Parameters<ProjectRouter['addInterface']>
  ): ReturnType<ProjectRouter['addInterface']> {
    return this.hostFor(projectId).addInterface(input);
  }

  /** @inheritdoc */
  reload(...[projectId]: Parameters<ProjectRouter['reload']>): ReturnType<ProjectRouter['reload']> {
    return this.hostFor(projectId).reload();
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

/**
 * The project folders named by a pre-workspace `recent-projects.json`, most recent first and
 * limited to folders that still exist.
 *
 * Deliberately its own two-field reader rather than the `RecentProjects` class: the picker only
 * wants "here are folders you used to open, link one if you like", and reading the file through
 * the class would re-establish a dependency on a list nothing else in the workspace world
 * keeps up to date. The file is never written here, and a missing or corrupt one yields none.
 */
export async function readLeftoverProjectFolders(userDataDir: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(join(userDataDir, 'recent-projects.json'), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const shape = z.object({ entries: z.array(z.object({ dir: z.string() })) });
  const result = shape.safeParse(parsed);
  if (!result.success) {
    return [];
  }
  return result.data.entries.map((entry) => entry.dir).filter((dir) => existsSync(dir));
}

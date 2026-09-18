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
import { mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import {
  assertPathSegment,
  createProject,
  createWorkspace,
  createWorkspaceEnvironment,
  DEFAULT_GIT_SHARE_SETTINGS,
  EMPTY_LOCAL_STATE,
  loadLocalState,
  loadProject,
  loadWorkspace,
  ProjectError,
  reidentifyProject,
  saveLocalState,
  saveProject,
  saveShare,
  saveWorkspace,
  uniqueSlug,
  WirebenchError,
  WorkspaceError,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_JOINING_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACE_SHARE_FILE,
  WORKSPACES_DIR,
  workspaceDir,
  workspaceManifestFile,
  workspaceProjectDir,
} from '@wirebench/engine';
import type {
  FsLike,
  GitShareSettings,
  Project,
  SaveResult,
  TlsOptions,
  Workspace,
  WorkspaceEnvironment,
  WorkspaceProjectRef,
  WorkspaceShare,
} from '@wirebench/engine';
import type { WebContents } from 'electron';
import type { RecordsReadPicks, RecordsWritePicks, ReadPicks } from './dialog-picks.js';
import { pickFolder, pickFolderToWrite } from './native-dialogs.js';
import type { EngineService } from './engine-service.js';
import type { GlobalProperties } from './global-properties.js';
import type { HistoryService } from './history-service.js';
import type { PreferencesService } from './preferences.js';
import { isWorkspaceManagedPath, ProjectWatcher } from './project-watch.js';
import { ProjectHost } from './project-host.js';
import type { ProjectRouter } from './project-router.js';
import type { SecretStore } from './secrets.js';
import { createSyncBackend } from './sync/create-backend.js';
import { assertBranchName, assertRemoteUrl } from './sync/git-cli.js';
import type { GitCli } from './sync/git-cli.js';
import { HeldChanges } from './sync/held-changes.js';
import type { HeldBatch } from './sync/held-changes.js';
import { fillConflictProjectIds, planPull } from './sync/pull-plan.js';
import { SyncService } from './sync/sync-service.js';
import type { SyncConflictWire, SyncPulledEvent, SyncStatusWire } from './sync/types.js';
import {
  copyProjectPayload,
  errorMessage,
  isEmptyDir,
  requireAbsolute,
  requireWorkspaceId,
  resolveWorkspaceTree,
} from './workspace-files.js';
import {
  copyProjectIntoWorkspace,
  joinFromFolder,
  joinRemote,
  keepLegacyActiveEnvironment,
  nodeFileOps,
  shareAsGit,
  shareToFolder,
  stopSharing,
} from './workspace-share.js';
import type { ShareDeps, WorkspaceDialogs, WorkspaceFileOps } from './workspace-share.js';
import { WorkspaceState } from './workspace-state.js';
import { recordToFiles, UnsavedStore } from './unsaved-store.js';
import type {
  EngineProgressEvent,
  ProjectWire,
  SyncSettingsPatchWire,
  WorkspaceChange,
  WorkspaceEnvironmentWire,
  WorkspaceProjectWire,
  WorkspaceShareWire,
  WorkspaceSummaryWire,
  WorkspaceWire,
} from '../shared/wire-types.js';
import type {
  GrpcRequestPatchWire,
  HydrationStatus,
  RequestPatchWire,
  RestRequestPatchWire,
  UnsavedRestoreNoticeWire,
  WorkspaceRestoredResponse,
} from '../shared/wire-types.js';

/**
 * How long after a change a project's unsaved-changes record is rewritten. Short enough that a
 * crash costs only the last moment of work, long enough that typing does not write per keystroke.
 */
export const UNSAVED_RECORD_DEBOUNCE_MS = 2_000;

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
  /**
   * The workspace-level reload triggered by an outside edit to `workspace.yaml` or
   * `environments/*.yaml` failed to load (most often unparsable YAML mid-write); the in-memory
   * model was left untouched. `paths` is the batch that triggered the attempt.
   */
  readonly onWorkspaceChangedOnDisk?: (workspaceId: string, paths: readonly string[], message: string) => void;
  /** One interface of one project finished (or failed) re-importing. */
  readonly onHydration?: (
    projectId: string,
    event: { interfaceId: string; status: HydrationStatus; message?: string },
  ) => void;
  /** Import progress, forwarded from whichever host raised it. */
  readonly onProgress?: (event: EngineProgressEvent) => void;
  /** The open shared workspace's sync status changed (including `syncing` while an operation runs). */
  readonly onSyncStatus?: (workspaceId: string, status: SyncStatusWire) => void;
  /** A pull (or a finished merge) was applied: clean hosts reloaded, dirty ones told their files changed. */
  readonly onSyncPulled?: (event: SyncPulledEvent) => void;
  /** A merge stopped on conflicts; each conflict's `projectId` is filled from its `projects/<slug>/` path. */
  readonly onSyncConflict?: (workspaceId: string, conflicts: readonly SyncConflictWire[]) => void;
  /** A commit needs a name and email first; `sync().setIdentity` retries it. */
  readonly onGitIdentityNeeded?: (workspaceId: string) => void;
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
  /**
   * Debounce for the workspace-level watcher (see the "workspace-level watcher" region below).
   * Test-only; defaults to {@link DEFAULT_DEBOUNCE_MS}.
   */
  readonly watchDebounceMs?: number;
  /**
   * Finds git for a shared workspace, located afresh on every open; resolving `undefined` means no
   * git is available (a git share then opens with a `git-not-found` status instead of syncing).
   * Omitted in tests that never open a shared workspace.
   */
  readonly git?: () => Promise<GitCli | undefined>;
  /** The empty `core.hooksPath` directory every `GitCli` is built with (clones and inits need it). */
  readonly hooksDir?: string;
  /** The folder pickers share and join run; the native ones unless a test injects its own. */
  readonly dialogs?: WorkspaceDialogs;
  /** rename/cp/rm for moving a tree between folders; `node:fs` unless a test injects its own. */
  readonly files?: WorkspaceFileOps;
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
  /** The app-data directory: `<userData>/workspaces/<id>`. Never the tree — see `tree`. */
  readonly dir: string;
  /** Where the shared files (`workspace.yaml`, `environments/`, `projects/`) actually live:
   * `dir` itself for a local workspace, or wherever `share` points once sharing exists. */
  readonly tree: string;
  /**
   * `undefined` for a local workspace (tree === dir); set once `share.yaml` exists. Mutable:
   * `updateSyncSettings` patches its `.git` settings in place after persisting them.
   */
  share: WorkspaceShare | undefined;
  readonly entries: OpenProjectEntry[];
  /**
   * Watches `tree` for `workspace.yaml`/`environments/*.yaml` edits made outside the app.
   * `undefined` only for the brief window in `open()` before hosts have finished coming up (see
   * the "workspace-level watcher" region).
   */
  watcher: ProjectWatcher | undefined;
  /**
   * Set as the very first statement of `close()`, before anything else — including before
   * `this.current` is nulled — so an in-flight {@link reloadWorkspaceFromDisk} (which cannot
   * detect closing purely from `this.current`, since that stays `open` throughout `close()`'s own
   * entry-closing loop) has a signal it can check between its own awaits.
   */
  closing: boolean;
  /** Drives the share's backend; `undefined` for a local workspace and until `startSync` has built it. */
  sync: SyncService | undefined;
  /** Outside-edit notifications held while sync runs an operation or sits in a conflict (see the sync region). */
  readonly held: HeldChanges;
  /** Settles once `startSync` has built and started the sync service (at once for a local workspace). Never rejects. */
  syncReady: Promise<void>;
}

/**
 * Refuses a project id that cannot safely be used as a single path segment.
 *
 * A project's id is its own `wirebench.yaml`'s, and a *linked* project keeps that id by design
 * (only import re-identifies). The folder may have been authored anywhere — "a colleague sent
 * me a project" is a first-class flow — so an id such as `../../tmp/x` would escape every
 * `<userData>/<dir>/<id>` path built from it, starting with the project's history file. The
 * rule is the engine's own {@link assertPathSegment}, re-thrown under a code the workspace
 * layer owns so the project becomes an `error` row instead of taking the workspace down.
 *
 * @throws WorkspaceError `project-id-invalid` when `id` is not a safe path segment.
 */
function assertSafeProjectId(id: string): void {
  try {
    assertPathSegment(id);
  } catch {
    throw new WorkspaceError('project-id-invalid', `"${id}" is not a usable project id.`, {
      details: { projectId: id },
    });
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
    const { project } = await loadProject(dir);
    assertSafeProjectId(project.id);
    return project;
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

/**
 * Whether two references still name the same project *placement* — same slug, same source, and
 * (for a linked ref) the same folder. Used only by the workspace-level reload: a ref whose id
 * survived but whose slug or path changed on disk (a rename pulled from a teammate) has to be
 * released and reopened at the new folder, not left pointing at the old one.
 */
function refsEqual(a: WorkspaceProjectRef, b: WorkspaceProjectRef): boolean {
  return a.slug === b.slug && a.source === b.source && a.path === b.path;
}

/**
 * Every tree-relative path a write of `workspaces` might touch: `workspace.yaml` plus one
 * `environments/<slug>.yaml` per environment across every model given (typically the workspace
 * before and after the in-memory edit) — a conservative superset, not an exact diff. Passed to
 * `watcher.expect()` *before* `saveWorkspace` runs (not just after, with the actual written/
 * removed lists), because `saveWorkspace` performs several separately-awaited atomic renames,
 * each visible to `fs.watch` the moment it happens — a path only marked self-write once the
 * whole call resolves can already have been queued by the watcher as an outside edit.
 */
function candidateWorkspacePaths(...workspaces: readonly Workspace[]): string[] {
  const paths = new Set<string>([WORKSPACE_MANIFEST]);
  for (const workspace of workspaces) {
    for (const environment of workspace.environments) {
      paths.add(`${WORKSPACE_ENVIRONMENTS_DIR}/${environment.slug}.yaml`);
    }
  }
  return [...paths];
}

/**
 * Saves `workspace` into `tree`, pre-announcing `candidates` (see {@link candidateWorkspacePaths})
 * on `watcher` beforehand — `saveWorkspace`'s several atomic renames are each individually
 * visible to `fs.watch` before this call returns, so a path only marked self-write afterwards can
 * already have been queued by the watcher as an outside edit — and releasing that announcement
 * once the write settles, successfully or not (`finally`, so a failed save still releases). Paths
 * the write actually touched (`result.written ∪ result.removed`) are kept marked self-write;
 * every other announced candidate is restored to whatever it was before this call, and a genuine
 * outside edit to one of them made during the write's own window is re-delivered rather than
 * suppressed for the rest of `selfWriteTtlMs` — see {@link ProjectWatcher.announce}/`release`.
 */
async function saveWorkspaceAnnounced(
  watcher: ProjectWatcher | undefined,
  workspace: Workspace,
  tree: string,
  candidates: readonly string[],
  options?: { fs: FsLike },
): Promise<SaveResult> {
  const token = watcher?.announce(candidates);
  let result: SaveResult | undefined;
  try {
    result = await saveWorkspace(workspace, tree, options);
    return result;
  } finally {
    // Runs whether the save succeeded or threw: a failed write must not leave every candidate
    // suppressed for the rest of `selfWriteTtlMs` — `release()` with nothing in `keep` restores
    // each announced path to whatever it was before this call ever announced it.
    if (token !== undefined) {
      watcher?.release(token, result !== undefined ? [...result.written, ...result.removed] : []);
    }
  }
}

/** `workspace` with no active environment — the field dropped, not set to `undefined`. */
function withoutActiveEnvironment(workspace: Workspace): Workspace {
  const copy: Omit<Workspace, 'activeEnvironmentId'> & { activeEnvironmentId?: string } = { ...workspace };
  delete copy.activeEnvironmentId;
  return copy;
}

/**
 * `WorkspaceWire.share`/`WorkspaceSummaryWire.share` from `resolveTree`'s result. `managed` is
 * true when the tree lives inside app data — a git share never sets `share.path` (its tree is
 * the managed `<dir>/tree` clone); a folder share always does (an external, user-picked folder).
 */
function shareWire(share: WorkspaceShare | undefined): WorkspaceShareWire | undefined {
  if (share === undefined) {
    return undefined;
  }
  return {
    kind: share.kind,
    managed: share.path === undefined,
    ...(share.git?.remote !== undefined ? { remote: share.git.remote } : {}),
    ...(share.git?.branch !== undefined ? { branch: share.git.branch } : {}),
    ...(share.git !== undefined
      ? {
          autoFetchSeconds: share.git.autoFetchSeconds,
          commitOnSave: share.git.commitOnSave,
          pushOnSave: share.git.pushOnSave,
        }
      : {}),
  };
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
  /** The open workspace's recovery records; `undefined` while none is open. */
  private unsaved: UnsavedStore | undefined;
  /** Pending debounced record writes, by manifest project id. */
  private readonly unsavedTimers = new Map<string, NodeJS.Timeout>();
  /** The renderer's staged request edits for the open workspace, as last stashed. */
  private drafts: Record<string, RequestPatchWire> = {};
  /** The REST editor's unsaved edits, kept beside {@link drafts} for the same reason. */
  private restDrafts: Record<string, RestRequestPatchWire> = {};
  /** The gRPC editor's unsaved edits, the third of the same set. */
  private grpcDrafts: Record<string, GrpcRequestPatchWire> = {};
  /** What the last open restored, until the renderer takes it. */
  private restored: WorkspaceRestoredResponse | undefined;
  /** Resolvers waiting for the renderer's next `stashDrafts` (the quit flush). */
  private stashWaiters: (() => void)[] = [];
  /**
   * Serialises every operation that reads or replaces `open.workspace`/`open.entries`: a
   * workspace-level reload (the watcher) and every method that mutates the open workspace in
   * place — `addProject`, `removeProject`, `linkProject`, `importProjectFolder`,
   * `importKnownProjectFolder`, `locateProject`, `mutate`, `setActiveEnvironment`, and the
   * open-workspace branch of `rename` — all go through {@link enqueueWorkspaceOp}, so two of them
   * can never interleave. `mutate`/`setActiveEnvironment` used to run outside this chain on the
   * theory that they never touch `entries`; that missed that a watcher-driven reload replaces
   * `open.workspace` *wholesale* and can land between two such calls, silently reverting one of
   * them. `close()` still never awaits this chain — see `open.closing`
   * and {@link stale} — and resets it, so a closed workspace's still-pending op cannot delay (or
   * reach into) the next one opened.
   */
  private workspaceOps: Promise<void> = Promise.resolve();
  /** Launch-time removal of `<workspaces>/.joining/` (clones a crash left half-made); join waits for it. */
  private readonly startup: Promise<void>;

  constructor(private readonly deps: WorkspaceServiceDeps) {
    this.state = new WorkspaceState(deps.userDataDir);
    this.now = deps.now ?? ((): Date => new Date());
    this.startup = this.clearJoining();
  }

  /** Empties `.joining/` once per service; a failure is kept for {@link lastError}, never thrown. */
  private async clearJoining(): Promise<void> {
    try {
      await (this.deps.files ?? nodeFileOps).rm(join(this.deps.userDataDir, WORKSPACES_DIR, WORKSPACE_JOINING_DIR), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      this.failure = errorMessage(error);
    }
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
      const hasManifest = existsSync(workspaceManifestFile(dir));
      const hasShare = existsSync(join(dir, WORKSPACE_SHARE_FILE));
      if (!hasManifest && !hasShare) {
        continue;
      }
      const stamp = lastOpenedAt[name];
      try {
        const { share, tree } = await this.resolveTree(dir);
        const { workspace } = await loadWorkspace(tree, this.fsOption());
        rows.push({
          id: workspace.id,
          name: workspace.name,
          dir,
          projectCount: workspace.projects.length,
          internalProjectCount: workspace.projects.filter((ref) => ref.source === 'internal').length,
          createdAt: workspace.createdAt,
          ...(stamp !== undefined ? { lastOpenedAt: stamp } : {}),
          ...(shareWire(share) !== undefined ? { share: shareWire(share) } : {}),
        });
      } catch {
        rows.push({
          id: name,
          name,
          dir,
          projectCount: 0,
          internalProjectCount: 0,
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

  /** `dir`'s `share.yaml` (or `undefined` for a local workspace) and the tree root it points at. */
  private async resolveTree(dir: string): Promise<{ share: WorkspaceShare | undefined; tree: string }> {
    return await resolveWorkspaceTree(dir, this.fsOption());
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
    return await this.openWorkspace(id, {});
  }

  /**
   * {@link open}, plus an `initialCommitMessage` a new git share commits its tree under before
   * sync's own start-up commit could take it with a generated message.
   */
  private async openWorkspace(id: string, options: { readonly initialCommitMessage?: string }): Promise<WorkspaceWire> {
    await this.close();
    const dir = workspaceDir(this.deps.userDataDir, requireWorkspaceId(id));
    const { share, tree } = await this.resolveTree(dir);
    const { workspace: loaded, legacy } = await loadWorkspace(tree, this.fsOption());
    // A workspace whose manifest is still v1/v2 carries a stale activeEnvironmentId that
    // `loadWorkspace` already stripped from the in-memory model (into `legacy`, not the
    // manifest) but has not yet stripped from disk. `local.yaml` cannot represent "the user
    // explicitly cleared it" separately from "nothing has ever been set here" — both read back
    // as `EMPTY_LOCAL_STATE` — so leaving the stale manifest key around would let it resurrect a
    // value the user cleared on a later open, once local.yaml goes missing again (e.g. after a
    // `setActiveEnvironment(null)`). The fix is to finish the migration right here: adopt the
    // legacy value into local.yaml only when there is not already one and it still names a real
    // environment, then immediately resave the manifest at v3 so the stale key never lingers on
    // disk past this open, regardless of whether it was adopted.
    let local = await loadLocalState(dir, this.fsOption());
    if (legacy.activeEnvironmentId !== undefined) {
      if (
        local.activeEnvironmentId === undefined &&
        loaded.environments.some((environment) => environment.id === legacy.activeEnvironmentId)
      ) {
        local = { version: 1, activeEnvironmentId: legacy.activeEnvironmentId };
        await saveLocalState(dir, local, this.fsOption());
      }
      // No `watcher.expect()` needed here: the workspace-level watcher below is not created
      // until every project host has come up, and this re-save runs well before that.
      await saveWorkspace(loaded, tree, this.fsOption());
    }
    // Only ever applied when it still names a real environment — a deleted one, or one from a
    // workspace local.yaml was copied from by hand, must not resurrect a dangling pointer.
    const activeEnvironmentId =
      local.activeEnvironmentId !== undefined &&
      loaded.environments.some((environment) => environment.id === local.activeEnvironmentId)
        ? local.activeEnvironmentId
        : undefined;
    const workspace: Workspace = activeEnvironmentId !== undefined ? { ...loaded, activeEnvironmentId } : loaded;
    const open: OpenWorkspace = {
      workspace,
      dir,
      tree,
      share,
      entries: [],
      watcher: undefined,
      closing: false,
      sync: undefined,
      held: new HeldChanges(),
      syncReady: Promise.resolve(),
    };
    this.current = open;
    this.failure = undefined;
    this.unsaved = new UnsavedStore(dir);
    this.drafts = {};
    this.restDrafts = {};
    this.grpcDrafts = {};
    this.restored = undefined;
    const notices: UnsavedRestoreNoticeWire[] = [];

    // Past this point the service holds hosts, history files and a `current` — so anything that
    // still throws has to put it back at the picker rather than leave it half-open.
    try {
      for (const ref of workspace.projects) {
        await this.addEntryForRef(open, ref, notices);
      }

      // Only once every host from the manifest has had its chance to come up: an event the
      // watcher reports before this point would race a half-built `entries` array (see the
      // "workspace-level watcher" region below).
      open.watcher = new ProjectWatcher({
        dir: tree,
        isManaged: isWorkspaceManagedPath,
        ...(this.deps.watchDebounceMs !== undefined ? { debounceMs: this.deps.watchDebounceMs } : {}),
        onChange: (paths) => {
          if (open.held.offerWorkspace(paths)) {
            return;
          }
          void this.enqueueWorkspaceOp(() => this.reloadWorkspaceFromDisk(open, paths));
        },
      });
      open.watcher.start();

      // Kept as the workspace's drafts until the renderer stashes its own, so a close before the
      // renderer has taken them still carries them forward.
      const stashed = await this.unsaved.readDrafts();
      this.drafts = stashed.requests;
      this.restDrafts = stashed.restRequests;
      this.grpcDrafts = stashed.grpcRequests;
      this.restored = {
        workspaceId: workspace.id,
        drafts: { ...this.drafts },
        restDrafts: { ...this.restDrafts },
        grpcDrafts: { ...this.grpcDrafts },
        notices,
      };

      await this.state.remember(id, this.now().toISOString());
      this.deps.hooks?.onChanged?.(this.snapshot());
      // Never awaited: a shared workspace opens on its files alone, and git (a missing
      // executable, a slow remote) only ever shows up in the sync status.
      open.syncReady = this.startSync(open, options.initialCommitMessage).catch(() => undefined);
      return this.requireSnapshot();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Resolves `ref`'s folder, appends its entry and brings up its host — the shared shape between
   * the initial scan in {@link open} and the workspace-level reload below, so a ref added either
   * way ends up open the same way.
   */
  private async addEntryForRef(
    open: OpenWorkspace,
    ref: WorkspaceProjectRef,
    notices?: UnsavedRestoreNoticeWire[],
  ): Promise<void> {
    if (open.share !== undefined && ref.source === 'linked') {
      // A shared workspace.yaml (hand-edited, or pulled from a teammate) naming a folder outside
      // the tree: never opened, watched or written — only shown as a row that will not open.
      const refused = new WirebenchError(
        'share-linked-project-refused',
        'Shared workspaces hold their projects inside the workspace; this linked project folder is not opened here.',
        { details: { workspaceId: open.workspace.id } },
      );
      open.entries.push({
        ref,
        dir: ref.path ?? '',
        host: undefined,
        projectId: ref.id,
        status: 'error',
        message: refused.message,
      });
      return;
    }
    let projectDir: string;
    try {
      projectDir =
        ref.source === 'internal' ? workspaceProjectDir(open.tree, ref.slug) : requireAbsolute(ref.path, ref.slug);
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
      return;
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
    await this.openEntry(entry, notices);
  }

  /** Brings up one project's host, recording the outcome on `entry` rather than throwing. */
  private async openEntry(entry: OpenProjectEntry, notices?: UnsavedRestoreNoticeWire[]): Promise<void> {
    try {
      // The manifest's recorded id, before anything is opened: a workspace linked by an older
      // build (or a manifest edited by hand) can already hold an unusable one.
      assertSafeProjectId(entry.ref.id);
    } catch (error) {
      entry.status = 'error';
      entry.message = errorMessage(error);
      return;
    }
    if (!existsSync(entry.dir)) {
      entry.status = 'missing';
      entry.message = `The project folder is gone: ${entry.dir}`;
      return;
    }
    // `project.changed` is what the renderer's history view reloads on, so it is not forwarded
    // until the project's history file is attached: the host's own first change (raised from
    // inside `openProject`) is held and replayed — latest snapshot only — once it is.
    let announced = false;
    let held: { project: ProjectWire | null } | undefined;
    const host = new ProjectHost(
      this.deps.engine,
      {
        onChanged: (project) => {
          if (project !== null) {
            entry.projectId = project.id;
          }
          // The index is the routing table for every `ipc/*` channel, so it is rebuilt from the
          // hosts' own snapshots on *every* change — an import, a rename or a removal all add
          // or drop entity ids, and a stale table would route a request to the wrong project.
          this.reindex();
          // Only once the host is adopted: its first change (the open itself) is not an edit, and
          // must not delete the record this open is still restoring from.
          if (entry.host !== undefined) {
            this.noteUnsaved(entry, project);
          }
          if (!announced) {
            held = { project };
            return;
          }
          this.deps.hooks?.onProjectChanged?.(entry.projectId, project);
        },
        onChangedOnDisk: (paths) => {
          if (this.current?.held.offerProject(entry.projectId, paths) === true) {
            return;
          }
          this.deps.hooks?.onProjectChangedOnDisk?.(entry.projectId, paths);
        },
        onSaved: (event) => {
          this.current?.sync?.afterSave(event.reason === 'autosave' ? 'autosave' : 'manual');
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
      const record = await this.unsaved?.readProject(entry.ref.id);
      const project = await host.openProject(
        entry.dir,
        record !== undefined
          ? { unsaved: { baseline: recordToFiles(record.baseline), unsaved: recordToFiles(record.unsaved) } }
          : {},
      );
      // The id the *folder* declares, which for a linked project is not necessarily the one the
      // manifest recorded — and which is what every `<userData>` path is built from.
      assertSafeProjectId(project.id);
      entry.host = host;
      entry.projectId = project.id;
      entry.status = 'ready';
      entry.message = undefined;
      this.reindex();
      if (record !== undefined) {
        this.settleRestore(entry, host, notices);
      }
      // History has to be open before anything can record a send against this project — and
      // before the project is announced (see `announced` above).
      await this.deps.history.open(project.id);
      announced = true;
      if (held !== undefined) {
        this.deps.hooks?.onProjectChanged?.(entry.projectId, held.project);
        held = undefined;
      }
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
    // Set before anything else, together with stopping the watcher: `this.current` stays `open`
    // for the rest of this method (it is nulled further down, after the entries loop below), so
    // an in-flight `reloadWorkspaceFromDisk` cannot tell "closing" from "still open" by looking
    // at `this.current` alone — `closing` is the signal it checks instead.
    open.closing = true;
    open.watcher?.stop();
    // Same first step: no timer fetch or debounced save commit may start while this closes, and
    // nothing held for a conflict is replayed into a closing workspace.
    open.sync?.stop();
    open.held.clear();
    try {
      // Nothing is written to a project on close: unsaved changes stay unsaved and come back
      // the next time this workspace opens (see `unsaved-store.ts`).
      await this.keepUnsaved(open);
    } catch (error) {
      // A failed record write must not strand the app with a half-closed workspace; the message
      // is kept so the caller (or the picker) can surface it.
      this.failure = errorMessage(error);
    }
    // A snapshot: an in-flight `releaseEntry` splicing the live array must not make this skip one.
    for (const entry of [...open.entries]) {
      await entry.host?.close({ keepUnsaved: true }).catch(() => undefined);
    }
    this.unsaved = undefined;
    this.drafts = {};
    this.restDrafts = {};
    this.grpcDrafts = {};
    this.restored = undefined;
    this.deps.history.closeAll();
    this.index.clear();
    this.current = undefined;
    // A pending reload (or a project-set mutation) still queued behind `workspaceOps` must not
    // delay — or, worse, reach into — whatever opens next; each already re-checks `this.current`
    // against its own captured `open` and will no-op once it runs, but there is no reason to make
    // the next workspace's first queued op wait behind it.
    this.workspaceOps = Promise.resolve();
    this.deps.hooks?.onChanged?.(null);
    return null;
  }

  // ——— workspace-level watcher ————————————————————————————————————————————————————————————
  //
  // `open.watcher` watches the tree root for edits made outside the app — a `git pull`, a sync
  // client, a hand edit — to `workspace.yaml` or `environments/*.yaml` (see
  // `isWorkspaceManagedPath`; everything under `projects/**` is filtered out even though a
  // recursive watch on the tree root also sees those events). Every workspace-level mutation
  // here saves immediately, so there is no "dirty workspace" state to protect: a reload always
  // replaces the model, unlike a project's watcher-driven prompt.

  /**
   * Runs `op` after every previously enqueued workspace operation has settled (successfully or
   * not), so a workspace-level reload and every method that reads or replaces
   * `open.workspace`/`open.entries` (`addProject`, `removeProject`, `linkProject`,
   * `importProjectFolder`, `importKnownProjectFolder`, `locateProject`, `mutate`,
   * `setActiveEnvironment`, the open-workspace branch of `rename`) can never interleave. `op`'s
   * rejection propagates to *this* call's caller — it does not break the chain for whatever is
   * enqueued next.
   */
  private enqueueWorkspaceOp<T>(op: () => Promise<T>): Promise<T> {
    const result = this.workspaceOps.then(op, op);
    this.workspaceOps = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Reloads the manifest and environments after {@link OpenWorkspace.watcher} reports a change.
   * Never calls `saveManifest` (the change already happened on disk) and never trashes anything,
   * however large the diff — this only ever mirrors disk into memory.
   *
   * A load failure (most often unparsable YAML caught mid-write) leaves `open.workspace`
   * untouched and is reported through `onWorkspaceChangedOnDisk` instead of `onChanged`.
   */
  private async reloadWorkspaceFromDisk(open: OpenWorkspace, paths: readonly string[]): Promise<void> {
    // Re-checked after every `await` below (not just here): `enqueueWorkspaceOp` only keeps this
    // from interleaving with another *queued* op, but `close()` is deliberately *not* queued (a
    // shutdown must not wait behind a stuck reload), so the workspace can still close mid-reload.
    // `this.current !== open` alone would miss that window: `close()` leaves `this.current` set
    // to `open` for the whole of its own entry-closing loop, only nulling it afterwards — so
    // `open.closing` (set as `close()`'s very first statement) is the signal actually checked.
    if (this.stale(open)) {
      return;
    }
    let loaded: Workspace;
    try {
      ({ workspace: loaded } = await loadWorkspace(open.tree, this.fsOption()));
    } catch (error) {
      if (!this.stale(open)) {
        this.deps.hooks?.onWorkspaceChangedOnDisk?.(open.workspace.id, paths, errorMessage(error));
      }
      return;
    }
    if (this.stale(open)) {
      return;
    }

    // The active environment is machine-local (see `local-state.ts`) and never touched by this
    // reload — carried forward from the in-memory model, dropped only if the environment it
    // named is gone from the reloaded one.
    const activeEnvironmentId =
      open.workspace.activeEnvironmentId !== undefined &&
      loaded.environments.some((environment) => environment.id === open.workspace.activeEnvironmentId)
        ? open.workspace.activeEnvironmentId
        : undefined;
    open.workspace = activeEnvironmentId !== undefined ? { ...loaded, activeEnvironmentId } : loaded;

    // Re-derive the project entries: a ref gone from the reloaded manifest (or one whose slug or
    // path changed — a rename pulled from a teammate) is released; anything new is opened. A
    // relocation's release keeps the unsaved-changes record (`discardUnsaved: false`) — the same
    // id is about to be re-added by `addEntryForRef` below, and `openEntry` restores from it; only
    // a ref genuinely gone from the manifest (`nextRef === undefined`) has that record discarded.
    const nextRefs = new Map(loaded.projects.map((ref) => [ref.id, ref] as const));
    for (const entry of [...open.entries]) {
      if (this.stale(open)) {
        return;
      }
      const nextRef = nextRefs.get(entry.ref.id);
      if (nextRef === undefined || !refsEqual(nextRef, entry.ref)) {
        await this.releaseEntry(open, entry, { discardUnsaved: nextRef === undefined });
      }
    }
    for (const ref of loaded.projects) {
      if (this.stale(open)) {
        return;
      }
      if (!open.entries.some((entry) => entry.ref.id === ref.id)) {
        await this.addEntryForRef(open, ref);
        if (open.closing) {
          // `close()`'s own entry-closing loop started before this entry existed (it was pushed
          // by `addEntryForRef` mid-await), so nothing else is going to stop this host or it
          // would outlive the workspace it belongs to.
          const added = open.entries.find((candidate) => candidate.ref.id === ref.id);
          await added?.host?.close({ keepUnsaved: true }).catch(() => undefined);
          return;
        }
      }
    }
    if (this.stale(open)) {
      return;
    }
    this.reindex();
    this.deps.hooks?.onChanged?.(this.snapshot());
  }

  /** Whether `open` is no longer the live workspace to keep reloading — closed, replaced, or in
   * the middle of closing (see {@link OpenWorkspace.closing}). */
  private stale(open: OpenWorkspace): boolean {
    return this.current !== open || open.closing;
  }

  /**
   * Throws the same error `requireOpen()` throws, once `open` has gone {@link stale} — used
   * inside a queued op after an `await`, when the workspace it captured at the start may have
   * closed (or been replaced) while the op's write was in flight.
   *
   * @throws WorkspaceError `workspace-not-found`.
   */
  private requireStillOpen(open: OpenWorkspace): void {
    if (this.stale(open)) {
      throw new WorkspaceError('workspace-not-found', 'No workspace is open.');
    }
  }

  /**
   * Closes one entry's host and releases its history file, and — unless `discardUnsaved` is
   * `false` — its unsaved-changes record. `removeProject` always discards (the project is truly
   * gone); the workspace-level reload's relocation case (a slug or path change with the same ref
   * id) passes `discardUnsaved: false`, because the very next step re-adds the same id and
   * `openEntry` restores from that record — deleting it here would silently drop the local user's
   * uncommitted work on a routine pulled rename.
   */
  private async releaseEntry(
    open: OpenWorkspace,
    entry: OpenProjectEntry,
    options: { discardUnsaved: boolean },
  ): Promise<void> {
    this.cancelUnsavedWrite(entry.ref.id);
    await entry.host?.close({ keepUnsaved: true }).catch(() => undefined);
    if (options.discardUnsaved) {
      await this.unsaved?.deleteProject(entry.ref.id).catch(() => undefined);
    }
    this.deps.history.close(entry.projectId);
    const index = open.entries.indexOf(entry);
    if (index !== -1) {
      open.entries.splice(index, 1);
    }
  }

  // ——— sync ———————————————————————————————————————————————————————————————————————————————
  //
  // A shared workspace (one with `share.yaml`) gets a `SyncService` once `open()` has returned.
  // Pulls are applied inside the workspace operation chain, pre-announcing their own writes to
  // both watchers. While sync runs an operation (a merge rewrites files under the watchers) or
  // sits in a conflict, outside-edit notifications from both watchers are held in `open.held` —
  // the watchers themselves keep running — and replayed, through the chain, once it does not.
  // The pure parts live in `sync/pull-plan.ts` and `sync/held-changes.ts`.

  /** The open workspace's sync service; `undefined` for a local workspace, or until it has been built. */
  sync(): SyncService | undefined {
    return this.current?.sync;
  }

  /**
   * `sync.status` for the open workspace. A shared workspace answers through its `SyncService`;
   * a local one answers with a synthetic status instead of throwing, so the badge never needs a
   * special case for "not shared". `gitAvailable` has no cheap cache to read for a local
   * workspace (nothing has probed git yet), so it defaults to `true` — `git.detect` is the
   * source of truth once the user actually shares.
   *
   * @throws WorkspaceError `workspace-not-found` when no workspace is open.
   */
  syncStatus(): SyncStatusWire {
    const sync = this.requireOpen().sync;
    if (sync !== undefined) {
      return sync.status();
    }
    return { kind: 'local', gitAvailable: true, state: 'clean', ahead: 0, behind: 0, uncommitted: 0 };
  }

  /** The open workspace's tree root: `sync.revealTree` joins its (tree-relative) path against this. */
  treeDir(): string {
    return this.requireOpen().tree;
  }

  /**
   * Patches the open workspace's git share settings (`branch`/`remote` validated and trimmed
   * first) and applies them to the running `SyncService` (picks up a new `autoFetchSeconds`).
   *
   * @throws WirebenchError `sync-not-supported` when the workspace is not a git share.
   */
  async updateSyncSettings(patch: SyncSettingsPatchWire): Promise<SyncStatusWire> {
    const open = this.requireOpen();
    return await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      if (open.share === undefined || open.share.kind !== 'git') {
        throw new WirebenchError('sync-not-supported', 'This workspace is not shared as a git repository.');
      }
      const current = open.share.git ?? DEFAULT_GIT_SHARE_SETTINGS;
      const next: GitShareSettings = {
        ...current,
        ...(patch.autoFetchSeconds !== undefined ? { autoFetchSeconds: patch.autoFetchSeconds } : {}),
        ...(patch.commitOnSave !== undefined ? { commitOnSave: patch.commitOnSave } : {}),
        ...(patch.pushOnSave !== undefined ? { pushOnSave: patch.pushOnSave } : {}),
        ...(patch.branch !== undefined ? { branch: assertBranchName(patch.branch) } : {}),
        ...(patch.remote !== undefined ? { remote: assertRemoteUrl(patch.remote) } : {}),
      };
      const nextShare: WorkspaceShare = { ...open.share, git: next };
      // Persisted before anything in memory changes: a failed write must leave the live
      // settings (and what a concurrent read sees) exactly as they were.
      await saveShare(open.dir, nextShare, this.fsOption());
      open.share = nextShare;
      open.sync?.applySettings();
      // The Sync panel reads persisted settings off `workspace.share`, not off the returned
      // status — without this, a settings change made from one window (or the panel itself,
      // once re-opened) would never reach `useWorkspaceStore`.
      this.deps.hooks?.onChanged?.(this.snapshot());
      return this.syncStatus();
    });
  }

  /** Builds the share's backend and starts syncing. Never throws: failures end up in the status. */
  private async startSync(open: OpenWorkspace, initialCommitMessage?: string): Promise<void> {
    const share = open.share;
    if (share === undefined) {
      return;
    }
    const settings = (): GitShareSettings => open.share?.git ?? DEFAULT_GIT_SHARE_SETTINGS;
    const backend = await createSyncBackend({ share, tree: open.tree, git: this.deps.git, settings });
    if (this.stale(open)) {
      return;
    }
    const workspaceId = open.workspace.id;
    const sync = new SyncService({
      backend,
      settings,
      onStatus: (status) => {
        this.onSyncStatus(open, status);
      },
      onPulled: (changedPaths) => this.applyPulled(open, changedPaths),
      onConflict: (conflicts) => {
        if (this.stale(open)) {
          return;
        }
        const filled = fillConflictProjectIds(conflicts, (slug) => this.entryOfSlug(open, slug)?.projectId);
        this.deps.hooks?.onSyncConflict?.(workspaceId, filled);
      },
      onIdentityNeeded: () => {
        if (!this.stale(open)) {
          this.deps.hooks?.onGitIdentityNeeded?.(workspaceId);
        }
      },
    });
    open.sync = sync;
    if (initialCommitMessage !== undefined) {
      // Queued ahead of `start()`, whose "commit what changed while closed" would otherwise take
      // the freshly shared tree under a generated message. A failure (no identity yet) is in the
      // status, and setting the identity retries this commit with this message.
      void sync.commit(initialCommitMessage).catch(() => undefined);
    }
    await sync.start();
  }

  /** Holds outside-edit delivery while sync is busy or in conflict; replays what was held once it is neither. */
  private onSyncStatus(open: OpenWorkspace, status: SyncStatusWire): void {
    if (this.stale(open)) {
      return;
    }
    const batch = open.held.setHolding(status.state === 'syncing' || status.state === 'conflict');
    this.deps.hooks?.onSyncStatus?.(open.workspace.id, status);
    if (batch !== undefined) {
      void this.enqueueWorkspaceOp(() => this.replayHeld(open, batch));
    }
  }

  private async replayHeld(open: OpenWorkspace, batch: HeldBatch): Promise<void> {
    if (this.stale(open)) {
      return;
    }
    if (batch.workspacePaths.length > 0) {
      await this.reloadWorkspaceFromDisk(open, batch.workspacePaths);
    }
    for (const [projectId, paths] of batch.projects) {
      if (this.stale(open)) {
        return;
      }
      if (open.entries.some((entry) => entry.projectId === projectId && entry.host !== undefined)) {
        this.deps.hooks?.onProjectChangedOnDisk?.(projectId, paths);
      }
    }
  }

  /**
   * Applies a pull's `changedPaths` (tree-relative): workspace-level files go through the same
   * reload as an outside edit; each changed project's host is reloaded when clean, or — when it
   * holds unsaved edits — told its files changed on disk (the existing banner). Every pulled path
   * is announced to its watcher first, so the pull's own writes are not reported back.
   */
  private applyPulled(open: OpenWorkspace, changedPaths: readonly string[]): Promise<void> {
    return this.enqueueWorkspaceOp(async () => {
      if (this.stale(open)) {
        return;
      }
      const plan = planPull(changedPaths);
      open.watcher?.expect(plan.workspacePaths);
      const byProjectId = new Map<string, readonly string[]>();
      for (const [slug, paths] of plan.projects) {
        const entry = this.entryOfSlug(open, slug);
        entry?.host?.expectOnDisk(paths);
        if (entry !== undefined) {
          byProjectId.set(entry.projectId, paths);
        }
      }
      // Events the merge produced before the announcements above were held; they are this pull.
      open.held.forget(plan.workspacePaths, byProjectId);

      const existing = new Set(open.entries);
      const workspaceChanged = plan.workspacePaths.length > 0;
      if (workspaceChanged) {
        await this.reloadWorkspaceFromDisk(open, plan.workspacePaths);
        if (this.stale(open)) {
          return;
        }
      }
      const projectIds: string[] = [];
      for (const [slug, paths] of plan.projects) {
        const entry = this.entryOfSlug(open, slug);
        if (entry === undefined) {
          continue;
        }
        projectIds.push(entry.projectId);
        // A host the reload above just opened already read the pulled files.
        if (entry.host === undefined || !existing.has(entry)) {
          continue;
        }
        if (entry.host.snapshot()?.dirty === true) {
          this.deps.hooks?.onProjectChangedOnDisk?.(entry.projectId, paths);
          continue;
        }
        try {
          await entry.host.reload();
        } catch {
          // Unloadable pulled files (a half-resolved merge, a newer format): leave the model and
          // let the user decide through the banner rather than failing the whole pull.
          this.deps.hooks?.onProjectChangedOnDisk?.(entry.projectId, paths);
        }
        if (this.stale(open)) {
          return;
        }
      }
      this.deps.hooks?.onSyncPulled?.({
        workspaceId: open.workspace.id,
        projectIds,
        workspaceChanged,
        entityCount: plan.entityCount,
      });
    });
  }

  /** The internal project entry stored under `projects/<slug>/` in the tree. */
  private entryOfSlug(open: OpenWorkspace, slug: string): OpenProjectEntry | undefined {
    return open.entries.find((entry) => entry.ref.source === 'internal' && entry.ref.slug === slug);
  }

  // ——— manifest ———————————————————————————————————————————————————————————————————————————

  /** Renames a workspace — the open one, or any other on disk — and returns the fresh list. */
  async rename(id: string, name: string): Promise<WorkspaceSummaryWire[]> {
    const open = this.current;
    if (open !== undefined && open.workspace.id === id) {
      await this.enqueueWorkspaceOp(async () => {
        // Captured (not re-fetched via `requireOpen()`) before enqueueing: this is specifically
        // "rename *this* workspace", so if it closed while queued there is nothing left to do —
        // silently, since a rename racing a close is not a user-facing failure the way `mutate`
        // failing outright would be.
        if (this.stale(open)) {
          return;
        }
        const previousWorkspace = open.workspace;
        open.workspace = { ...open.workspace, name };
        const candidates = candidateWorkspacePaths(previousWorkspace, open.workspace);
        await saveWorkspaceAnnounced(open.watcher, open.workspace, open.tree, candidates, this.fsOption());
        if (this.stale(open)) {
          return;
        }
        open.sync?.afterSave('workspace');
        this.deps.hooks?.onChanged?.(this.snapshot());
      });
    } else {
      const dir = workspaceDir(this.deps.userDataDir, requireWorkspaceId(id));
      const { tree } = await this.resolveTree(dir);
      const { workspace, legacy } = await loadWorkspace(tree, this.fsOption());
      await keepLegacyActiveEnvironment(dir, workspace, legacy, this.fsOption());
      await saveWorkspace({ ...workspace, name }, tree, this.fsOption());
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

  // ——— share, join, stop sharing, move ———————————————————————————————————————————————————
  //
  // Thin, serialised entry points over `workspace-share.ts`. Each runs inside the workspace
  // operation chain (it closes and reopens a workspace, or rewrites a project set), and nothing
  // inside the chain awaits a `SyncService` operation: those wait on reloads queued on the same
  // chain. The first commit of a git share is queued by `startSync`; its push is started here,
  // after the queued operation has resolved.

  /**
   * Shares the open local workspace as a git repository (`<dir>/tree`), optionally with a remote
   * (validated, trimmed) and a branch (default `main`). Resolves once the first commit — and,
   * with a remote, the first push — has been attempted; their failures are in the sync status.
   */
  async share(options: { remote?: string; branch?: string }): Promise<WorkspaceWire> {
    const open = this.requireOpen();
    const sharedId = open.workspace.id;
    const wire = await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      return await shareAsGit(this.shareDeps(), open, options);
    });
    // Another queued op (a join, an import into a new workspace) may have opened a different
    // workspace by now: its sync is not this share's, so nothing is pushed for it.
    const reopened = this.current;
    if (reopened === undefined || reopened.workspace.id !== sharedId) {
      return wire;
    }
    await reopened.syncReady;
    if (this.stale(reopened) || reopened.workspace.id !== sharedId) {
      return wire;
    }
    if (options.remote !== undefined && options.remote.trim().length > 0) {
      // A rejection — including `sync-stopped` when a close raced this — is already in the status.
      await reopened.sync?.push().catch(() => undefined);
    }
    return this.current === reopened ? (this.snapshot() ?? wire) : wire;
  }

  /** Shares the open local workspace to an empty folder the user picks; `null` on cancel. */
  async shareToFolder(sender: WebContents): Promise<WorkspaceWire | null> {
    const open = this.requireOpen();
    const picks = this.requirePicks();
    return await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      return await shareToFolder(this.shareDeps(), open, () =>
        this.dialogs().pickFolderToWrite(sender, picks, { title: 'Share to folder' }),
      );
    });
  }

  /** Clones a shared workspace from `remote` and opens it. */
  async join(options: { remote: string; branch?: string }): Promise<WorkspaceWire> {
    return await this.enqueueWorkspaceOp(() => joinRemote(this.shareDeps(), options));
  }

  /** Joins a shared workspace from an existing clone or synced folder the user picks; `null` on cancel. */
  async joinFromFolder(sender: WebContents): Promise<WorkspaceWire | null> {
    const picks = this.requirePicks();
    return await this.enqueueWorkspaceOp(() =>
      joinFromFolder(this.shareDeps(), () =>
        this.dialogs().pickFolder(sender, { title: 'Open shared workspace folder' }, picks),
      ),
    );
  }

  /** Makes the open shared workspace local again (see `workspace-share.ts` `stopSharing`). */
  async stopSharing(): Promise<WorkspaceWire> {
    const open = this.requireOpen();
    return await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      return await stopSharing(this.shareDeps(), open);
    });
  }

  /**
   * Copies an open project (its current model, unsaved edits included, plus attachments and
   * definition caches) into the closed workspace `targetWorkspaceId`, then removes it from this
   * one — trashing its folder when it was internal. Ids are kept unless the target already has
   * the project id.
   *
   * @throws WirebenchError `workspace-move-same` when the target is the open workspace.
   */
  async moveProjectToWorkspace(projectId: string, targetWorkspaceId: string): Promise<WorkspaceWire> {
    const open = this.requireOpen();
    requireWorkspaceId(targetWorkspaceId);
    if (targetWorkspaceId === open.workspace.id) {
      throw new WirebenchError('workspace-move-same', 'The project is already in this workspace.', {
        details: { projectId, workspaceId: targetWorkspaceId },
      });
    }
    return await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      const entry = this.requireEntry(projectId);
      const model = entry.host?.model();
      if (model === undefined) {
        throw new WirebenchError('unknown-project', `Project "${projectId}" is not open.`, { details: { projectId } });
      }
      const deleteFiles = entry.ref.source === 'internal';
      // Checked before the copy: a move whose source cannot then be removed would leave two.
      if (deleteFiles && this.deps.trash === undefined) {
        throw new WirebenchError('trash-unavailable', 'Deleting a project folder needs a trash implementation.', {
          details: { projectId },
        });
      }
      await copyProjectIntoWorkspace(this.shareDeps(), { model, dir: entry.dir }, targetWorkspaceId);
      this.requireStillOpen(open);
      return await this.removeProjectNow(projectId, { deleteFiles });
    });
  }

  private shareDeps(): ShareDeps {
    const git = this.deps.git;
    return {
      userDataDir: this.deps.userDataDir,
      files: this.deps.files ?? nodeFileOps,
      fsOption: this.fsOption(),
      git: async () => (git === undefined ? undefined : await git()),
      ready: this.startup,
      close: () => this.close(),
      open: (id, options) => this.openWorkspace(id, options ?? {}),
    };
  }

  private dialogs(): WorkspaceDialogs {
    return this.deps.dialogs ?? { pickFolder, pickFolderToWrite };
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
    return await this.enqueueWorkspaceOp(async () => {
      const open = this.requireOpen();
      const slug = uniqueSlug(name, this.takenSlugs());
      const project = createProject(name);
      const dir = workspaceProjectDir(open.tree, slug);
      await mkdir(dir, { recursive: true });
      await saveProject(project, dir, this.fsOption());
      await this.adoptProject(open, { id: project.id, slug, source: 'internal' }, dir);
      return { workspace: this.requireSnapshot(), projectId: project.id };
    });
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
    return await this.enqueueWorkspaceOp(() => this.removeProjectNow(projectId, options));
  }

  private async removeProjectNow(projectId: string, options: { deleteFiles: boolean }): Promise<WorkspaceWire> {
    const open = this.requireOpen();
    const entry = open.entries.find((candidate) => candidate.projectId === projectId);
    if (entry === undefined) {
      throw new WorkspaceError('project-not-in-workspace', `No project with id "${projectId}" in this workspace.`, {
        details: { projectId },
      });
    }
    const trashFolder = options.deleteFiles && entry.ref.source === 'internal';
    const trash = this.deps.trash;
    // Resolved before anything is closed: refusing outright beats removing the project and then
    // failing to put its folder anywhere.
    if (trashFolder && trash === undefined) {
      throw new WirebenchError('trash-unavailable', 'Deleting a project folder needs a trash implementation.', {
        details: { projectId },
      });
    }
    // Removing a project discards its unsaved changes: there is no project left to restore into.
    await this.releaseEntry(open, entry, { discardUnsaved: true });
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
    return await this.enqueueWorkspaceOp(async () => {
      const open = this.requireOpen();
      if (open.share !== undefined) {
        throw new WirebenchError(
          'share-linked-project-refused',
          'Shared workspaces hold their projects inside the workspace; use Move to workspace… to copy it in.',
          { details: { workspaceId: open.workspace.id } },
        );
      }
      const picked = await this.dialogs().pickFolder(sender, { title: 'Link project folder' }, this.requirePicks());
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
    });
  }

  /**
   * Copies an existing project folder *into* the workspace under fresh ids.
   *
   * Re-identification is what lets the copy coexist with its source — including when the source
   * is itself linked into the same workspace — because entity ids have to stay globally unique
   * inside one open workspace. `secretRef`s are deliberately left alone: they name the user's
   * keychain entries, not the project's.
   *
   * With no workspace open (the picker's *Import project folder…*), a workspace named after the
   * folder is created first — but only once the folder is known to hold a project, so a wrong
   * pick never leaves an empty workspace behind.
   *
   * @returns the workspace, or `null` when the user cancelled the dialog.
   */
  async importProjectFolder(sender: WebContents): Promise<WorkspaceWire | null> {
    return await this.enqueueWorkspaceOp(async () => {
      const picked = await this.dialogs().pickFolder(sender, { title: 'Import project folder' }, this.requirePicks());
      if (picked === undefined) {
        return null;
      }
      return await this.importFrom(picked);
    });
  }

  /**
   * {@link importProjectFolder} for a folder main already holds — one of the picker's
   * suggestions, read from the leftover pre-workspace recent list — rather than one picked in a
   * dialog. The caller resolves the suggestion; no renderer-supplied path ever reaches here.
   */
  async importKnownProjectFolder(folder: string): Promise<WorkspaceWire> {
    return await this.enqueueWorkspaceOp(() => this.importFrom(folder));
  }

  private async importFrom(picked: string): Promise<WorkspaceWire> {
    const source = await realpath(picked);
    const copy = reidentifyProject(await loadPickedProject(source));
    if (this.current === undefined) {
      await this.create(basename(source));
    }
    const open = this.requireOpen();
    const slug = uniqueSlug(copy.name, this.takenSlugs());
    const dir = workspaceProjectDir(open.tree, slug);
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
    const picked = await this.dialogs().pickFolderToWrite(sender, this.requirePicks(), {
      title: 'Export project to folder',
    });
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
    return await this.enqueueWorkspaceOp(async () => {
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
      const picked = await this.dialogs().pickFolder(sender, { title: 'Locate project folder' }, this.requirePicks());
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
    });
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

  // ——— unsaved changes across sessions ————————————————————————————————————————————————————

  /**
   * Keeps `entry`'s recovery record in step with its host: a dirty project's record is rewritten
   * shortly after it changes (so a crash costs at most that moment), a clean one's is removed —
   * which is also how a save, or a reload, clears it.
   */
  private noteUnsaved(entry: OpenProjectEntry, project: ProjectWire | null): void {
    const store = this.unsaved;
    if (store === undefined || project === null) {
      return;
    }
    this.cancelUnsavedWrite(entry.ref.id);
    if (!project.dirty) {
      void store.deleteProject(entry.ref.id).catch(() => undefined);
      return;
    }
    const timer = setTimeout(() => {
      this.unsavedTimers.delete(entry.ref.id);
      void this.writeUnsaved(entry).catch(() => undefined);
    }, UNSAVED_RECORD_DEBOUNCE_MS);
    timer.unref?.();
    this.unsavedTimers.set(entry.ref.id, timer);
  }

  private cancelUnsavedWrite(projectRef: string): void {
    const timer = this.unsavedTimers.get(projectRef);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.unsavedTimers.delete(projectRef);
    }
  }

  /** Writes (or, when it has nothing unsaved, removes) one project's recovery record now. */
  private async writeUnsaved(entry: OpenProjectEntry): Promise<void> {
    const store = this.unsaved;
    if (store === undefined) {
      return;
    }
    const files = entry.host?.unsavedFiles();
    if (files === undefined) {
      await store.deleteProject(entry.ref.id);
      return;
    }
    await store.writeProject(entry.ref.id, files, this.now().toISOString());
  }

  /** Records every open project's unsaved changes, and the renderer's drafts, for next time. */
  private async keepUnsaved(open: OpenWorkspace): Promise<void> {
    const store = this.unsaved;
    if (store === undefined) {
      return;
    }
    for (const projectRef of [...this.unsavedTimers.keys()]) {
      this.cancelUnsavedWrite(projectRef);
    }
    for (const entry of open.entries) {
      if (entry.host !== undefined) {
        await this.writeUnsaved(entry);
      }
    }
    await store.writeDrafts(this.drafts, this.restDrafts, this.grpcDrafts);
    await store.idle();
  }

  /** Acts on what `openProject` did with the record it was given, and says so in `notices`. */
  private settleRestore(
    entry: OpenProjectEntry,
    host: ProjectHost,
    notices: UnsavedRestoreNoticeWire[] | undefined,
  ): void {
    const store = this.unsaved;
    const outcome = host.lastRestore();
    if (store === undefined || outcome === undefined) {
      return;
    }
    const projectName = host.snapshot()?.name ?? entry.ref.slug;
    if (outcome.status === 'failed') {
      void store.setAsideProject(entry.ref.id).catch(() => undefined);
      notices?.push({
        projectId: entry.projectId,
        projectName,
        status: 'failed',
        conflicts: [],
        dropped: [],
        message: outcome.message,
      });
      return;
    }
    if (outcome.status === 'unchanged') {
      void store.deleteProject(entry.ref.id).catch(() => undefined);
      return;
    }
    // Restored: the host is dirty again, so its record is rewritten from the merged state.
    void this.writeUnsaved(entry).catch(() => undefined);
    notices?.push({
      projectId: entry.projectId,
      projectName,
      status: 'restored',
      conflicts: [...outcome.conflicts],
      dropped: [...outcome.dropped],
    });
  }

  /**
   * Replaces the open workspace's stashed request drafts. A stash naming another workspace is
   * ignored: it was sent for one that has since closed.
   */
  async stashDrafts(
    workspaceId: string,
    requests: Readonly<Record<string, RequestPatchWire>>,
    restRequests: Readonly<Record<string, RestRequestPatchWire>> = {},
    grpcRequests: Readonly<Record<string, GrpcRequestPatchWire>> = {},
  ): Promise<void> {
    const waiters = this.stashWaiters;
    this.stashWaiters = [];
    try {
      if (this.current?.workspace.id !== workspaceId || this.unsaved === undefined) {
        return;
      }
      this.drafts = { ...requests };
      this.restDrafts = { ...restRequests };
      this.grpcDrafts = { ...grpcRequests };
      await this.unsaved.writeDrafts(this.drafts, this.restDrafts, this.grpcDrafts);
    } finally {
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  /**
   * Resolves on the renderer's next {@link stashDrafts}, or after `timeoutMs` — what quitting
   * waits on after asking the renderer to flush, so a hung window cannot hold the quit forever.
   */
  nextDraftsStash(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      this.stashWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Hands over (once) the drafts and notices the last open restored. */
  takeRestored(): WorkspaceRestoredResponse {
    const restored = this.restored;
    this.restored = undefined;
    return (
      restored ?? {
        workspaceId: this.current?.workspace.id ?? null,
        drafts: {},
        restDrafts: {},
        grpcDrafts: {},
        notices: [],
      }
    );
  }

  /** Rewrites the manifest's project list from the entries, which are the source of truth. */
  private async saveManifest(open: OpenWorkspace): Promise<void> {
    open.workspace = { ...open.workspace, projects: open.entries.map((entry) => entry.ref) };
    const result = await saveWorkspace(open.workspace, open.tree, this.fsOption());
    // The write this call just made would otherwise come back through the watcher as if a
    // teammate had made it, triggering a redundant reload of the record this call just built.
    open.watcher?.expect([...result.written, ...result.removed]);
    open.sync?.afterSave('workspace');
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
   * without it. `disabled` replaces the whole list the same way. Removing the active
   * environment clears `activeEnvironmentId` — an id pointing
   * at an environment that no longer exists would silently resolve to "no environment" on the
   * next send, which is the same outcome said out loud.
   *
   * @returns the fresh snapshot, plus the id of the environment an `add-workspace-environment`
   * created (the UI has to select and focus it).
   * @throws WorkspaceError `workspace-not-found` when none is open, `environment-not-found`
   * when a change names an environment this workspace does not have.
   */
  async mutate(change: WorkspaceChange): Promise<{ workspace: WorkspaceWire; createdEnvironmentId?: string }> {
    // Captured *before* enqueueing, like `rename`'s open-workspace branch: this op may sit behind
    // others (a reload included) before its turn comes, and re-fetching `this.requireOpen()`
    // once the closure finally runs would silently apply to whatever workspace happens to be
    // open *then* — including a different one the user switched to while this call was queued.
    const open = this.requireOpen();
    return await this.enqueueWorkspaceOp(async () => {
      // The workspace this call captured may have closed (or a different one opened) while it
      // sat behind another queued op — checked again after every `await` below.
      this.requireStillOpen(open);
      const previousWorkspace = open.workspace;
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
        case 'set-workspace-property-enabled': {
          const disabledProperties = change.enabled
            ? open.workspace.disabledProperties.filter((name) => name !== change.name)
            : [...open.workspace.disabledProperties, change.name];
          open.workspace = { ...open.workspace, disabledProperties };
          break;
        }
        case 'add-workspace-environment': {
          // `order` is `max + 1`, not the count: after a removal the count can collide with an
          // order still in use, which would leave two environments claiming the same column.
          const highestOrder = open.workspace.environments.reduce(
            (highest, candidate) => Math.max(highest, candidate.order),
            -1,
          );
          const environment = createWorkspaceEnvironment(
            change.name,
            new Set(open.workspace.environments.map((candidate) => candidate.slug)),
            { order: highestOrder + 1 },
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
            ...(change.patch.disabled !== undefined ? { disabledProperties: [...change.patch.disabled] } : {}),
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

      // Pre-announced before the write (not just after, with the actual written/removed lists):
      // `saveWorkspace`'s several atomic renames are each individually visible to `fs.watch`
      // before this call returns, and a path only marked self-write afterwards can already have
      // been queued by the watcher as an outside edit — see `candidateWorkspacePaths`. Released
      // once the write settles (`saveWorkspaceAnnounced`'s `finally`), whether it succeeded or
      // threw, so a failed save never leaves every candidate suppressed for the rest of the TTL.
      const candidates = candidateWorkspacePaths(previousWorkspace, open.workspace);
      await saveWorkspaceAnnounced(open.watcher, open.workspace, open.tree, candidates, this.fsOption());
      this.requireStillOpen(open);
      open.sync?.afterSave('workspace');
      this.deps.hooks?.onChanged?.(this.snapshot());
      return {
        workspace: this.requireSnapshot(),
        ...(createdEnvironmentId !== undefined ? { createdEnvironmentId } : {}),
      };
    });
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
    // Captured before enqueueing — see `mutate`'s identical reasoning: re-fetching
    // `this.requireOpen()` only once the closure's turn comes up would silently apply this
    // change to whatever workspace happens to be open by then, not the one the caller meant.
    const open = this.requireOpen();
    return await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      if (environmentId === null) {
        open.workspace = withoutActiveEnvironment(open.workspace);
      } else {
        requireEnvironment(open.workspace, environmentId);
        open.workspace = { ...open.workspace, activeEnvironmentId: environmentId };
      }
      // Machine-local: written to local.yaml, in the app-data dir, never to a tree file (see
      // local-state.ts) — so, unlike `mutate`/`rename`, there is nothing here for
      // `open.watcher` (which only watches the tree) to ever see or need pre-announcing.
      await saveLocalState(
        open.dir,
        environmentId === null ? EMPTY_LOCAL_STATE : { version: 1, activeEnvironmentId: environmentId },
        this.fsOption(),
      );
      this.requireStillOpen(open);
      this.deps.hooks?.onChanged?.(this.snapshot());
      return this.requireSnapshot();
    });
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
      disabled: [...workspace.disabledProperties],
      environments: workspace.environments.map((environment): WorkspaceEnvironmentWire => ({
        id: environment.id,
        name: environment.name,
        slug: environment.slug,
        order: environment.order,
        properties: { ...environment.properties },
        endpoints: { ...environment.endpoints },
        disabled: [...environment.disabledProperties],
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
      ...(shareWire(open.share) !== undefined ? { share: shareWire(open.share) } : {}),
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
   * The host owning `entityId` — a project, interface, request of either protocol, API, folder,
   * environment, keystore or WS-Security configuration id. This is how every entity-addressed IPC channel finds its
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
        const owner = this.index.get(id);
        if (owner !== undefined && owner !== project.id) {
          // Two open projects claiming one entity id makes this table — the routing table for
          // every entity-addressed channel — ambiguous, and last-one-wins would silently send
          // the user's edits to the wrong project. Link refuses a duplicate *project* id, so
          // reaching here means a deeper id collision; it must not pass unseen.
          console.warn(
            `[workspace] entity id "${id}" is claimed by both project "${owner}" and project "${project.id}"; ` +
              `routing it to "${project.id}"`,
          );
        }
        this.index.set(id, project.id);
      };
      add(project.id);
      for (const iface of project.interfaces) {
        add(iface.id);
      }
      for (const request of project.requests) {
        add(request.id);
      }
      // The REST half: every channel addressed at an API, a folder or a REST request routes through
      // this table too, so all three have to be in it — without them a REST send resolves no host
      // and fails with `unknown-entity`.
      for (const api of project.apis) {
        add(api.id);
      }
      for (const folder of project.folders) {
        add(folder.id);
      }
      for (const request of project.restRequests) {
        add(request.id);
      }
      for (const api of project.grpcApis) {
        add(api.id);
      }
      for (const request of project.grpcRequests) {
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

  addApi(...[projectId, input]: Parameters<ProjectRouter['addApi']>): ReturnType<ProjectRouter['addApi']> {
    return this.hostFor(projectId).addApi(input);
  }

  /** @inheritdoc */
  addGrpcApi(...[projectId, input]: Parameters<ProjectRouter['addGrpcApi']>): ReturnType<ProjectRouter['addGrpcApi']> {
    return this.hostFor(projectId).addGrpcApi(input);
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
  restSend(...args: Parameters<ProjectRouter['restSend']>): ReturnType<ProjectRouter['restSend']> {
    return this.hostOfEntity(args[0]).restSend(...args);
  }

  /** @inheritdoc */
  restTlsFor(...args: Parameters<ProjectRouter['restTlsFor']>): ReturnType<ProjectRouter['restTlsFor']> {
    return this.hostOfEntity(args[0]).restTlsFor(...args);
  }

  /** @inheritdoc */
  restAuthOf(...args: Parameters<ProjectRouter['restAuthOf']>): ReturnType<ProjectRouter['restAuthOf']> {
    return this.hostOfEntity(args[0]).restAuthOf(...args);
  }

  /** @inheritdoc */
  restMeta(...args: Parameters<ProjectRouter['restMeta']>): ReturnType<ProjectRouter['restMeta']> {
    return this.hostOfEntity(args[0]).restMeta(...args);
  }

  /** @inheritdoc */
  rememberRestCookies(
    ...args: Parameters<ProjectRouter['rememberRestCookies']>
  ): ReturnType<ProjectRouter['rememberRestCookies']> {
    return this.hostOfEntity(args[0]).rememberRestCookies(...args);
  }

  /** @inheritdoc */
  grpcSend(...args: Parameters<ProjectRouter['grpcSend']>): ReturnType<ProjectRouter['grpcSend']> {
    return this.hostOfEntity(args[0]).grpcSend(...args);
  }

  /** @inheritdoc */
  grpcTlsFor(...args: Parameters<ProjectRouter['grpcTlsFor']>): ReturnType<ProjectRouter['grpcTlsFor']> {
    return this.hostOfEntity(args[0]).grpcTlsFor(...args);
  }

  /** @inheritdoc */
  grpcMeta(...args: Parameters<ProjectRouter['grpcMeta']>): ReturnType<ProjectRouter['grpcMeta']> {
    return this.hostOfEntity(args[0]).grpcMeta(...args);
  }

  /** @inheritdoc */
  grpcAuthOf(...args: Parameters<ProjectRouter['grpcAuthOf']>): ReturnType<ProjectRouter['grpcAuthOf']> {
    return this.hostOfEntity(args[0]).grpcAuthOf(...args);
  }

  /** @inheritdoc */
  grpcProtoSetFor(...args: Parameters<ProjectRouter['grpcProtoSetFor']>): ReturnType<ProjectRouter['grpcProtoSetFor']> {
    return this.hostOfEntity(args[0]).grpcProtoSetFor(...args);
  }

  /** @inheritdoc */
  grpcDefinition(...args: Parameters<ProjectRouter['grpcDefinition']>): ReturnType<ProjectRouter['grpcDefinition']> {
    return this.hostOfEntity(args[0]).grpcDefinition(...args);
  }

  /** @inheritdoc */
  grpcSample(...args: Parameters<ProjectRouter['grpcSample']>): ReturnType<ProjectRouter['grpcSample']> {
    return this.hostOfEntity(args[0]).grpcSample(...args);
  }

  /** @inheritdoc */
  grpcFields(...args: Parameters<ProjectRouter['grpcFields']>): ReturnType<ProjectRouter['grpcFields']> {
    return this.hostOfEntity(args[0]).grpcFields(...args);
  }

  /** @inheritdoc */
  grpcRefresh(...args: Parameters<ProjectRouter['grpcRefresh']>): ReturnType<ProjectRouter['grpcRefresh']> {
    return this.hostOfEntity(args[0]).refreshGrpcDefinition(...args);
  }

  /**
   * The TLS material a discovery started from the Import dialog should use.
   *
   * An import may precede the project it will land in, so there is no host to ask; the open hosts
   * share one preferences service, and the first that answers is the configured trust bundle.
   */
  async grpcDiscoveryTls(trustInvalid: boolean): Promise<TlsOptions | undefined> {
    for (const host of this.hosts()) {
      const resolved = await host.grpcDiscoveryTls(trustInvalid);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return trustInvalid ? { rejectUnauthorized: false } : undefined;
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

  apiDefinitionDocuments(
    ...args: Parameters<ProjectRouter['apiDefinitionDocuments']>
  ): ReturnType<ProjectRouter['apiDefinitionDocuments']> {
    return this.hostOfEntity(args[0]).apiDefinitionDocuments(...args);
  }

  apiDefinitionText(
    ...args: Parameters<ProjectRouter['apiDefinitionText']>
  ): ReturnType<ProjectRouter['apiDefinitionText']> {
    return this.hostOfEntity(args[0]).apiDefinitionText(...args);
  }

  exportApiDefinitionTo(
    ...args: Parameters<ProjectRouter['exportApiDefinitionTo']>
  ): ReturnType<ProjectRouter['exportApiDefinitionTo']> {
    return this.hostOfEntity(args[0]).exportApiDefinitionTo(...args);
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
 * Every project folder already known to some workspace on disk — both internal (copied into
 * the workspace) and linked (an absolute path kept in the manifest) — resolved through
 * `realpath` so a symlinked or differently-cased path still matches.
 *
 * Used only to filter {@link readLeftoverProjectFolders}'s suggestions: a folder that is
 * already a project somewhere must never be offered again as something to import.
 */
async function existingWorkspaceProjectDirs(userDataDir: string): Promise<Set<string>> {
  const root = join(userDataDir, WORKSPACES_DIR);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return new Set();
  }
  const dirs = new Set<string>();
  for (const name of names) {
    const dir = join(root, name);
    if (!existsSync(workspaceManifestFile(dir)) && !existsSync(join(dir, WORKSPACE_SHARE_FILE))) {
      continue;
    }
    let workspace: Workspace;
    let tree: string;
    try {
      ({ tree } = await resolveWorkspaceTree(dir));
      ({ workspace } = await loadWorkspace(tree));
    } catch {
      continue;
    }
    for (const ref of workspace.projects) {
      let projectDir: string;
      try {
        projectDir =
          ref.source === 'internal' ? workspaceProjectDir(tree, ref.slug) : requireAbsolute(ref.path, ref.slug);
      } catch {
        continue;
      }
      dirs.add(await realpath(projectDir).catch(() => projectDir));
    }
  }
  return dirs;
}

/**
 * The project folders named by a pre-workspace `recent-projects.json`, most recent first,
 * limited to folders that still exist, and with any folder already present as a project in
 * some workspace filtered out — those are no longer "leftover", they were already imported.
 *
 * Deliberately its own two-field reader rather than the `RecentProjects` class that used to
 * back the old "Open project…" flow: the picker only wants "here are folders you used to
 * open, link one if you like", and reading the file through that class would re-establish a
 * dependency on a list nothing else in the workspace world keeps up to date. The file is never
 * written here, and a missing or corrupt one yields none.
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
  const candidates = result.data.entries.map((entry) => entry.dir).filter((dir) => existsSync(dir));
  const taken = await existingWorkspaceProjectDirs(userDataDir);
  const leftover: string[] = [];
  for (const dir of candidates) {
    const resolved = await realpath(dir).catch(() => dir);
    if (!taken.has(resolved)) {
      leftover.push(dir);
    }
  }
  return leftover;
}

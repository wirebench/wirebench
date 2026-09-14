/**
 * The operations that change *where a workspace's tree lives* or *which workspace a project
 * belongs to*: share as a git repository, share to a synced folder, join from a remote or an
 * existing folder, stop sharing, and copy a project into another (closed) workspace.
 *
 * Each is a plain function over an explicit {@link ShareDeps} handed in by `WorkspaceService`,
 * which keeps only the thin, serialised entry points (every one of these runs inside its
 * workspace operation chain). Nothing here awaits a `SyncService` operation — those wait on
 * reloads queued on that same chain — so the first commit and push of a new share are started by
 * the service once the queued operation has resolved.
 *
 * Path authority is unchanged (ADR-0005, spec §6): the only folders touched outside
 * `<userData>/workspaces/<id>` are ones the user just picked in a native dialog, and a picked
 * folder inside `<userData>` is refused (`share-path-invalid`). Nothing is ever deleted except
 * what these functions themselves just created (a half-made `tree/`, a failed clone, a copy
 * being rolled back, or the source of a cross-volume move once its copy has landed).
 */

import { existsSync } from 'node:fs';
import { cp as nodeCp, mkdir, readdir, realpath, rename as nodeRename, rm as nodeRm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  DEFAULT_GIT_SHARE_SETTINGS,
  deleteShare,
  generateId,
  isWirebenchError,
  GIT_ATTRIBUTES_FILE,
  loadLocalState,
  loadWorkspace,
  reidentifyProject,
  saveLocalState,
  saveProject,
  saveShare,
  saveWorkspace,
  uniqueSlug,
  WirebenchError,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_JOINING_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACE_TREE_DIR,
  WORKSPACES_DIR,
  workspaceDir,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { FsLike, Project, Workspace, WorkspaceShare } from '@wirebench/engine';
import type { WebContents } from 'electron';
import type { RecordsReadPicks, RecordsWritePicks } from './dialog-picks.js';
import { GIT_NOT_FOUND_ERROR } from './sync/create-backend.js';
import { GitBackend } from './sync/git-backend.js';
import { assertBranchName, assertRemoteUrl, assertSafeLocalConfig, type GitCli } from './sync/git-cli.js';
import { copyProjectPayload, isEmptyDir, requireWorkspaceId, resolveWorkspaceTree } from './workspace-files.js';
import type { WorkspaceWire } from '../shared/wire-types.js';

/** The folder pickers these operations run (`native-dialogs.ts` in the app; injected in tests). */
export interface WorkspaceDialogs {
  readonly pickFolder: (
    sender: WebContents,
    options: { readonly title?: string },
    picks?: RecordsReadPicks,
  ) => Promise<string | undefined>;
  readonly pickFolderToWrite: (
    sender: WebContents,
    picks: RecordsWritePicks,
    options: { readonly title?: string },
  ) => Promise<string | undefined>;
}

/** The three filesystem calls a tree move needs — injectable so a cross-volume move can be tested. */
export interface WorkspaceFileOps {
  rename(from: string, to: string): Promise<void>;
  cp(from: string, to: string, options: { readonly recursive: true }): Promise<void>;
  rm(path: string, options: { readonly recursive: true; readonly force: true }): Promise<void>;
}

export const nodeFileOps: WorkspaceFileOps = {
  rename: (from, to) => nodeRename(from, to),
  cp: (from, to, options) => nodeCp(from, to, options),
  rm: (path, options) => nodeRm(path, options),
};

/** What `WorkspaceService` hands these operations. */
export interface ShareDeps {
  readonly userDataDir: string;
  readonly files: WorkspaceFileOps;
  readonly fsOption: { fs: FsLike } | undefined;
  /** The git to run; `undefined` means none was found. */
  readonly git: () => Promise<GitCli | undefined>;
  /** Settles once launch-time cleanup of `.joining/` has finished. */
  readonly ready: Promise<void>;
  /** Closes the open workspace (safe inside a queued operation: it never awaits the chain). */
  readonly close: () => Promise<unknown>;
  /** Opens a workspace; `initialCommitMessage` is committed before sync's own first commit. */
  readonly open: (id: string, options?: { readonly initialCommitMessage?: string }) => Promise<WorkspaceWire>;
}

/** The open workspace as these operations see it. */
export interface OpenWorkspaceInfo {
  readonly workspace: Workspace;
  readonly dir: string;
  readonly tree: string;
  readonly share: WorkspaceShare | undefined;
}

/** Everything that makes up a tree, in the order it is moved. */
const TREE_ITEMS = [
  WORKSPACE_MANIFEST,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_PROJECTS_DIR,
  GIT_ATTRIBUTES_FILE,
] as const;

// ——— small helpers ——————————————————————————————————————————————————————————————————————

/**
 * Thrown by {@link moveEntry} when a cross-volume copy completed but removing the source failed
 * part-way (a file lock, an antivirus scan): the destination is the only complete copy, and the
 * source may be partly gone. Rollbacks treat the item as moved and copy it back over the source.
 */
export class IncompleteMoveError extends WirebenchError {
  readonly copied = true;
  readonly sourceRemoved = false;

  constructor(cause: unknown) {
    super('workspace-move-incomplete', 'The files were copied, but the originals could not all be removed.', {
      cause,
      details: { copied: true, sourceRemoved: false },
    });
    this.name = 'IncompleteMoveError';
  }
}

/**
 * Renames `from` to `to`; when they sit on different filesystems (`EXDEV` — an external folder on
 * another volume) copies instead and removes the source only once the copy is complete. A copy
 * that fails part-way is removed again, leaving the source as it was.
 *
 * @throws IncompleteMoveError when the copy landed but the source could not be fully removed.
 */
export async function moveEntry(files: WorkspaceFileOps, from: string, to: string): Promise<void> {
  try {
    await files.rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
  }
  try {
    await files.cp(from, to, { recursive: true });
  } catch (error) {
    await files.rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await files.rm(from, { recursive: true, force: true });
  } catch (error) {
    throw new IncompleteMoveError(error);
  }
}

/**
 * Puts one moved item back from `current` to `original`. When something is still at `original`
 * (the partial source an {@link IncompleteMoveError} left) the complete copy is copied back over
 * it before the copy is removed; otherwise it is simply moved back.
 */
async function restoreEntry(files: WorkspaceFileOps, current: string, original: string): Promise<void> {
  if (existsSync(original)) {
    await files.cp(current, original, { recursive: true });
    await files.rm(current, { recursive: true, force: true });
    return;
  }
  await moveEntry(files, current, original);
}

/**
 * Moves every tree item present in `from` into `to`, recording each one in `moved` as it lands —
 * including one whose copy landed but whose source could not be fully removed.
 */
async function moveTreeItems(files: WorkspaceFileOps, from: string, to: string, moved: string[]): Promise<void> {
  for (const name of TREE_ITEMS) {
    if (!existsSync(join(from, name))) {
      continue;
    }
    try {
      await moveEntry(files, join(from, name), join(to, name));
    } catch (error) {
      if (error instanceof IncompleteMoveError) {
        moved.push(name);
      }
      throw error;
    }
    moved.push(name);
  }
}

/** Undoes {@link moveTreeItems}: puts each recorded item back, last first. */
async function moveTreeItemsBack(
  files: WorkspaceFileOps,
  from: string,
  to: string,
  moved: readonly string[],
): Promise<void> {
  for (const name of [...moved].reverse()) {
    await restoreEntry(files, join(to, name), join(from, name));
  }
}

/**
 * Refuses a folder inside `<userData>`: an external share path there would put shared files
 * next to secrets, history and other workspaces. Both sides are realpath'd so a symlinked temp
 * root (macOS `/var` → `/private/var`) compares correctly.
 *
 * @throws WirebenchError `share-path-invalid`.
 */
export async function assertOutsideUserData(userDataDir: string, candidate: string): Promise<void> {
  const root = await realpath(userDataDir);
  const real = await realpath(candidate);
  const rel = relative(root, real);
  const inside = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  if (inside) {
    throw new WirebenchError('share-path-invalid', 'Choose a folder outside the app’s own data folder.');
  }
}

function requireLocal(info: OpenWorkspaceInfo): void {
  if (info.share !== undefined) {
    throw new WirebenchError('workspace-already-shared', `"${info.workspace.name}" is already shared.`, {
      details: { workspaceId: info.workspace.id },
    });
  }
}

function refuseLinked(workspace: Workspace): void {
  if (workspace.projects.some((ref) => ref.source === 'linked')) {
    throw new WirebenchError(
      'share-linked-project-refused',
      'Shared workspaces hold their projects inside the workspace. Remove the linked projects, or move them into the workspace, before sharing.',
      { details: { workspaceId: workspace.id } },
    );
  }
}

async function requireGit(deps: ShareDeps): Promise<GitCli> {
  const git = await deps.git();
  if (git === undefined) {
    throw new WirebenchError(GIT_NOT_FOUND_ERROR.code, GIT_NOT_FOUND_ERROR.message);
  }
  return git;
}

function alreadyPresent(workspace: Workspace): WirebenchError {
  return new WirebenchError('workspace-already-present', `"${workspace.name}" is already on this machine.`, {
    details: { workspaceId: workspace.id },
  });
}

/**
 * The branch `tree`'s HEAD is on, validated for `share.yaml`. An unborn branch (no commits yet)
 * is read through `symbolic-ref`; a detached HEAD is refused.
 */
async function readHeadBranch(git: GitCli, tree: string): Promise<string> {
  let branch: string;
  try {
    branch = (await git.run(tree, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    branch = (await git.run(tree, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  }
  if (branch === 'HEAD') {
    throw new WirebenchError(
      'git-branch-refused',
      'The repository is on a detached HEAD, not a branch. Check out a branch, then try again.',
    );
  }
  return assertBranchName(branch);
}

/**
 * `origin`'s URL, validated, or `undefined` when the clone has no `origin` (`remote get-url` exits 2).
 *
 * @throws WirebenchError `git-remote-refused` when `origin` is not a URL this app accepts (never
 * echoing it) — most often a plain folder path, whose `file://` form works.
 */
async function readOrigin(git: GitCli, tree: string): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await git.run(tree, ['remote', 'get-url', 'origin']));
  } catch (error) {
    if (isWirebenchError(error) && error.details?.['exitCode'] === 2) {
      return undefined;
    }
    throw error;
  }
  try {
    return assertRemoteUrl(stdout);
  } catch {
    throw new WirebenchError(
      'git-remote-refused',
      "This clone's origin is not an https://, ssh:// or file:// URL. For a folder on this machine, set origin to its file:// form, then try again.",
    );
  }
}

// ——— share ——————————————————————————————————————————————————————————————————————————————

/**
 * Turns the open local workspace into a git share: moves the tree into `<dir>/tree`, initialises
 * the repository (writing `.gitattributes`), points `origin` at `remote` when given, writes
 * `share.yaml`, and reopens with `Share workspace <name>` as the first commit.
 *
 * Everything before `share.yaml` is written is undone on failure — the items move back, a
 * `tree/` (or `.git`, `.gitattributes`) this call created is removed, and the workspace reopens
 * as it was. Once `share.yaml` exists the workspace *is* shared; a failing first commit or push
 * shows up in the sync status instead.
 */
export async function shareAsGit(
  deps: ShareDeps,
  info: OpenWorkspaceInfo,
  options: { readonly remote?: string; readonly branch?: string },
): Promise<WorkspaceWire> {
  requireLocal(info);
  refuseLinked(info.workspace);
  const remote =
    options.remote !== undefined && options.remote.trim().length > 0 ? assertRemoteUrl(options.remote) : undefined;
  const branch = assertBranchName(options.branch ?? DEFAULT_GIT_SHARE_SETTINGS.branch);
  const git = await requireGit(deps);
  const { dir } = info;
  const { id, name } = info.workspace;
  const tree = join(dir, WORKSPACE_TREE_DIR);
  // Stopping a share leaves `tree/.git` behind for the user. Sharing on top of it would inherit
  // that repository's branch, origin and history, so it is refused while nothing has moved yet.
  if (existsSync(join(tree, '.git'))) {
    throw new WirebenchError(
      'workspace-git-leftover',
      'This workspace still has the git folder from when it was last shared. Delete tree/.git to share it again.',
      { details: { workspaceId: id } },
    );
  }
  const treeExisted = existsSync(tree);
  const attributesExisted = existsSync(join(tree, GIT_ATTRIBUTES_FILE));

  await deps.close();
  const moved: string[] = [];
  try {
    await mkdir(tree, { recursive: true });
    await moveTreeItems(deps.files, dir, tree, moved);
    await GitBackend.init(git, tree, branch);
    if (remote !== undefined) {
      await git.run(tree, ['remote', 'add', 'origin', remote]);
    }
    await saveShare(
      dir,
      {
        version: 1,
        kind: 'git',
        git: { ...DEFAULT_GIT_SHARE_SETTINGS, branch, ...(remote !== undefined ? { remote } : {}) },
      },
      deps.fsOption,
    );
  } catch (error) {
    await rollBackShare(deps, { dir, tree, moved, treeExisted, attributesExisted }).catch(() => undefined);
    await deps.open(id).catch(() => undefined);
    throw error;
  }
  return await deps.open(id, { initialCommitMessage: `Share workspace ${name}` });
}

async function rollBackShare(
  deps: ShareDeps,
  state: {
    readonly dir: string;
    readonly tree: string;
    readonly moved: readonly string[];
    readonly treeExisted: boolean;
    readonly attributesExisted: boolean;
  },
): Promise<void> {
  const { dir, tree } = state;
  await deleteShare(dir, deps.fsOption).catch(() => undefined);
  await moveTreeItemsBack(deps.files, dir, tree, state.moved);
  if (!state.treeExisted) {
    await deps.files.rm(tree, { recursive: true, force: true });
    return;
  }
  // A pre-existing `.git` is refused before anything moves, so any `.git` here is this call's.
  await deps.files.rm(join(tree, '.git'), { recursive: true, force: true });
  if (!state.attributesExisted) {
    await deps.files.rm(join(tree, GIT_ATTRIBUTES_FILE), { recursive: true, force: true });
  }
}

/**
 * Turns the open local workspace into a folder share at an empty folder the user picks (outside
 * `<userData>`): the tree moves there and `share.yaml` records the path. Undone on failure
 * before `share.yaml` is written, like {@link shareAsGit}.
 *
 * @returns `null` when the user cancelled the dialog.
 */
export async function shareToFolder(
  deps: ShareDeps,
  info: OpenWorkspaceInfo,
  pick: () => Promise<string | undefined>,
): Promise<WorkspaceWire | null> {
  requireLocal(info);
  refuseLinked(info.workspace);
  const picked = await pick();
  if (picked === undefined) {
    return null;
  }
  const path = await realpath(picked);
  await assertOutsideUserData(deps.userDataDir, path);
  if (!(await isEmptyDir(path))) {
    throw new WirebenchError('folder-not-empty', 'Choose an empty folder to share the workspace into.', {
      details: { dir: path },
    });
  }
  const { dir } = info;
  const { id } = info.workspace;
  await deps.close();
  const moved: string[] = [];
  try {
    await moveTreeItems(deps.files, dir, path, moved);
    await saveShare(dir, { version: 1, kind: 'folder', path }, deps.fsOption);
  } catch (error) {
    await deleteShare(dir, deps.fsOption).catch(() => undefined);
    await moveTreeItemsBack(deps.files, dir, path, moved).catch(() => undefined);
    await deps.open(id).catch(() => undefined);
    throw error;
  }
  return await deps.open(id);
}

// ——— join ———————————————————————————————————————————————————————————————————————————————

/**
 * Clones `remote` into `<workspaces>/.joining/<ulid>`, reads the workspace id from the clone's
 * manifest, and renames the clone to `<workspaces>/<id>/tree` with a `share.yaml` naming the
 * branch the clone checked out. A failed clone, a clone that is not a workspace, and a workspace
 * already on this machine leave nothing behind.
 */
export async function joinRemote(
  deps: ShareDeps,
  options: { readonly remote: string; readonly branch?: string },
): Promise<WorkspaceWire> {
  const remote = assertRemoteUrl(options.remote);
  const branch = options.branch !== undefined ? assertBranchName(options.branch) : undefined;
  const git = await requireGit(deps);
  await deps.ready;
  const joiningRoot = join(deps.userDataDir, WORKSPACES_DIR, WORKSPACE_JOINING_DIR);
  await mkdir(joiningRoot, { recursive: true });
  const joining = join(joiningRoot, generateId());

  let id: string;
  let headBranch: string;
  try {
    await GitBackend.clone(git, remote, branch, joining);
    const { workspace } = await loadWorkspace(joining, deps.fsOption);
    id = requireWorkspaceId(workspace.id);
    headBranch = await readHeadBranch(git, joining);
    if (existsSync(workspaceDir(deps.userDataDir, id))) {
      throw alreadyPresent(workspace);
    }
  } catch (error) {
    await deps.files.rm(joining, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const dir = workspaceDir(deps.userDataDir, id);
  try {
    await mkdir(dir, { recursive: true });
    await deps.files.rename(joining, join(dir, WORKSPACE_TREE_DIR));
    await saveShare(
      dir,
      { version: 1, kind: 'git', git: { ...DEFAULT_GIT_SHARE_SETTINGS, remote, branch: headBranch } },
      deps.fsOption,
    );
  } catch (error) {
    // `dir` did not exist a moment ago: everything in it is this call's.
    await deps.files.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await deps.files.rm(joining, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return await deps.open(id);
}

/**
 * Joins a workspace from a folder the user picks: an existing clone (`.git` present → `git`, with
 * its branch and `origin`) or a synced folder (`folder`). The folder stays where it is and
 * `share.yaml` records its path.
 *
 * @returns `null` when the user cancelled the dialog.
 */
export async function joinFromFolder(
  deps: ShareDeps,
  pick: () => Promise<string | undefined>,
): Promise<WorkspaceWire | null> {
  const picked = await pick();
  if (picked === undefined) {
    return null;
  }
  const path = await realpath(picked);
  await assertOutsideUserData(deps.userDataDir, path);
  const { workspace } = await loadWorkspace(path, deps.fsOption);
  const id = requireWorkspaceId(workspace.id);
  await deps.ready;
  const dir = workspaceDir(deps.userDataDir, id);
  if (existsSync(dir)) {
    throw alreadyPresent(workspace);
  }
  let share: WorkspaceShare;
  if (existsSync(join(path, '.git'))) {
    const git = await requireGit(deps);
    // A repository the app did not create: its .git/config is checked before git runs in it.
    await assertSafeLocalConfig(git, path);
    const branch = await readHeadBranch(git, path);
    const origin = await readOrigin(git, path);
    share = {
      version: 1,
      kind: 'git',
      path,
      git: { ...DEFAULT_GIT_SHARE_SETTINGS, branch, ...(origin !== undefined ? { remote: origin } : {}) },
    };
  } else {
    share = { version: 1, kind: 'folder', path };
  }
  try {
    await mkdir(dir, { recursive: true });
    await saveShare(dir, share, deps.fsOption);
  } catch (error) {
    await deps.files.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return await deps.open(id);
}

// ——— stop sharing ———————————————————————————————————————————————————————————————————————

/**
 * Makes the open shared workspace local again. A managed tree (`<dir>/tree`) moves back up to
 * `<dir>`, leaving `tree/.git` for the user to delete; an external tree is *copied* back and the
 * external folder (and its `.git`) is left exactly as it was. `share.yaml` is deleted last, and
 * everything before that is undone on failure.
 */
export async function stopSharing(deps: ShareDeps, info: OpenWorkspaceInfo): Promise<WorkspaceWire> {
  const { share, dir, tree } = info;
  const { id } = info.workspace;
  if (share === undefined) {
    throw new WirebenchError('workspace-not-shared', `"${info.workspace.name}" is not shared.`, {
      details: { workspaceId: id },
    });
  }
  if (!existsSync(join(tree, WORKSPACE_MANIFEST))) {
    throw new WirebenchError(
      'workspace-tree-missing',
      'The shared folder or its workspace.yaml is missing, so sharing cannot be stopped safely.',
      { details: { workspaceId: id } },
    );
  }
  const present = TREE_ITEMS.filter((name) => existsSync(join(tree, name)));
  if (present.some((name) => existsSync(join(dir, name)))) {
    throw new WirebenchError(
      'folder-not-empty',
      'The workspace’s own folder already holds workspace files, so the shared files cannot be brought back.',
      { details: { workspaceId: id } },
    );
  }
  const external = share.path !== undefined;
  await deps.close();
  const brought: string[] = [];
  let shareDeleted = false;
  try {
    for (const name of present) {
      if (external) {
        // Recorded before the copy: nothing was at `<dir>/<name>` (checked above), so a copy that
        // fails part-way is this call's to remove.
        brought.push(name);
        await deps.files.cp(join(tree, name), join(dir, name), { recursive: true });
      } else {
        try {
          await moveEntry(deps.files, join(tree, name), join(dir, name));
        } catch (error) {
          if (error instanceof IncompleteMoveError) {
            brought.push(name);
          }
          throw error;
        }
        brought.push(name);
      }
    }
    await deleteShare(dir, deps.fsOption);
    shareDeleted = true;
    return await deps.open(id);
  } catch (error) {
    // Without `share.yaml` and with the manifest gone back, `<id>` would vanish from the list and
    // block a re-join; put the share back first, and only then undo what was brought back.
    const shareRestored = shareDeleted
      ? await saveShare(dir, share, deps.fsOption).then(
          () => true,
          () => false,
        )
      : true;
    if (shareRestored) {
      for (const name of [...brought].reverse()) {
        const undo = external
          ? deps.files.rm(join(dir, name), { recursive: true, force: true })
          : restoreEntry(deps.files, join(dir, name), join(tree, name));
        await undo.catch(() => undefined);
      }
    }
    await deps.open(id).catch(() => undefined);
    throw error;
  }
}

// ——— move project to workspace ——————————————————————————————————————————————————————————

/**
 * Rewriting a v1/v2 manifest drops the active environment it still carries (`loadWorkspace` has
 * already moved it into `legacy`); this keeps it in `<dir>/local.yaml`, as `open` does — only
 * when there is no local choice yet and it still names one of the workspace's environments.
 * Call it before the rewrite, for a workspace that is not open.
 */
export async function keepLegacyActiveEnvironment(
  dir: string,
  workspace: Workspace,
  legacy: { readonly activeEnvironmentId?: string | undefined },
  fsOption: ShareDeps['fsOption'],
): Promise<void> {
  const legacyId = legacy.activeEnvironmentId;
  if (legacyId === undefined || !workspace.environments.some((environment) => environment.id === legacyId)) {
    return;
  }
  const local = await loadLocalState(dir, fsOption);
  if (local.activeEnvironmentId === undefined) {
    await saveLocalState(dir, { version: 1, activeEnvironmentId: legacyId }, fsOption);
  }
}

/**
 * Writes `model` (with the attachment and definition-cache bytes from `sourceDir`) into the
 * closed workspace `targetId` as a new internal project, and appends its reference to that
 * workspace's manifest. Ids are kept unless the target already references this project id, in
 * which case the copy is re-identified. The caller removes the source afterwards.
 */
export async function copyProjectIntoWorkspace(
  deps: ShareDeps,
  source: { readonly model: Project; readonly dir: string },
  targetId: string,
): Promise<{ readonly projectId: string }> {
  const targetDir = workspaceDir(deps.userDataDir, requireWorkspaceId(targetId));
  const { tree } = await resolveWorkspaceTree(targetDir, deps.fsOption);
  const { workspace, legacy } = await loadWorkspace(tree, deps.fsOption);
  const copy = workspace.projects.some((ref) => ref.id === source.model.id)
    ? reidentifyProject(source.model)
    : source.model;
  const taken = new Set(workspace.projects.map((ref) => ref.slug));
  // A stray folder under projects/ that no reference names must not be written into either.
  const onDisk = await readdir(join(tree, WORKSPACE_PROJECTS_DIR)).catch(() => []);
  for (const name of onDisk) {
    taken.add(name);
  }
  const slug = uniqueSlug(copy.name, taken);
  const projectDir = workspaceProjectDir(tree, slug);
  try {
    await mkdir(projectDir, { recursive: true });
    await saveProject(copy, projectDir, deps.fsOption);
    await copyProjectPayload(source.dir, projectDir);
    await keepLegacyActiveEnvironment(targetDir, workspace, legacy, deps.fsOption);
    await saveWorkspace(
      { ...workspace, projects: [...workspace.projects, { id: copy.id, slug, source: 'internal' }] },
      tree,
      deps.fsOption,
    );
  } catch (error) {
    // `projectDir` was not taken by any reference or folder a moment ago: it is this call's.
    await deps.files.rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { projectId: copy.id };
}

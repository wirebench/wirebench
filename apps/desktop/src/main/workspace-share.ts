/**
 * The operations that change *where a workspace's tree lives* or *which workspace a project
 * belongs to*: share as a git repository, share to a synced folder, and join from a remote or an
 * existing folder.
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
import { cp as nodeCp, mkdir, realpath, rename as nodeRename, rm as nodeRm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  DEFAULT_GIT_SHARE_SETTINGS,
  deleteShare,
  generateId,
  GIT_ATTRIBUTES_FILE,
  loadWorkspace,
  saveShare,
  WirebenchError,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_JOINING_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACE_TREE_DIR,
  WORKSPACES_DIR,
  workspaceDir,
} from '@wirebench/engine';
import type { FsLike, Workspace, WorkspaceShare } from '@wirebench/engine';
import type { WebContents } from 'electron';
import type { RecordsReadPicks, RecordsWritePicks } from './dialog-picks.js';
import { GIT_NOT_FOUND_ERROR } from './sync/create-backend.js';
import { GitBackend } from './sync/git-backend.js';
import { assertBranchName, assertRemoteUrl, type GitCli } from './sync/git-cli.js';
import { isEmptyDir, requireWorkspaceId } from './workspace-files.js';
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
 * Renames `from` to `to`; when they sit on different filesystems (`EXDEV` — an external folder on
 * another volume) copies instead and removes the source only once the copy is complete. A copy
 * that fails part-way is removed again, leaving the source as it was.
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
  await files.rm(from, { recursive: true, force: true });
}

/** Moves every tree item present in `from` into `to`, recording each one in `moved` as it lands. */
async function moveTreeItems(files: WorkspaceFileOps, from: string, to: string, moved: string[]): Promise<void> {
  for (const name of TREE_ITEMS) {
    if (!existsSync(join(from, name))) {
      continue;
    }
    await moveEntry(files, join(from, name), join(to, name));
    moved.push(name);
  }
}

/** Undoes {@link moveTreeItems}: moves each recorded item back, last first. */
async function moveTreeItemsBack(
  files: WorkspaceFileOps,
  from: string,
  to: string,
  moved: readonly string[],
): Promise<void> {
  for (const name of [...moved].reverse()) {
    await moveEntry(files, join(to, name), join(from, name));
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
      'git-failed',
      'The repository is on a detached HEAD, not a branch. Check out a branch, then try again.',
    );
  }
  return assertBranchName(branch);
}

/** `origin`'s URL when there is one git and this app both accept; `undefined` otherwise. */
async function readOrigin(git: GitCli, tree: string): Promise<string | undefined> {
  try {
    const { stdout } = await git.run(tree, ['remote', 'get-url', 'origin']);
    return assertRemoteUrl(stdout);
  } catch {
    return undefined;
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
  // A tree/ can already exist: stopping a share leaves `tree/.git` behind for the user.
  const treeExisted = existsSync(tree);
  const gitExisted = existsSync(join(tree, '.git'));
  const attributesExisted = existsSync(join(tree, GIT_ATTRIBUTES_FILE));

  await deps.close();
  const moved: string[] = [];
  try {
    await mkdir(tree, { recursive: true });
    await moveTreeItems(deps.files, dir, tree, moved);
    await GitBackend.init(git, tree, branch);
    if (remote !== undefined) {
      const existing = await readOrigin(git, tree);
      await git.run(
        tree,
        existing === undefined ? ['remote', 'add', 'origin', remote] : ['remote', 'set-url', 'origin', remote],
      );
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
    await rollBackShare(deps, { dir, tree, moved, treeExisted, gitExisted, attributesExisted }).catch(() => undefined);
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
    readonly gitExisted: boolean;
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
  if (!state.gitExisted) {
    await deps.files.rm(join(tree, '.git'), { recursive: true, force: true });
  }
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

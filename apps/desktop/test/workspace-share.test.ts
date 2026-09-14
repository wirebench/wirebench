// @vitest-environment node
/**
 * Share, join, stop sharing and move-to-workspace over a temp `userData` and real git (a temp bare
 * remote). Dialogs are injected through `WorkspaceServiceDeps.dialogs`; git runs hermetically
 * (see `sync/git-fixture.ts`). Skipped loudly without git.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm as removeFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createProject,
  loadShare,
  loadWorkspace,
  nodeFs,
  saveProject,
  WirebenchError,
  workspaceDir,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { WebContents } from 'electron';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import type { GitCli } from '../src/main/sync/git-cli.js';
import { SyncService } from '../src/main/sync/sync-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';
import { nodeFileOps } from '../src/main/workspace-share.js';
import {
  createBareRemote,
  describeGit,
  hermeticGitEnv,
  makeTestGitCli,
  mkTempDir,
  removeTempDir,
} from './sync/git-fixture.js';

const WAIT = { timeout: 15_000, interval: 50 };
const sender = {} as WebContents;

let base: string;
let git: GitCli;
let remote: { dir: string; url: string };
const services: WorkspaceService[] = [];

/** A fresh `userData` under `base`, and a service over it. */
async function newService(
  name: string,
  overrides: Partial<WorkspaceServiceDeps> = {},
): Promise<{ root: string; service: WorkspaceService; trashed: string[] }> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  const trashed: string[] = [];
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    git: () => Promise.resolve(git),
    picks: new DialogPicks(),
    trash: (path) => {
      trashed.push(path);
      return Promise.resolve();
    },
    ...overrides,
  });
  services.push(service);
  return { root, service, trashed };
}

/** Injected dialogs answering every folder pick with `path` (or cancelling on `undefined`). */
function dialogsPicking(path: string | undefined): NonNullable<WorkspaceServiceDeps['dialogs']> {
  return {
    pickFolder: () => Promise.resolve(path),
    pickFolderToWrite: () => Promise.resolve(path),
  };
}

/** Every file under `dir`, recursively, with its bytes — skipping `.git` internals. */
async function snapshotFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = relative(dir, join(entry.parentPath, entry.name));
    if (!entry.isFile() || path.split(/[\\/]/).includes('.git')) {
      continue;
    }
    out[path] = (await readFile(join(dir, path))).toString('base64');
  }
  return out;
}

/** Creates a workspace with one project (plus an attachment blob) and an unsaved record on disk. */
async function seedLocal(
  service: WorkspaceService,
  root: string,
): Promise<{ id: string; dir: string; projectId: string }> {
  const created = await service.create('Team');
  const { workspace, projectId } = await service.addProject('Calc');
  const dir = workspaceDir(root, created.id);
  await mkdir(join(dir, 'projects', 'Calc', 'attachments'), { recursive: true });
  await writeFile(join(dir, 'projects', 'Calc', 'attachments', 'blob.bin'), Buffer.from([0, 1, 2, 255]));
  await mkdir(join(dir, 'unsaved'), { recursive: true });
  await writeFile(join(dir, 'unsaved', 'marker.txt'), 'keep me', 'utf8');
  return { id: workspace.id, dir, projectId };
}

async function gitLog(tree: string, cwdGit = git): Promise<string> {
  return (await cwdGit.run(tree, ['log', '--format=%s'])).stdout;
}

/** Adds a workspace environment and makes it the active one; returns its id. */
async function activateEnvironment(service: WorkspaceService): Promise<string> {
  const { createdEnvironmentId } = await service.mutate({ kind: 'add-workspace-environment', name: 'dev' });
  await service.setActiveEnvironment(createdEnvironmentId as string);
  return createdEnvironmentId as string;
}

/** The test git, except that `subcommand` always fails. */
function gitFailingOn(subcommand: string): GitCli {
  return {
    version: git.version,
    run: (cwd: string | undefined, args: readonly string[]) =>
      args[0] === subcommand
        ? Promise.reject(new WirebenchError('git-failed', `${subcommand} failed`))
        : git.run(cwd, args),
  } as unknown as GitCli;
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

beforeEach(async () => {
  base = await realpath(await mkTempDir('wirebench-workspace-share-'));
  const hooksDir = join(base, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  const env = {
    ...(await hermeticGitEnv(base)),
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  git = makeTestGitCli(hooksDir, env);
  remote = await createBareRemote(git, join(base, 'remote.git'));
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close();
  }
  await removeTempDir(base);
});

describeGit('WorkspaceService — share as git', () => {
  it('moves the tree into <id>/tree, commits "Share workspace …", pushes, and keeps files and unsaved/ intact', async () => {
    const { root, service } = await newService('a');
    const { id, dir, projectId } = await seedLocal(service, root);
    const projectBefore = await snapshotFiles(join(dir, 'projects'));

    const wire = await service.share({ remote: `  ${remote.url}  `, branch: 'main' });

    expect(wire.id).toBe(id);
    const tree = join(dir, 'tree');
    expect(existsSync(join(tree, '.git'))).toBe(true);
    expect(existsSync(join(tree, 'workspace.yaml'))).toBe(true);
    expect(existsSync(join(tree, '.gitattributes'))).toBe(true);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'projects'))).toBe(false);
    expect(await snapshotFiles(join(tree, 'projects'))).toEqual(projectBefore);
    expect(await readFile(join(dir, 'unsaved', 'marker.txt'), 'utf8')).toBe('keep me');
    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'git',
      git: { branch: 'main', autoFetchSeconds: 60, commitOnSave: true, pushOnSave: true, remote: remote.url },
    });
    expect(await gitLog(tree)).toMatch(/^Share workspace Team$/m);
    expect((await gitLog(remote.dir)).trim()).toBe('Share workspace Team');
    expect(service.snapshot()?.projects.map((project) => project.id)).toEqual([projectId]);
    expect(service.sync()).toBeDefined();
  });

  it('shares without a remote (branch defaults to main) and commits locally', async () => {
    const { root, service } = await newService('a');
    const { dir } = await seedLocal(service, root);
    await service.share({});
    expect((await loadShare(dir))?.git).toEqual({
      branch: 'main',
      autoFetchSeconds: 60,
      commitOnSave: true,
      pushOnSave: true,
    });
    await vi.waitFor(async () => expect(await gitLog(join(dir, 'tree'))).toMatch(/Share workspace Team/), WAIT);
  });

  it('refuses a bad URL or branch, and a missing git, leaving the workspace local, open and unchanged', async () => {
    const { root, service } = await newService('a');
    const { dir } = await seedLocal(service, root);
    const before = await snapshotFiles(dir);

    const refused = await service.share({ remote: '-oProxyCommand=evil host:repo' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WirebenchError);
    expect((refused as WirebenchError).code).toBe('git-remote-refused');
    expect((refused as WirebenchError).message).not.toContain('ProxyCommand');
    await expect(service.share({ branch: '../evil' })).rejects.toBeInstanceOf(WirebenchError);

    const noGit = await newService('b', { git: () => Promise.resolve(undefined) });
    await seedLocal(noGit.service, noGit.root);
    await expect(noGit.service.share({})).rejects.toMatchObject({ code: 'git-not-found' });

    expect(await snapshotFiles(dir)).toEqual(before);
    expect(existsSync(join(dir, 'tree'))).toBe(false);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.snapshot()?.name).toBe('Team');
  });

  it('rolls back when git init fails before share.yaml is written, keeping the active environment', async () => {
    const { root, service } = await newService('a', { git: () => Promise.resolve(gitFailingOn('init')) });
    const { dir, projectId } = await seedLocal(service, root);
    const environmentId = await activateEnvironment(service);
    const before = await snapshotFiles(dir);

    await expect(service.share({})).rejects.toMatchObject({ code: 'git-failed' });

    expect(await snapshotFiles(dir)).toEqual(before);
    expect(existsSync(join(dir, 'tree'))).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.snapshot()?.projects.map((project) => project.id)).toEqual([projectId]);
    expect(service.snapshot()?.activeEnvironmentId).toBe(environmentId);
    expect(service.sync()).toBeUndefined();
  });

  it('rolls back a move that fails part-way through the tree items', async () => {
    let failInto = '';
    const { root, service } = await newService('a', {
      files: {
        ...nodeFileOps,
        rename: (from: string, to: string) =>
          to === failInto ? Promise.reject(errnoError('EPERM')) : nodeFileOps.rename(from, to),
      },
    });
    const { dir, projectId } = await seedLocal(service, root);
    const environmentId = await activateEnvironment(service);
    failInto = join(dir, 'tree', 'projects');
    const before = await snapshotFiles(dir);

    await expect(service.share({})).rejects.toMatchObject({ code: 'EPERM' });

    expect(await snapshotFiles(dir)).toEqual(before);
    expect(existsSync(join(dir, 'tree'))).toBe(false);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.snapshot()?.projects.map((project) => project.id)).toEqual([projectId]);
    expect(service.snapshot()?.activeEnvironmentId).toBe(environmentId);
  });

  it('rolls back when adding the remote fails', async () => {
    const { root, service } = await newService('a', { git: () => Promise.resolve(gitFailingOn('remote')) });
    const { dir } = await seedLocal(service, root);
    const environmentId = await activateEnvironment(service);
    const before = await snapshotFiles(dir);

    await expect(service.share({ remote: remote.url })).rejects.toMatchObject({ code: 'git-failed' });

    expect(await snapshotFiles(dir)).toEqual(before);
    expect(existsSync(join(dir, 'tree'))).toBe(false);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.snapshot()?.activeEnvironmentId).toBe(environmentId);
  });

  it('refuses to share again over the git folder a stopped share left behind', async () => {
    const { root, service } = await newService('a');
    const { dir } = await seedLocal(service, root);
    await service.share({});
    await service.stopSharing();
    const before = await snapshotFiles(dir);

    const error = await service.share({}).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'workspace-git-leftover' });
    expect((error as WirebenchError).message).toContain('tree/.git');
    expect(await snapshotFiles(dir)).toEqual(before);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.snapshot()?.name).toBe('Team');
    expect(service.sync()).toBeUndefined();
  });

  it('skips the first push when another workspace opened while sync was starting', async () => {
    const other = await newService('o');
    const seeded = await seedLocal(other.service, other.root);
    await other.service.close();
    const copy = join(base, 'other-copy');
    const { cp } = await import('node:fs/promises');
    await cp(seeded.dir, copy, { recursive: true });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { root, service } = await newService('a', {
      dialogs: dialogsPicking(copy),
      git: async () => {
        calls += 1;
        // The first call is share's own; the second is the reopened workspace's sync start-up.
        if (calls > 1) {
          await gate;
        }
        return git;
      },
    });
    const { id } = await seedLocal(service, root);

    const sharing = service.share({ remote: remote.url });
    const joining = service.joinFromFolder(sender);
    await vi.waitFor(() => expect(service.snapshot()?.id).toBe(seeded.id), WAIT);
    release();
    const wire = await sharing;
    await joining;

    expect(wire.id).toBe(id);
    expect(service.snapshot()?.id).toBe(seeded.id);
    await expect(git.run(remote.dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'])).rejects.toBeInstanceOf(
      WirebenchError,
    );
  });

  it('keeps the share when the first push fails after share.yaml is written, reporting it through sync status', async () => {
    const { root, service } = await newService('a');
    const { dir } = await seedLocal(service, root);
    const missing = `${remote.url.replace(/remote\.git$/, '')}nowhere.git`;

    await service.share({ remote: missing });

    expect(existsSync(join(dir, 'tree', '.git'))).toBe(true);
    expect((await loadShare(dir))?.kind).toBe('git');
    expect(await gitLog(join(dir, 'tree'))).toMatch(/Share workspace Team/);
    await vi.waitFor(() => expect(service.sync()?.status().error).toBeDefined(), WAIT);
  });

  it('refuses to share a workspace holding a linked project', async () => {
    const outside = join(base, 'linked');
    await saveProject(createProject('Outside'), outside);
    const { root, service } = await newService('a', { dialogs: dialogsPicking(outside) });
    const { dir } = await seedLocal(service, root);
    await service.linkProject(sender);
    await expect(service.share({})).rejects.toMatchObject({ code: 'share-linked-project-refused' });
    await expect(service.shareToFolder(sender)).rejects.toMatchObject({ code: 'share-linked-project-refused' });
    expect(existsSync(join(dir, 'tree'))).toBe(false);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
  });
});

describeGit('WorkspaceService — share to folder', () => {
  it('moves the tree to an empty picked folder and writes share.yaml with its path', async () => {
    const target = join(base, 'synced');
    await mkdir(target);
    const { root, service } = await newService('a', { dialogs: dialogsPicking(target) });
    const { dir } = await seedLocal(service, root);
    const before = await snapshotFiles(join(dir, 'projects'));

    const wire = await service.shareToFolder(sender);

    expect(wire?.name).toBe('Team');
    expect(await loadShare(dir)).toEqual({ version: 1, kind: 'folder', path: target });
    expect(existsSync(join(target, 'workspace.yaml'))).toBe(true);
    expect(await snapshotFiles(join(target, 'projects'))).toEqual(before);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(false);
    expect(existsSync(join(target, 'unsaved'))).toBe(false);
  });

  it('returns null on cancel, refuses a non-empty folder and a folder inside userData', async () => {
    const cancel = await newService('a', { dialogs: dialogsPicking(undefined) });
    await seedLocal(cancel.service, cancel.root);
    expect(await cancel.service.shareToFolder(sender)).toBeNull();

    const full = join(base, 'full');
    await mkdir(full);
    await writeFile(join(full, 'x.txt'), 'x', 'utf8');
    const nonEmpty = await newService('b', { dialogs: dialogsPicking(full) });
    await seedLocal(nonEmpty.service, nonEmpty.root);
    await expect(nonEmpty.service.shareToFolder(sender)).rejects.toMatchObject({ code: 'folder-not-empty' });

    const inside = join(base, 'c', 'inside');
    await mkdir(inside, { recursive: true });
    const contained = await newService('c', { dialogs: dialogsPicking(inside) });
    const { dir } = await seedLocal(contained.service, contained.root);
    await expect(contained.service.shareToFolder(sender)).rejects.toMatchObject({ code: 'share-path-invalid' });
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
  });

  it('falls back to copy-then-remove when rename crosses filesystems (EXDEV)', async () => {
    const target = join(base, 'other-volume');
    await mkdir(target);
    const { cp, rename, rm } = await import('node:fs/promises');
    const renames: string[] = [];
    const { root, service } = await newService('a', {
      dialogs: dialogsPicking(target),
      files: {
        rename: (from: string, to: string) => {
          if (to.startsWith(target)) {
            renames.push(from);
            const error = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
            return Promise.reject(error);
          }
          return rename(from, to);
        },
        cp: (from: string, to: string, options: { recursive: true }) => cp(from, to, options),
        rm: (path: string, options: { recursive: true; force: true }) => rm(path, options),
      },
    });
    const { dir } = await seedLocal(service, root);
    const before = await snapshotFiles(join(dir, 'projects'));

    await service.shareToFolder(sender);

    expect(renames.length).toBeGreaterThan(0);
    expect(await snapshotFiles(join(target, 'projects'))).toEqual(before);
    expect(existsSync(join(dir, 'projects'))).toBe(false);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(false);
    expect(service.snapshot()?.projects).toHaveLength(1);
  });

  it('rolls back a move into the folder that fails part-way', async () => {
    const target = join(base, 'synced');
    await mkdir(target);
    const { root, service } = await newService('a', {
      dialogs: dialogsPicking(target),
      files: {
        ...nodeFileOps,
        rename: (from: string, to: string) =>
          to === join(target, 'projects') ? Promise.reject(errnoError('EACCES')) : nodeFileOps.rename(from, to),
      },
    });
    const { dir } = await seedLocal(service, root);
    const environmentId = await activateEnvironment(service);
    const before = await snapshotFiles(dir);

    await expect(service.shareToFolder(sender)).rejects.toMatchObject({ code: 'EACCES' });

    expect(await snapshotFiles(dir)).toEqual(before);
    expect(await readdir(target)).toEqual([]);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.snapshot()?.activeEnvironmentId).toBe(environmentId);
  });

  it('restores complete projects when an EXDEV move copied but could not remove its source', async () => {
    const target = join(base, 'other-volume');
    await mkdir(target);
    let sourceProjects = '';
    let failed = false;
    const { root, service } = await newService('a', {
      dialogs: dialogsPicking(target),
      files: {
        ...nodeFileOps,
        rename: (from: string, to: string) =>
          to.startsWith(target) ? Promise.reject(errnoError('EXDEV')) : nodeFileOps.rename(from, to),
        rm: async (path: string, options: { readonly recursive: true; readonly force: true }) => {
          if (path === sourceProjects && !failed) {
            // A lock part-way through removing the source: some of it is already gone.
            failed = true;
            await nodeFileOps.rm(join(path, 'Calc', 'attachments'), options);
            throw errnoError('EBUSY');
          }
          await nodeFileOps.rm(path, options);
        },
      },
    });
    const { dir } = await seedLocal(service, root);
    const environmentId = await activateEnvironment(service);
    sourceProjects = join(dir, 'projects');
    const before = await snapshotFiles(dir);

    await expect(service.shareToFolder(sender)).rejects.toMatchObject({
      code: 'workspace-move-incomplete',
      details: { copied: true, sourceRemoved: false },
    });

    expect(failed).toBe(true);
    expect(await snapshotFiles(dir)).toEqual(before);
    expect(await readdir(target)).toEqual([]);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.snapshot()?.projects).toHaveLength(1);
    expect(service.snapshot()?.activeEnvironmentId).toBe(environmentId);
  });
});

describeGit('WorkspaceService — join', () => {
  async function sharedOnA(): Promise<{ id: string; projectId: string }> {
    const { root, service } = await newService('a');
    const { id, projectId } = await seedLocal(service, root);
    await service.share({ remote: remote.url });
    await service.close();
    return { id, projectId };
  }

  it('clones a remote into <id>/tree of a second userData, with the same ids, and opens it', async () => {
    const { id, projectId } = await sharedOnA();
    const { root, service } = await newService('b');

    const wire = await service.join({ remote: remote.url });

    expect(wire.id).toBe(id);
    expect(service.snapshot()?.projects.map((project) => project.id)).toEqual([projectId]);
    const dir = workspaceDir(root, id);
    expect(existsSync(join(dir, 'tree', '.git'))).toBe(true);
    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'git',
      git: { branch: 'main', autoFetchSeconds: 60, commitOnSave: true, pushOnSave: true, remote: remote.url },
    });
    expect(await readdir(join(root, 'workspaces', '.joining'))).toEqual([]);

    await expect(service.join({ remote: remote.url })).rejects.toMatchObject({
      code: 'workspace-already-present',
      details: { workspaceId: id },
    });
    expect(await readdir(join(root, 'workspaces', '.joining'))).toEqual([]);
  });

  it('refuses a bad URL without echoing it, and a missing git', async () => {
    const { service } = await newService('b');
    const error = await service.join({ remote: 'ext::sh -c evil' }).catch((caught: unknown) => caught);
    expect((error as WirebenchError).code).toBe('git-remote-refused');
    expect((error as WirebenchError).message).not.toContain('evil');
    const noGit = await newService('c', { git: () => Promise.resolve(undefined) });
    await expect(noGit.service.join({ remote: remote.url })).rejects.toMatchObject({ code: 'git-not-found' });
  });

  it('empties .joining/ when the service is constructed', async () => {
    const root = join(base, 'd');
    const leftover = join(root, 'workspaces', '.joining', 'crashed');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'workspace.yaml'), 'partial', 'utf8');
    await newService('d');
    await vi.waitFor(() => expect(existsSync(leftover)).toBe(false), WAIT);
  });

  it('joins from an existing clone as kind git with its branch and origin', async () => {
    const { id } = await sharedOnA();
    const clone = join(base, 'my-clone');
    await git.run(undefined, ['clone', '--', remote.url, clone]);
    const { root, service } = await newService('b', { dialogs: dialogsPicking(clone) });

    const wire = await service.joinFromFolder(sender);

    expect(wire?.id).toBe(id);
    expect(await loadShare(workspaceDir(root, id))).toEqual({
      version: 1,
      kind: 'git',
      path: clone,
      git: { branch: 'main', autoFetchSeconds: 60, commitOnSave: true, pushOnSave: true, remote: remote.url },
    });
  });

  it('refuses a clone on a detached HEAD', async () => {
    await sharedOnA();
    const clone = join(base, 'detached');
    await git.run(undefined, ['clone', '--', remote.url, clone]);
    await git.run(clone, ['checkout', '--detach']);
    const { service } = await newService('b', { dialogs: dialogsPicking(clone) });
    const error = await service.joinFromFolder(sender).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'git-branch-refused' });
    expect((error as WirebenchError).message).toMatch(/detached/i);
  });

  it('refuses a clone whose origin is a plain local path, suggesting its file:// form', async () => {
    await sharedOnA();
    const clone = join(base, 'path-clone');
    await git.run(undefined, ['clone', '--', remote.dir, clone]);
    const { service } = await newService('b', { dialogs: dialogsPicking(clone) });

    const error = await service.joinFromFolder(sender).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'git-remote-refused' });
    expect((error as WirebenchError).message).toContain('file://');
    expect((error as WirebenchError).message).not.toContain(remote.dir);
    expect(await service.list()).toEqual([]);
  });

  it('joins a plain folder copy as kind folder; refuses duplicates, folders inside userData and folders without a manifest', async () => {
    const { root: rootA, service: serviceA } = await newService('a');
    const { id, dir } = await seedLocal(serviceA, rootA);
    await serviceA.close();
    const copy = join(base, 'copy');
    const { cp } = await import('node:fs/promises');
    await cp(dir, copy, { recursive: true });

    const { root, service } = await newService('b', { dialogs: dialogsPicking(copy) });
    expect((await service.joinFromFolder(sender))?.id).toBe(id);
    expect(await loadShare(workspaceDir(root, id))).toEqual({ version: 1, kind: 'folder', path: copy });
    await expect(service.joinFromFolder(sender)).rejects.toMatchObject({
      code: 'workspace-already-present',
      details: { workspaceId: id },
    });

    const insideA = await newService('a3', { userDataDir: rootA, dialogs: dialogsPicking(dir) });
    await expect(insideA.service.joinFromFolder(sender)).rejects.toMatchObject({ code: 'share-path-invalid' });

    const empty = join(base, 'empty');
    await mkdir(empty);
    const noManifest = await newService('e', { dialogs: dialogsPicking(empty) });
    await expect(noManifest.service.joinFromFolder(sender)).rejects.toMatchObject({ code: 'workspace-not-found' });
  });
});

describeGit('WorkspaceService — stop sharing', () => {
  it('moves a managed tree back to <dir>, keeps tree/.git, deletes share.yaml and opens as local', async () => {
    const { root, service } = await newService('a');
    const { dir, projectId } = await seedLocal(service, root);
    await service.share({});
    const before = await snapshotFiles(join(dir, 'tree', 'projects'));

    const wire = await service.stopSharing();

    expect(wire.projects.map((project) => project.id)).toEqual([projectId]);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.gitattributes'))).toBe(true);
    expect(await snapshotFiles(join(dir, 'projects'))).toEqual(before);
    expect(existsSync(join(dir, 'tree', '.git'))).toBe(true);
    expect(existsSync(join(dir, 'tree', 'workspace.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(service.sync()).toBeUndefined();
    await expect(service.stopSharing()).rejects.toBeInstanceOf(WirebenchError);
  });

  it('copies an external tree back and leaves the external folder untouched', async () => {
    const target = join(base, 'synced');
    await mkdir(target);
    const { root, service } = await newService('a', { dialogs: dialogsPicking(target) });
    const { dir } = await seedLocal(service, root);
    await service.shareToFolder(sender);
    const external = await snapshotFiles(target);

    await service.stopSharing();

    expect(await snapshotFiles(target)).toEqual(external);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
    expect(await snapshotFiles(join(dir, 'projects'))).toEqual(
      Object.fromEntries(
        Object.entries(external)
          .filter(([path]) => path.startsWith('projects'))
          .map(([path, bytes]) => [relative('projects', path), bytes]),
      ),
    );
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
  });

  it('refuses to stop sharing when the shared folder lost its workspace.yaml', async () => {
    const target = join(base, 'synced');
    await mkdir(target);
    const { root, service } = await newService('a', { dialogs: dialogsPicking(target) });
    const { dir } = await seedLocal(service, root);
    await service.shareToFolder(sender);
    await removeFile(join(target, 'workspace.yaml'));

    const error = await service.stopSharing().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'workspace-tree-missing' });
    expect(existsSync(join(dir, 'share.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'projects'))).toBe(false);
    expect(existsSync(join(target, 'projects'))).toBe(true);
    expect(service.snapshot()).not.toBeNull();
  });

  it('restores share.yaml when reopening fails after it was deleted', async () => {
    const target = join(base, 'synced');
    await mkdir(target);
    const { root, service } = await newService('a', { dialogs: dialogsPicking(target) });
    const { id, dir } = await seedLocal(service, root);
    await service.shareToFolder(sender);
    await writeFile(join(target, 'workspace.yaml'), 'id: [unclosed\n', 'utf8');

    await expect(service.stopSharing()).rejects.toBeInstanceOf(Error);

    expect(await loadShare(dir)).toEqual({ version: 1, kind: 'folder', path: target });
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'projects'))).toBe(false);
    expect((await service.list()).map((row) => row.id)).toContain(id);
  });

  it('refuses linkProject in a shared workspace', async () => {
    const outside = join(base, 'linked');
    await saveProject(createProject('Outside'), outside);
    const { root, service } = await newService('a', { dialogs: dialogsPicking(outside) });
    await seedLocal(service, root);
    await service.share({});
    await expect(service.linkProject(sender)).rejects.toMatchObject({ code: 'share-linked-project-refused' });
  });
});

describeGit('WorkspaceService — move project to workspace, delete', () => {
  it('copies into a closed git workspace keeping ids, appends the ref and removes the source', async () => {
    const { root, service, trashed } = await newService('a');
    const target = await seedLocal(service, root);
    await service.share({});
    const targetTree = join(target.dir, 'tree');
    const source = await service.create('Source');
    const { projectId } = await service.addProject('Payments');
    const sourceDir = workspaceProjectDir(workspaceDir(root, source.id), 'Payments');

    const wire = await service.moveProjectToWorkspace(projectId, target.id);

    expect(wire.id).toBe(source.id);
    expect(wire.projects).toEqual([]);
    expect(trashed).toContain(sourceDir);
    const { workspace } = await loadWorkspace(targetTree);
    expect(workspace.projects.map((ref) => ref.id)).toEqual([target.projectId, projectId]);
    expect(existsSync(join(targetTree, 'projects', 'Payments', 'wirebench.yaml'))).toBe(true);

    await service.open(target.id);
    expect(service.snapshot()?.projects.map((project) => project.id)).toEqual([target.projectId, projectId]);
  });

  it('re-identifies the copy when the target already has the id, and refuses the open workspace as target', async () => {
    const { root, service } = await newService('a');
    const first = await seedLocal(service, root);
    await service.close();
    const { cp } = await import('node:fs/promises');
    const second = await service.create('Second');
    // The same project (same id) copied by hand into the second workspace.
    await cp(join(first.dir, 'projects', 'Calc'), join(workspaceDir(root, second.id), 'projects', 'Calc'), {
      recursive: true,
    });
    await service.close();
    const secondManifest = (await loadWorkspace(workspaceDir(root, second.id))).workspace;
    const { saveWorkspace } = await import('@wirebench/engine');
    await saveWorkspace(
      { ...secondManifest, projects: [{ id: first.projectId, slug: 'Calc', source: 'internal' }] },
      workspaceDir(root, second.id),
    );
    await service.open(second.id);

    await expect(service.moveProjectToWorkspace(first.projectId, second.id)).rejects.toMatchObject({
      code: 'workspace-move-same',
    });

    await service.moveProjectToWorkspace(first.projectId, first.id);

    const { workspace } = await loadWorkspace(first.dir);
    expect(workspace.projects).toHaveLength(2);
    const [kept, copied] = workspace.projects;
    expect(kept?.id).toBe(first.projectId);
    expect(copied?.id).not.toBe(first.projectId);
    expect(copied?.slug).not.toBe(kept?.slug);
    expect(existsSync(join(workspaceProjectDir(first.dir, copied?.slug ?? ''), 'attachments', 'blob.bin'))).toBe(true);
  });

  it('delete trashes a managed git workspace dir whole, and only <id> for an external folder', async () => {
    const managed = await newService('a');
    const m = await seedLocal(managed.service, managed.root);
    await managed.service.share({});
    await managed.service.delete(m.id);
    expect(managed.trashed).toEqual([m.dir]);

    const target = join(base, 'synced');
    await mkdir(target);
    const folder = await newService('b', { dialogs: dialogsPicking(target) });
    const f = await seedLocal(folder.service, folder.root);
    await folder.service.shareToFolder(sender);
    await folder.service.delete(f.id);
    expect(folder.trashed).toEqual([f.dir]);
    expect(existsSync(join(target, 'workspace.yaml'))).toBe(true);
  });
});

describeGit('WorkspaceService — sync settings and status', () => {
  it('validates branch/remote before saving, and refuses without touching share.yaml', async () => {
    const { root, service } = await newService('a');
    const { dir } = await seedLocal(service, root);
    await service.share({ remote: remote.url, branch: 'main' });
    const before = await loadShare(dir);

    await expect(service.updateSyncSettings({ branch: '-evil' })).rejects.toBeInstanceOf(WirebenchError);
    await expect(service.updateSyncSettings({ remote: '-oProxyCommand=evil host:repo' })).rejects.toBeInstanceOf(
      WirebenchError,
    );
    expect(await loadShare(dir)).toEqual(before);
  });

  it('persists a trimmed remote to share.yaml and re-arms the sync service', async () => {
    const { root, service } = await newService('a');
    const { dir } = await seedLocal(service, root);
    await service.share({ branch: 'main' });
    const applySettings = vi.spyOn(SyncService.prototype, 'applySettings');

    await service.updateSyncSettings({ remote: `  ${remote.url}  `, autoFetchSeconds: 120 });

    expect(await loadShare(dir)).toMatchObject({
      git: { remote: remote.url, autoFetchSeconds: 120, branch: 'main' },
    });
    expect(applySettings).toHaveBeenCalled();
    applySettings.mockRestore();
  });

  it('leaves the live settings unchanged when the save fails', async () => {
    // Armed only after the initial share has finished — `share()` writes `share.yaml` too, and
    // that write must succeed for the test to have something to leave unchanged.
    let armed = false;
    const failingFs = {
      ...nodeFs,
      writeFile: (path: string, data: Buffer | string) =>
        armed && path.includes('share.yaml') ? Promise.reject(new Error('EIO')) : nodeFs.writeFile(path, data),
    };
    const { root, service } = await newService('a', { fs: failingFs });
    const { dir } = await seedLocal(service, root);
    await service.share({ branch: 'main' });
    const before = await loadShare(dir);
    // `SyncService.status()` only reflects the cached result of a `probe()`/`fetch()` — never
    // `open.share` or `applySettings()` directly — so it cannot tell an in-memory-only mutation
    // apart from a fully persisted one. `snapshot().share`, by contrast, is built straight from
    // `open.share` (see `shareWire` in `workspace-service.ts`), so it is what actually observes
    // whether the in-memory settings were mutated before or after the write settled.
    const branchBefore = service.snapshot()?.share?.branch;
    expect(branchBefore).toBe('main');
    armed = true;

    await expect(service.updateSyncSettings({ branch: 'other', autoFetchSeconds: 0 })).rejects.toThrow('EIO');

    expect(await loadShare(dir)).toEqual(before);
    expect(service.snapshot()?.share?.branch).toBe(branchBefore);
  });

  it('refuses settings on a folder share with sync-not-supported', async () => {
    const target = join(base, 'synced');
    await mkdir(target);
    const { root, service } = await newService('a', { dialogs: dialogsPicking(target) });
    await seedLocal(service, root);
    await service.shareToFolder(sender);

    await expect(service.updateSyncSettings({ branch: 'main' })).rejects.toMatchObject({
      code: 'sync-not-supported',
    });
  });

  it('answers a synthetic local status for an unshared workspace', async () => {
    const { root, service } = await newService('a');
    await seedLocal(service, root);

    expect(service.syncStatus()).toEqual({
      kind: 'local',
      gitAvailable: true,
      state: 'clean',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
    });
  });

  it('fills share on list()/snapshot() — managed for a git clone, unmanaged for an external folder', async () => {
    const gitShare = await newService('a');
    await seedLocal(gitShare.service, gitShare.root);
    await gitShare.service.share({ remote: remote.url, branch: 'main' });

    expect(gitShare.service.snapshot()?.share).toEqual({
      kind: 'git',
      managed: true,
      remote: remote.url,
      branch: 'main',
    });
    const gitRow = (await gitShare.service.list()).find((row) => row.id === gitShare.service.snapshot()?.id);
    expect(gitRow?.share).toEqual({ kind: 'git', managed: true, remote: remote.url, branch: 'main' });

    const target = join(base, 'synced');
    await mkdir(target);
    const folderShare = await newService('b', { dialogs: dialogsPicking(target) });
    await seedLocal(folderShare.service, folderShare.root);
    await folderShare.service.shareToFolder(sender);

    expect(folderShare.service.snapshot()?.share).toEqual({ kind: 'folder', managed: false });
    const folderRow = (await folderShare.service.list()).find((row) => row.id === folderShare.service.snapshot()?.id);
    expect(folderRow?.share).toEqual({ kind: 'folder', managed: false });
  });
});

// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GIT_SHARE_SETTINGS, DEFAULT_SYNC_SETTINGS, GitCli } from '@wirebench/engine';
import type { Runner, WorkspaceShare } from '@wirebench/engine';
import { ServerClient } from '../../src/main/server-client.js';
import { createSyncBackend } from '../../src/main/sync/create-backend.js';
import { FolderBackend } from '../../src/main/sync/folder-backend.js';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { ServerBackend } from '../../src/main/sync/server-backend.js';
import { SERVER_STATE_DIR, ServerState } from '../../src/main/sync/server-state.js';

/**
 * A `GitCli` whose local-config listing answers `names` (newline-separated here, NUL-terminated on
 * the wire) and whose `remote.*.url` read answers an allowed URL; every call is recorded.
 */
function gitWithLocalConfig(
  names: string,
  seen: string[][] = [],
  listing: { exitCode: number; stderr: string } = { exitCode: 0, stderr: '' },
): GitCli {
  const run: Runner = (_file, fullArgs) => {
    if (fullArgs.includes('core.sshCommand')) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
    }
    const args = fullArgs.slice(6);
    seen.push([...args]);
    if (args.includes('--list')) {
      const stdout = names
        .split('\n')
        .filter((name) => name.length > 0)
        .map((name) => `${name}\0`)
        .join('');
      return Promise.resolve({ stdout, ...listing });
    }
    if (args.includes('--get-regexp')) {
      return Promise.resolve({ stdout: 'remote.origin.url\nhttps://example.test/team.git\0', stderr: '', exitCode: 0 });
    }
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  };
  return new GitCli({ path: '/usr/bin/git', version: '2.45.0' }, { hooksDir: '/nonexistent-hooks', run });
}

const git = gitWithLocalConfig('core.bare\ncore.filemode\nremote.origin.url\n');
const settings = (): typeof DEFAULT_GIT_SHARE_SETTINGS => DEFAULT_GIT_SHARE_SETTINGS;
const gitShare: WorkspaceShare = { version: 1, kind: 'git', git: DEFAULT_GIT_SHARE_SETTINGS };
const folderShare: WorkspaceShare = { version: 1, kind: 'folder', path: '/shared/team' };

const serverShare: WorkspaceShare = {
  version: 1,
  kind: 'server',
  server: { ...DEFAULT_SYNC_SETTINGS, url: 'https://sync.example.test', workspaceId: '01J8Z0000000000000000000AB' },
};

describe('createSyncBackend', () => {
  it('a git share with git found is a GitBackend', async () => {
    const backend = await createSyncBackend({ share: gitShare, tree: '/t', git: () => Promise.resolve(git), settings });
    expect(backend).toBeInstanceOf(GitBackend);
  });

  it('a git share without git reports git-not-found instead of failing', async () => {
    for (const locate of [undefined, () => Promise.resolve(undefined), () => Promise.reject(new Error('boom'))]) {
      const backend = await createSyncBackend({ share: gitShare, tree: '/t', git: locate, settings });
      expect(backend).toBeInstanceOf(FolderBackend);
      await expect(backend.probe()).resolves.toMatchObject({
        kind: 'git',
        gitAvailable: false,
        state: 'error',
        error: { code: 'git-not-found' },
      });
    }
  });

  it('a folder share is a FolderBackend unless the folder is a git clone and git is found', async () => {
    const plain = await createSyncBackend({
      share: folderShare,
      tree: '/t',
      git: () => Promise.resolve(git),
      settings,
      exists: () => false,
    });
    expect(plain).toBeInstanceOf(FolderBackend);
    await expect(plain.probe()).resolves.toMatchObject({ kind: 'folder', state: 'clean' });

    const clone = await createSyncBackend({
      share: folderShare,
      tree: '/t',
      git: () => Promise.resolve(git),
      settings,
      exists: (path) => path.endsWith('.git'),
    });
    expect(clone).toBeInstanceOf(GitBackend);

    const cloneWithoutGit = await createSyncBackend({
      share: folderShare,
      tree: '/t',
      git: () => Promise.resolve(undefined),
      settings,
      exists: () => true,
    });
    expect(cloneWithoutGit).toBeInstanceOf(FolderBackend);
  });

  it('a git share whose .git/config sets a refused key reports git-config-refused, running nothing else', async () => {
    const seen: string[][] = [];
    const hostile = gitWithLocalConfig('core.bare\ncore.fsmonitor\n', seen);
    const backend = await createSyncBackend({
      share: gitShare,
      tree: '/t',
      git: () => Promise.resolve(hostile),
      settings,
    });

    expect(backend).toBeInstanceOf(FolderBackend);
    await expect(backend.probe()).resolves.toMatchObject({
      kind: 'git',
      state: 'error',
      error: { code: 'git-config-refused' },
    });
    expect(seen).toEqual([['config', '--local', '--list', '--name-only', '-z']]);
  });

  it('a folder share holding a repository with a refused key is not upgraded to git', async () => {
    const hostile = gitWithLocalConfig('filter.x.smudge\n');
    const backend = await createSyncBackend({
      share: folderShare,
      tree: '/t',
      git: () => Promise.resolve(hostile),
      settings,
      exists: (path) => path.endsWith('.git'),
    });

    expect(backend).toBeInstanceOf(FolderBackend);
    await expect(backend.probe()).resolves.toMatchObject({ state: 'error', error: { code: 'git-config-refused' } });
  });

  it('a git share whose tree is not a repository reports git-not-a-repository', async () => {
    const notARepo = gitWithLocalConfig('', [], {
      exitCode: 128,
      stderr: 'fatal: --local can only be used inside a git repository',
    });
    const backend = await createSyncBackend({
      share: gitShare,
      tree: '/t',
      git: () => Promise.resolve(notARepo),
      settings,
    });

    expect(backend).toBeInstanceOf(FolderBackend);
    await expect(backend.probe()).resolves.toMatchObject({
      kind: 'git',
      state: 'error',
      error: { code: 'git-not-a-repository', message: 'This folder is not a git repository.' },
    });
  });

  it('a server share without the server services, or without its dir, reports sync-not-supported', async () => {
    const services = {
      client: new ServerClient({ send: () => Promise.reject(new Error('no network here')) }),
      accounts: { tokenFor: () => Promise.resolve('t0k'), markSignedOut: () => undefined, list: () => [] },
    };
    for (const extra of [{}, { server: services }, { dir: '/w' }]) {
      const backend = await createSyncBackend({ share: serverShare, tree: '/t', git: undefined, settings, ...extra });
      expect(backend).toBeInstanceOf(FolderBackend);
      await expect(backend.probe()).resolves.toMatchObject({
        kind: 'server',
        gitAvailable: false,
        state: 'error',
        error: { code: 'sync-not-supported' },
      });
    }
  });

  it('a server share is a ServerBackend keeping its state in <dir>/server, built without a network call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-create-backend-'));
    try {
      const tree = join(dir, 'tree');
      await mkdir(tree, { recursive: true });
      await ServerState.initialize(join(dir, SERVER_STATE_DIR), null, new Map());
      const send = vi.fn(() => Promise.reject(new Error('no network in this test')));
      const tokenFor = vi.fn(() => Promise.resolve('t0k'));

      const backend = await createSyncBackend({
        share: serverShare,
        tree,
        git: undefined,
        settings,
        dir,
        server: {
          client: new ServerClient({ send }),
          accounts: { tokenFor, markSignedOut: () => undefined, list: () => [] },
        },
      });

      expect(backend).toBeInstanceOf(ServerBackend);
      expect(backend.kind).toBe('server');
      // `probe` is local (§3.1): it reads the state initialised above, so this also proves the dir.
      await expect(backend.probe()).resolves.toMatchObject({
        kind: 'server',
        gitAvailable: true,
        state: 'clean',
        ahead: 0,
        uncommitted: 0,
        remote: 'https://sync.example.test',
      });
      expect(send).not.toHaveBeenCalled();
      expect(tokenFor).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

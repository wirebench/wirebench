// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_GIT_SHARE_SETTINGS } from '@wirebench/engine';
import type { WorkspaceShare } from '@wirebench/engine';
import { createSyncBackend } from '../../src/main/sync/create-backend.js';
import { FolderBackend } from '../../src/main/sync/folder-backend.js';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { GitCli } from '../../src/main/sync/git-cli.js';
import type { Runner } from '../../src/main/sync/git-cli.js';

/** A `GitCli` whose `config --local --list --name-only` answers `names`; every other call is recorded and succeeds. */
function gitWithLocalConfig(names: string, seen: string[][] = []): GitCli {
  const run: Runner = (_file, fullArgs) => {
    if (fullArgs.includes('core.sshCommand')) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
    }
    const args = fullArgs.slice(6);
    seen.push([...args]);
    const listing = args[0] === 'config' && args.includes('--local');
    return Promise.resolve({ stdout: listing ? names : '', stderr: '', exitCode: 0 });
  };
  return new GitCli({ path: '/usr/bin/git', version: '2.45.0' }, { hooksDir: '/nonexistent-hooks', run });
}

const git = gitWithLocalConfig('core.bare\ncore.filemode\nremote.origin.url\n');
const settings = (): typeof DEFAULT_GIT_SHARE_SETTINGS => DEFAULT_GIT_SHARE_SETTINGS;
const gitShare: WorkspaceShare = { version: 1, kind: 'git', git: DEFAULT_GIT_SHARE_SETTINGS };
const folderShare: WorkspaceShare = { version: 1, kind: 'folder', path: '/shared/team' };

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
    const backend = await createSyncBackend({ share: gitShare, tree: '/t', git: () => Promise.resolve(hostile), settings });

    expect(backend).toBeInstanceOf(FolderBackend);
    await expect(backend.probe()).resolves.toMatchObject({
      kind: 'git',
      state: 'error',
      error: { code: 'git-config-refused' },
    });
    expect(seen).toEqual([['config', '--local', '--list', '--name-only']]);
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

  it('a server share is a FolderBackend placeholder reporting kind server', async () => {
    const backend = await createSyncBackend({
      share: { version: 1, kind: 'server', server: { url: 'https://sync.example.test', workspaceId: 'w1' } },
      tree: '/t',
      git: undefined,
      settings,
    });
    expect(backend).toBeInstanceOf(FolderBackend);
    await expect(backend.probe()).resolves.toMatchObject({ kind: 'server', gitAvailable: false, state: 'clean' });
  });
});

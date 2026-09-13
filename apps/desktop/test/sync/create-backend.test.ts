// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_GIT_SHARE_SETTINGS } from '@wirebench/engine';
import type { WorkspaceShare } from '@wirebench/engine';
import { createSyncBackend } from '../../src/main/sync/create-backend.js';
import { FolderBackend } from '../../src/main/sync/folder-backend.js';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { GitCli } from '../../src/main/sync/git-cli.js';

const git = new GitCli({ path: '/usr/bin/git', version: '2.45.0' }, { hooksDir: '/nonexistent-hooks' });
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

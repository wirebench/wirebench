import { rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../../src/errors.js';
import {
  DEFAULT_GIT_SHARE_SETTINGS,
  deleteShare,
  loadShare,
  saveShare,
  type WorkspaceShare,
} from '../../../src/workspace/share.js';
import { tempWorkspaceDir } from './fixture.js';

describe('share.yaml', () => {
  it('is undefined when the file does not exist (a local workspace)', async () => {
    const dir = await tempWorkspaceDir();
    expect(await loadShare(dir)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a folder share', async () => {
    const dir = await tempWorkspaceDir();
    const share: WorkspaceShare = { version: 1, kind: 'folder', path: '/Users/me/code/team-apis' };
    await saveShare(dir, share);

    expect(await loadShare(dir)).toEqual(share);

    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a git share, managed tree (no path)', async () => {
    const dir = await tempWorkspaceDir();
    const share: WorkspaceShare = {
      version: 1,
      kind: 'git',
      git: { ...DEFAULT_GIT_SHARE_SETTINGS, remote: 'git@gitlab.example.com:team/apis.git' },
    };
    await saveShare(dir, share);

    expect(await loadShare(dir)).toEqual(share);

    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a server share', async () => {
    const dir = await tempWorkspaceDir();
    const share: WorkspaceShare = {
      version: 1,
      kind: 'server',
      server: { url: 'https://sync.example.test', workspaceId: 'ws-1' },
    };
    await saveShare(dir, share);

    expect(await loadShare(dir)).toEqual(share);

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects kind: git with no git block as workspace-file-invalid', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'share.yaml'), 'version: 1\nkind: git\n');

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe('workspace-file-invalid');

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects kind: server with no server block as workspace-file-invalid', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'share.yaml'), 'version: 1\nkind: server\n');

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect((error as WorkspaceError).code).toBe('workspace-file-invalid');

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a relative path as workspace-file-invalid', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'share.yaml'), 'version: 1\nkind: folder\npath: relative/dir\n');

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect((error as WorkspaceError).code).toBe('workspace-file-invalid');

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects malformed YAML as workspace-file-invalid', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'share.yaml'), 'kind: [unclosed\n');

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect((error as WorkspaceError).code).toBe('workspace-file-invalid');

    await rm(dir, { recursive: true, force: true });
  });

  it('deleteShare removes the file, and is a no-op when there is none', async () => {
    const dir = await tempWorkspaceDir();
    await saveShare(dir, { version: 1, kind: 'folder', path: '/x' });
    expect(existsSync(join(dir, 'share.yaml'))).toBe(true);

    await deleteShare(dir);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    await expect(deleteShare(dir)).resolves.toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});

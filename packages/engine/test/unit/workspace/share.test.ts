import { rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../../src/errors.js';
import {
  DEFAULT_GIT_SHARE_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  deleteShare,
  loadShare,
  saveShare,
  shareSyncSettings,
  type WorkspaceShare,
} from '../../../src/workspace/share.js';
import { tempWorkspaceDir } from './fixture.js';

/** A ULID, as the server mints workspace ids (TEAMS_ID_PATTERN). */
const WORKSPACE_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

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

  it('round-trips a server share with every field', async () => {
    const dir = await tempWorkspaceDir();
    const share: WorkspaceShare = {
      version: 1,
      kind: 'server',
      server: {
        url: 'https://wirebench.example.com',
        workspaceId: WORKSPACE_ID,
        teamName: 'Payments QA',
        autoFetchSeconds: 120,
        commitOnSave: false,
        pushOnSave: false,
      },
    };
    await saveShare(dir, share);

    expect(await loadShare(dir)).toEqual(share);

    await rm(dir, { recursive: true, force: true });
  });

  it('gives a server block the git defaults, and no team name, when they are absent', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'share.yaml'),
      `version: 1\nkind: server\nserver:\n  url: http://127.0.0.1:4000\n  workspaceId: ${WORKSPACE_ID}\n`,
    );

    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'server',
      server: { url: 'http://127.0.0.1:4000', workspaceId: WORKSPACE_ID, ...DEFAULT_SYNC_SETTINGS },
    });
    expect(DEFAULT_SYNC_SETTINGS).toEqual({ autoFetchSeconds: 60, commitOnSave: true, pushOnSave: true });
    expect(DEFAULT_GIT_SHARE_SETTINGS).toEqual({ ...DEFAULT_SYNC_SETTINGS, branch: 'main' });

    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a workspace id that is not a ULID', 'https://wirebench.example.com', 'ws-1', 'server.workspaceId'],
    ['a lower-case ULID', 'https://wirebench.example.com', WORKSPACE_ID.toLowerCase(), 'server.workspaceId'],
    ['a url with a path', 'https://wirebench.example.com/api', WORKSPACE_ID, 'server.url'],
    ['a url with a trailing slash', 'https://wirebench.example.com/', WORKSPACE_ID, 'server.url'],
    ['a url with a query', 'https://wirebench.example.com?team=qa', WORKSPACE_ID, 'server.url'],
    ['a url that is not http(s)', 'ftp://wirebench.example.com', WORKSPACE_ID, 'server.url'],
    ['a url with no scheme', 'wirebench.example.com', WORKSPACE_ID, 'server.url'],
  ])('refuses %s as workspace-file-invalid', async (_name, url, workspaceId, issuePath) => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'share.yaml'),
      `version: 1\nkind: server\nserver:\n  url: ${url}\n  workspaceId: ${workspaceId}\n`,
    );

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toMatchObject({ code: 'workspace-file-invalid', details: { issues: [{ path: issuePath }] } });

    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a path on a server share: its tree is always the managed one', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'share.yaml'),
      `version: 1\nkind: server\npath: /Users/me/team-apis\nserver:\n  url: https://wirebench.example.com\n  workspaceId: ${WORKSPACE_ID}\n`,
    );

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'workspace-file-invalid', details: { issues: [{ path: 'path' }] } });

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

describe('shareSyncSettings', () => {
  const settings = { autoFetchSeconds: 30, commitOnSave: false, pushOnSave: true };

  it('is the three sync settings of a git or a server share, whichever it is', () => {
    expect(
      shareSyncSettings({
        version: 1,
        kind: 'git',
        git: { ...settings, branch: 'main', remote: 'https://git.example.com/team/apis.git' },
      }),
    ).toEqual(settings);
    expect(
      shareSyncSettings({
        version: 1,
        kind: 'server',
        server: { ...settings, url: 'https://wirebench.example.com', workspaceId: WORKSPACE_ID, teamName: 'QA' },
      }),
    ).toEqual(settings);
  });

  it('is undefined for a folder share, or a share missing its block', () => {
    expect(shareSyncSettings({ version: 1, kind: 'folder', path: '/Users/me/team-apis' })).toBeUndefined();
    expect(shareSyncSettings({ version: 1, kind: 'git' })).toBeUndefined();
  });
});

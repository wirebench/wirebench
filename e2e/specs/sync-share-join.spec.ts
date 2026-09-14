import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBareRemote, remoteFiles } from '../helpers/git-remote.js';
import { expectExplorerRow, workspaceProjectDir } from '../helpers/project.js';
import {
  addActiveEnvironment,
  joinSharedWorkspace,
  openWorkspaceId,
  sharedProjectDir,
  sharedTreeDir,
  sharedWorkspaceId,
  startSharedWorkspace,
  stopSharingWorkspace,
  SyncProfiles,
  syncBadge,
  SYNC_TIMEOUT,
  treeFiles,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** The project ids a workspace manifest lists (`- id: …` / `id: …` lines under `projects`). */
function manifestIds(tree: string): string[] {
  return [...readFileSync(join(tree, 'workspace.yaml'), 'utf8').matchAll(/^\s*-?\s*id:\s*['"]?([^'"\s]+)/gm)].map(
    (match) => match[1] as string,
  );
}

/**
 * Sharing and joining across two profiles. A shares a workspace with a project and an active
 * environment to a bare remote in a temp folder: the remote holds exactly A's shared tree and
 * none of A's machine-local files. B joins by URL and gets the same workspace and project, stored
 * under `<id>/tree/projects`; stopping sharing in B keeps the project, as a local workspace.
 */
test.describe('shared workspaces: share and join', () => {
  let profiles = new SyncProfiles();
  let server: TestSoapServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    try {
      await current.dispose();
    } finally {
      await server?.close();
      server = undefined;
    }
  });

  test('the remote holds exactly the shared tree, a second profile joins it, and stopping sharing keeps the project', async () => {
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    profiles.track(remote.dir);

    // --- A shares a workspace that has machine-local state (an active environment) -----------
    const a = await profiles.launch();
    await startSharedWorkspace(a.window, server, remote, {
      beforeShare: (page) => addActiveEnvironment(page, 'region', 'eu-west'),
    });
    const treeA = sharedTreeDir(a.userDataDir);
    const appDirA = dirname(treeA);
    await expect
      .poll(() => JSON.stringify(remoteFiles(remote.dir).sort()) === JSON.stringify(treeFiles(treeA)), {
        timeout: SYNC_TIMEOUT,
      })
      .toBe(true);
    const files = remoteFiles(remote.dir).sort();
    expect(files).toEqual(treeFiles(treeA));
    expect(files).toContain('workspace.yaml');
    expect(files).toContain('.gitattributes');
    expect(files.some((file) => file.startsWith('environments/'))).toBe(true);
    expect(files.some((file) => file.startsWith('projects/'))).toBe(true);
    // A's machine-local files exist on A's disk, beside the tree — and never reach the remote.
    expect(existsSync(join(appDirA, 'local.yaml'))).toBe(true);
    expect(existsSync(join(appDirA, 'share.yaml'))).toBe(true);
    expect(files.filter((file) => /(^|\/)(local|share)\.yaml$/.test(file) || file.startsWith('unsaved/'))).toEqual([]);
    // A shared workspace keeps its projects inside the tree, so linking a folder is disabled.
    await expect(a.window.getByTestId('explorer-link-project')).toBeDisabled();

    // --- B joins: the same workspace and project ids, stored under <id>/tree/projects ----------
    const b = await profiles.launch();
    await joinSharedWorkspace(b.window, remote.url);
    await expect(b.window.getByTestId('title-bar')).toContainText('Workspace 1');
    await expectExplorerRow(
      b.window.getByTestId('explorer-project-row').filter({ hasText: 'Calculator Project' }),
      b.window,
    );
    const workspaceIdA = await openWorkspaceId(a.window);
    expect(await openWorkspaceId(b.window)).toBe(workspaceIdA);
    expect(sharedWorkspaceId(a.userDataDir)).toBe(workspaceIdA);
    expect(sharedWorkspaceId(b.userDataDir)).toBe(workspaceIdA);
    const treeB = sharedTreeDir(b.userDataDir);
    expect(manifestIds(treeB)).toEqual(manifestIds(treeA));
    expect(manifestIds(treeB)).toContain(workspaceIdA);

    const projectDir = sharedProjectDir(b.userDataDir);
    const segments = relative(join(b.userDataDir, 'workspaces'), projectDir).split(sep);
    expect(segments).toHaveLength(4);
    expect(segments.slice(0, 3)).toEqual([workspaceIdA, 'tree', 'projects']);
    expect(segments[3]).toBe(relative(join(treeA, 'projects'), sharedProjectDir(a.userDataDir)));
    expect(existsSync(join(projectDir, 'wirebench.yaml'))).toBe(true);

    // --- B stops sharing: the project stays, the badge goes, files move back to <id>/projects ---
    await stopSharingWorkspace(b.window);
    await expect(syncBadge(b.window)).toHaveCount(0);
    await expectExplorerRow(
      b.window.getByTestId('explorer-project-row').filter({ hasText: 'Calculator Project' }),
      b.window,
    );
    expect(existsSync(join(workspaceProjectDir(b.userDataDir), 'wirebench.yaml'))).toBe(true);
    // The repository is left behind for the user to delete.
    expect(existsSync(join(dirname(treeB), 'tree', '.git'))).toBe(true);
  });
});

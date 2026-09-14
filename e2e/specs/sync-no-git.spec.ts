import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createProject as engineCreateProject,
  createWorkspace as engineCreateWorkspace,
  saveProject,
  saveWorkspace,
  workspaceProjectDir as engineWorkspaceProjectDir,
} from '@wirebench/engine';
import { ADA, gitConfigEnv } from '../helpers/git-remote.js';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace, expectExplorerRow } from '../helpers/project.js';
import { closeManageWorkspaces, openManageWorkspaces, syncBadge } from '../helpers/sync.js';

/** What main says when there is no git to run (`GIT_NOT_FOUND_ERROR`, `main/sync/create-backend.ts`). */
const GIT_NOT_FOUND = 'git was not found on this machine. Install git, or choose it in Settings.';

/**
 * A machine without git. `WIREBENCH_E2E_GIT_PATH` points main's git lookup at a path that does not
 * exist: sharing as a git repository is refused in words and the workspace stays local, while a
 * plain synced-folder copy — which needs no git at all — can still be joined.
 */
test.describe('shared workspaces without git', () => {
  let launched: LaunchedApp | undefined;
  let dirs: string[] = [];

  const NO_GIT_ENV = { ...gitConfigEnv(ADA), WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    for (const dir of dirs) {
      removeDirSync(dir);
    }
    dirs = [];
  });

  test('sharing as git shows git-not-found and leaves the workspace local', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-no-git-'));
    dirs = [userDataDir];
    launched = await launchApp({ userDataDir, keepUserDataDir: true, extraEnv: NO_GIT_ENV });
    const page = launched.window;
    await createWorkspace(page);

    const manage = await openManageWorkspaces(page);
    await manage.getByTestId('workspace-share').click();
    const dialog = page.getByTestId('workspace-share-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('share-kind-git').check();
    await dialog.getByTestId('share-confirm').click();
    await expect(page.getByText(GIT_NOT_FOUND).first()).toBeVisible({ timeout: 20_000 });

    // The dialog stays up for another try; cancelling it leaves a local workspace behind.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(manage.getByTestId('workspace-share')).toBeVisible();
    await closeManageWorkspaces(page);
    await expect(syncBadge(page)).toHaveCount(0);
    await expect(page.getByTestId('explorer-link-project')).toBeEnabled();

    const workspaces = join(userDataDir, 'workspaces');
    for (const id of readdirSync(workspaces)) {
      expect(existsSync(join(workspaces, id, 'share.yaml')), `${id} must not be shared`).toBe(false);
      expect(existsSync(join(workspaces, id, 'tree')), `${id} must keep its tree in place`).toBe(false);
    }
  });

  test('joining a plain synced-folder copy works without git', async () => {
    // A workspace tree outside the profile with no `.git` — what a file-sync tool delivers.
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'wirebench-e2e-synced-folder-')));
    const userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-no-git-'));
    dirs = [folder, userDataDir];
    const workspace = engineCreateWorkspace('Folder Workspace');
    const project = engineCreateProject('Folder Project');
    const slug = 'folder-project';
    const projectDir = engineWorkspaceProjectDir(folder, slug);
    mkdirSync(projectDir, { recursive: true });
    await saveProject(project, projectDir);
    await saveWorkspace({ ...workspace, projects: [{ id: project.id, slug, source: 'internal' }] }, folder);

    launched = await launchApp({ userDataDir, keepUserDataDir: true, folderDialogPath: folder, extraEnv: NO_GIT_ENV });
    const page = launched.window;
    await page.getByTestId('workspace-join').click();
    const dialog = page.getByTestId('workspace-join-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('join-from-folder').click();

    await expect(page.getByTestId('activity-bar')).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('title-bar')).toContainText('Folder Workspace');
    await expectExplorerRow(page.getByTestId('explorer-project-row').filter({ hasText: 'Folder Project' }), page);
    // A folder share: the badge names it as such, whatever git there is or is not.
    await expect(syncBadge(page)).toContainText('Synced folder', { timeout: 20_000 });
    await expect(page.getByTestId('explorer-link-project')).toBeDisabled();
    // The folder stays where it is; the profile only records where to find it.
    expect(existsSync(join(folder, '.git'))).toBe(false);
  });
});

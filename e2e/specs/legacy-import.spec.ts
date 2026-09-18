/**
 * Importing a legacy single-XML SOAP project, end to end.
 *
 * The unit suites prove the parse, the mapping and the host; what only the real app can prove is the
 * whole gesture: the file is picked in the unified Import dialog, the report comes back, and the
 * saved requests the file held are rows in the explorer — resolved from the file's own copy of the
 * definitions, with no network.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expandExplorer, workspaceProjectDir } from '../helpers/project.js';
import { chooseContextMenuItem } from '../helpers/rest.js';

const FULL_FIXTURE = fileURLToPath(new URL('../../fixtures/legacy-soap-project/full.xml', import.meta.url));

test.describe('legacy SOAP project import', () => {
  let launched: LaunchedApp | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = undefined;
    }
  });

  test('imports a whole project file into the selected project and lists what it left behind', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Billing');

    // A renderer-named path is read only inside a project folder or after a Browse… pick, so the
    // file goes into the project first.
    const projectDir = workspaceProjectDir(userDataDir);
    const legacyPath = join(projectDir, 'billing-project.xml');
    copyFileSync(FULL_FIXTURE, legacyPath);

    await chooseContextMenuItem(page, page.getByTestId('explorer-project-row').first(), 'Import…');
    await page.getByTestId('import-format-select').selectOption('legacy-soap-project');
    await page.getByRole('tab', { name: 'File' }).click();
    await page.getByTestId('import-file-input').fill(legacyPath);
    await page.getByTestId('import-submit').click();

    await expect(page.getByTestId('import-legacy-summary')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-legacy-counts')).toContainText('2 interfaces, 6 requests');
    await expect(page.getByTestId('import-legacy-warnings')).toContainText('The password was not imported');
    await page.getByTestId('import-done').click();

    await expandExplorer(page, 'Staging with auth');
    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Echo with header' })).toBeVisible();
    expect(existsSync(join(projectDir, 'imported-scripts', 'afterLoadScript.groovy'))).toBe(true);
  });
});

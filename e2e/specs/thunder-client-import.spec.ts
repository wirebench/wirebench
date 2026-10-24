/**
 * Importing a Thunder Client `thunder-tests` folder, end to end.
 *
 * The unit suites prove the reader, the conversion, placing and the dialog; what only the real app
 * can prove is that a folder picked with Folder… is told apart from a folder collection in main,
 * walked and placed: a REST API whose server is the collection's base URL, and the folder's
 * environment in the workspace's Environments view.
 */
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, openApiSettingsTab, restRequestRow, unfoldRow } from '../helpers/rest.js';

/** A folder with `collections/tc_col_api.json`, `environments/tc_env_dev.json` and a backup to skip. */
const FOLDER = fileURLToPath(new URL('../../fixtures/thunder-client/crafted/folder-v3', import.meta.url));

test.describe('Thunder Client import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('picks a thunder-tests folder and shows its base URL as the server', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Clients');

    // Folder… goes through main's own folder dialog, stubbed here to the fixture folder.
    await launched.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, FOLDER);

    await openImportDialog(page);
    await page.getByRole('tab', { name: 'File' }).click();
    await page.getByTestId('import-browse-folder').click();
    await expect(page.getByTestId('detected-format-badge')).toHaveText('Thunder Client collection', {
      timeout: 20_000,
    });
    await page.getByTestId('import-submit').click();

    await expect(page.getByTestId('import-client-summary')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-client-counts')).toContainText('1 request');
    await page.getByTestId('import-done').click();

    await expect(apiRow(page, 'Auth')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Auth').dblclick();
    await expect(page.getByTestId('api-tab')).toBeVisible({ timeout: 20_000 });
    await openApiSettingsTab(page, 'General');
    await expect(page.getByTestId('api-base-url')).toHaveValue('http://localhost:5000/api');
    await unfoldRow(apiRow(page, 'Auth'));
    await expect(restRequestRow(page, 'login')).toBeVisible({ timeout: 20_000 });

    await openEnvironmentsView(page);
    await expect(environmentRow(page, 'Dev')).toBeVisible({ timeout: 20_000 });
  });
});

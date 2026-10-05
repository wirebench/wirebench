/**
 * Importing a `.http` request file, end to end.
 *
 * The unit suites prove the parser, the mapping and the dialog; what only the real app can prove is
 * that pasted requests reach main, land as a REST API in the project, and show in the explorer under
 * the names the file gave them.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, restRequestRow } from '../helpers/rest.js';

/** A file variable, then two requests named by their `###` separators. */
const HTTP_FILE =
  '@host = https://example.com\n\n### One\nGET {{host}}/a\n\n### Two\nPOST {{host}}/b\nContent-Type: application/json\n\n{"x":1}';

test.describe('.http file import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('imports pasted .http requests into the project', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Requests');

    await openImportDialog(page);
    await page.getByTestId('import-format-select').selectOption('http-file');
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(HTTP_FILE);
    await page.getByTestId('import-submit').click();

    const summary = page.getByTestId('import-http-summary');
    await expect(summary).toContainText('2 requests', { timeout: 30_000 });
    await page.getByTestId('import-done').click();

    // Pasted text has no file name, so the API takes the importer's default name.
    await expect(apiRow(page, 'Imported requests')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Imported requests').click();
    await expect(restRequestRow(page, 'One')).toBeVisible({ timeout: 20_000 });
    await expect(restRequestRow(page, 'Two')).toBeVisible();
  });
});

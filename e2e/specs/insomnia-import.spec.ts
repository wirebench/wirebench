/**
 * Importing an Insomnia export, end to end.
 *
 * The unit suites prove the reader, the mapping and the dialog; what only the real app can prove is
 * that a pasted v5 file reaches main and lands as it should: a REST API with its folder, a
 * sub-environment in the workspace's Environments view, and a report that names what was left out.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, folderRow } from '../helpers/rest.js';

/** A v5 collection: a folder with a script, two requests, a cookie jar, and a Staging environment. */
const EXPORT = readFileSync(fileURLToPath(new URL('../fixtures/insomnia/collection.yaml', import.meta.url)), 'utf8');

test.describe('Insomnia import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('imports an Insomnia v5 file and shows its folders and report', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Collections');

    await openImportDialog(page);
    await page.getByTestId('import-format-select').selectOption('insomnia');
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(EXPORT);
    await page.getByTestId('import-submit').click();

    await expect(page.getByTestId('import-client-counts')).toContainText('1 API', { timeout: 30_000 });
    await expect(page.getByTestId('import-client-counts')).toContainText('2 requests');
    await expect(page.getByTestId('import-client-counts')).toContainText('1 folder');
    await expect(page.getByTestId('import-client-environments')).toContainText('Staging');
    // The report names the cookie jar, which is not imported, and the vault secret awaiting a value.
    await expect(page.getByTestId('import-client-report-notes')).toContainText('cookie jar');
    await expect(page.getByTestId('import-client-report-warnings')).toContainText('apiKey');
    await page.getByTestId('import-done').click();

    await expect(apiRow(page, 'Orders API')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Orders API').click();
    await expect(folderRow(page, 'Orders')).toBeVisible({ timeout: 20_000 });

    await openEnvironmentsView(page);
    await expect(environmentRow(page, 'Staging')).toBeVisible({ timeout: 20_000 });
  });
});

/**
 * Importing a Hoppscotch collection and its environments, end to end.
 *
 * The unit suites prove the reader, the mapping, placing and the dialog; what only the real app can
 * prove is that pasted exports reach main and land as they should: a REST API with its folder in
 * the project, and the environments file's environment in the workspace's Environments view.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, folderRow } from '../helpers/rest.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/hoppscotch/crafted/${name}`, import.meta.url)), 'utf8');

test.describe('Hoppscotch import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('imports a collection and its environments', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Clients');

    await openImportDialog(page);
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(fixture('v12-r17.json'));
    await expect(page.getByTestId('detected-format-badge')).toHaveText('Hoppscotch collection');
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-client-summary')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-client-counts')).toContainText('9 requests');
    await page.getByTestId('import-done').click();

    await expect(apiRow(page, 'Shop API')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Shop API').click();
    await expect(folderRow(page, 'Orders')).toBeVisible({ timeout: 20_000 });

    await openImportDialog(page);
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(fixture('environments-v2.json'));
    await expect(page.getByTestId('detected-format-badge')).toHaveText('Hoppscotch environments');
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-variables-summary')).toContainText('Staging', { timeout: 30_000 });
    await page.getByTestId('import-done').click();

    await openEnvironmentsView(page);
    await expect(environmentRow(page, 'Staging')).toBeVisible({ timeout: 20_000 });
  });
});

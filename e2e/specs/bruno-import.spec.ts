/**
 * Importing a Bruno collection folder, end to end.
 *
 * The unit suites prove the reader, the conversion, placing and the dialog; what only the real app
 * can prove is that a folder picked with Folder… is detected in main, walked and placed: a REST API
 * whose folder lists its requests in Bruno's `seq` order, and the collection's environments in the
 * workspace's Environments view.
 */
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, folderRow, unfoldRow } from '../helpers/rest.js';

/** A collection with HTTP, GraphQL, gRPC and WebSocket requests, a `Users` folder and two environments. */
const COLLECTION = fileURLToPath(new URL('../../fixtures/bruno/crafted/basic', import.meta.url));

test.describe('Bruno import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('picks a Bruno folder and shows its requests in seq order', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Clients');

    // Folder… goes through main's own folder dialog, stubbed here to the fixture collection.
    await launched.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, COLLECTION);

    await openImportDialog(page);
    await page.getByRole('tab', { name: 'File' }).click();
    await page.getByTestId('import-browse-folder').click();
    await expect(page.getByTestId('detected-format-badge')).toHaveText('Bruno collection', { timeout: 20_000 });
    await page.getByTestId('import-submit').click();

    const summary = page.getByTestId('import-client-summary');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-client-counts')).toContainText('3 APIs');
    await page.getByTestId('import-done').click();

    await expect(apiRow(page, 'demo-collection').first()).toBeVisible({ timeout: 20_000 });
    await unfoldRow(apiRow(page, 'demo-collection').first());
    await expect(folderRow(page, 'Users')).toBeVisible({ timeout: 20_000 });
    await folderRow(page, 'Users').click();
    const order = ['Create user', 'Upload avatar', 'User via GraphQL', 'Get user'];
    await expect(async () => {
      const names = await page.getByTestId('rest-request-row').allTextContents();
      const seen = names.map((text) => order.find((name) => text.includes(name))).filter((name) => name !== undefined);
      expect(seen).toEqual(order);
    }).toPass({ timeout: 20_000 });

    await openEnvironmentsView(page);
    await expect(environmentRow(page, 'Local')).toBeVisible({ timeout: 20_000 });
    await expect(environmentRow(page, 'Prod')).toBeVisible({ timeout: 20_000 });
  });
});

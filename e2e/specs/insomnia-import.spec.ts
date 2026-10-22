/**
 * Importing an Insomnia export, end to end.
 *
 * The unit suites prove the reader, the mapping, placing and the dialog; what only the real app can
 * prove is that a pasted v5 export reaches main and lands as it should: a REST API with its folder,
 * a WebSocket API beside it, and its sub-environment in the workspace's Environments view.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, folderRow, unfoldRow } from '../helpers/rest.js';

/** A v5 collection with HTTP, GraphQL, gRPC and WebSocket requests, an `Orders` folder and a `Staging` environment. */
const EXPORT = readFileSync(
  fileURLToPath(new URL('../../fixtures/insomnia/crafted/v5-collection.yaml', import.meta.url)),
  'utf8',
);

test.describe('Insomnia import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('imports a pasted export into the project and its sub-environment into the workspace', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Clients');

    await openImportDialog(page);
    await page.getByTestId('import-format-select').selectOption('insomnia');
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(EXPORT);
    await page.getByTestId('import-submit').click();

    const summary = page.getByTestId('import-client-summary');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-client-counts')).toContainText('3 APIs');
    await expect(summary).toContainText('Staging');
    await page.getByTestId('import-done').click();

    // More than one kind of request: the REST API keeps the workspace's name, the others say their kind.
    await expect(apiRow(page, 'Orders API')).toBeVisible({ timeout: 20_000 });
    await unfoldRow(apiRow(page, 'Orders API'));
    await expect(folderRow(page, 'Orders')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ws-api-row').filter({ hasText: 'Orders API (WebSocket)' })).toBeVisible({
      timeout: 20_000,
    });

    await openEnvironmentsView(page);
    await expect(environmentRow(page, 'Staging')).toBeVisible({ timeout: 20_000 });
  });
});

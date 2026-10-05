/**
 * Importing an OpenCollection, end to end.
 *
 * The unit suites prove the parser, the mapping, the directory walk and the dialog; what only the
 * real app can prove is that a pasted single-document collection reaches main and lands as it
 * should: a REST API with its folder, a WebSocket API beside it, and its environment in the
 * workspace's Environments view.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, folderRow } from '../helpers/rest.js';

/** A collection with HTTP, GraphQL, gRPC and WebSocket items, a folder and a `dev` environment. */
const COLLECTION = readFileSync(
  fileURLToPath(new URL('../../fixtures/opencollection/crafted/single/collection.yml', import.meta.url)),
  'utf8',
);

test.describe('OpenCollection import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('imports a pasted collection into the project and its environment into the workspace', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Collections');

    await openImportDialog(page);
    await page.getByTestId('import-format-select').selectOption('opencollection');
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(COLLECTION);
    await page.getByTestId('import-submit').click();

    const summary = page.getByTestId('import-opencollection-summary');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-opencollection-counts')).toContainText('3 APIs');
    await expect(summary).toContainText('dev');
    await page.getByTestId('import-done').click();

    // More than one kind of item: the REST API keeps the collection's name, the others say their kind.
    await expect(apiRow(page, 'Pets')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Pets').click();
    await expect(folderRow(page, 'Users')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ws-api-row').filter({ hasText: 'Pets (WebSocket)' })).toBeVisible({
      timeout: 20_000,
    });

    await openEnvironmentsView(page);
    await expect(environmentRow(page, 'dev')).toBeVisible({ timeout: 20_000 });
  });
});

/**
 * A definition behind authentication, end to end.
 *
 * The engine and IPC suites prove the fetcher, the storage and the reuse one layer at a time. What
 * only the real app can prove is the chain a user walks: an OpenAPI document imported by URL from a
 * server that demands Basic auth, the password typed once into the Import dialog and kept in the
 * keychain, and Update Definition reading the changed document from the same URL later without
 * asking for anything.
 *
 * Everything is local: the `update` crafted fixture pair is served by the in-process REST test
 * server behind its `/auth/basic` credentials (`u` / `p`), from a document map it reads live.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expandExplorer } from '../helpers/project.js';
import { apiRow, chooseContextMenuItem, openImportOpenApi, restRequestRow } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer, type TestRestServerDocument } from '../helpers/test-server.js';

const updateDir = fileURLToPath(new URL('../../fixtures/openapi/crafted/update/', import.meta.url));

/** One of the pair, read from disk, served only with the Basic credentials. */
function protectedFixture(name: string): TestRestServerDocument {
  return { body: readFileSync(join(updateDir, name), 'utf-8'), contentType: 'application/yaml', auth: 'basic' };
}

test.describe('A definition behind authentication', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let documents: Record<string, TestRestServerDocument> = {};

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
    documents = {};
  });

  test('imports behind Basic auth, then updates from the same URL without asking again', async () => {
    documents = { '/secure/openapi.yaml': protectedFixture('petstore-update-old.yaml') };
    server = await startTestRestServer({ documents });
    const documentUrl = `${server.url}/secure/openapi.yaml`;

    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Definition auth');
    await createProject(page, 'Pets');

    // The Authentication section of the Import dialog: Basic, with the password saved to the keychain.
    await openImportOpenApi(page);
    const importDialog = page.getByTestId('import-openapi-dialog');
    await importDialog.getByTestId('import-openapi-url').fill(documentUrl);
    const section = importDialog.getByTestId('definition-auth');
    await section.getByLabel('Definition authentication type').selectOption('basic');
    await section.getByLabel('Definition username').fill('u');
    await section.getByRole('button', { name: 'Set…' }).click();
    await section.getByPlaceholder('Enter password').fill('p');
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByRole('button', { name: 'Replace…' })).toBeVisible();
    await importDialog.getByTestId('import-openapi-submit').click();
    await expect(page.getByTestId('import-openapi-summary')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('import-openapi-done').click();
    await expect(importDialog).toBeHidden();

    await expect(apiRow(page, 'Petstore Update')).toBeVisible({ timeout: 20_000 });
    await expandExplorer(page, 'Delete a pet');
    await expect(restRequestRow(page, 'Delete a pet')).toBeVisible({ timeout: 20_000 });

    // The same URL now answers with the next document, still only to the right credentials.
    documents['/secure/openapi.yaml'] = protectedFixture('petstore-update-next.yaml');
    const before = server.requests.length;

    await chooseContextMenuItem(page, apiRow(page, 'Petstore Update'), 'Update Definition…');
    const dialog = page.getByTestId('rest-update-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-update-source')).toContainText(documentUrl, { timeout: 30_000 });
    await expect(page.getByTestId('rest-update-added')).toContainText('GET /owners', { timeout: 30_000 });
    await expect(page.getByTestId('rest-update-removed')).toContainText('DELETE /pets/{id}');
    // Nothing was asked for: no error, and the chooser with its Authentication section stayed shut.
    await expect(page.getByTestId('rest-update-error')).toHaveCount(0);
    await expect(dialog.getByTestId('definition-auth')).toHaveCount(0);
    // The preview went to the server with the stored credentials.
    const previewed = server.requests.slice(before).filter((request) => request.url === '/secure/openapi.yaml');
    expect(previewed.length).toBeGreaterThan(0);
    for (const request of previewed) {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    }

    await page.getByTestId('rest-update-apply').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId('toast-viewport')).toContainText('1 added', { timeout: 20_000 });
    await expect(page.getByTestId('toast-viewport')).toContainText('1 orphaned');

    await expandExplorer(page, 'List owners');
    await expect(restRequestRow(page, 'List owners')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('explorer-orphaned-badge')).toHaveCount(1, { timeout: 20_000 });
  });
});

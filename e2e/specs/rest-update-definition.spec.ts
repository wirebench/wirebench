/**
 * Update Definition for a REST API, end to end.
 *
 * The engine and IPC suites prove the plan and the merge one layer at a time. What only the real app
 * can prove is the whole chain: a document imported by URL, edited by hand in one place, re-read from
 * the same URL after it changed, previewed as a per-operation report, and applied — with the edit
 * kept, an untouched field following the new document, the vanished operation's request badged
 * rather than deleted, and the new operation's request in the folder its tag names.
 *
 * Everything is local: the `update` crafted fixture pair is served by the in-process REST test
 * server, which reads its document map live — so the same URL serves the old document before the
 * update and the new one after, which is exactly what the feature is for.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expandExplorer } from '../helpers/project.js';
import {
  apiRow,
  chooseContextMenuItem,
  folderRow,
  importOpenApiByUrl,
  openApiTab,
  openRequestTab,
  restRequestRow,
  saveRequest,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer, type TestRestServerDocument } from '../helpers/test-server.js';

const updateDir = fileURLToPath(new URL('../../fixtures/openapi/crafted/update/', import.meta.url));

/** One of the pair, read from disk. */
function fixture(name: string): TestRestServerDocument {
  return { body: readFileSync(join(updateDir, name), 'utf-8'), contentType: 'application/yaml' };
}

test.describe('REST Update Definition', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  /** The live document map: the same path is re-pointed at the new document mid-test. */
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

  test('re-imports a changed document: kept edit, followed field, orphaned row, new request', async () => {
    documents = { '/update/openapi.yaml': fixture('petstore-update-old.yaml') };
    server = await startTestRestServer({ documents });
    const documentUrl = `${server.url}/update/openapi.yaml`;

    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'REST update');
    await createProject(page, 'Pets');
    await importOpenApiByUrl(page, documentUrl);

    // The old document: three folders, and a request for the operation the new one drops.
    await expect(apiRow(page, 'Petstore Update')).toBeVisible({ timeout: 20_000 });
    await expandExplorer(page, 'Delete a pet');
    await expect(folderRow(page, 'pets')).toBeVisible({ timeout: 20_000 });
    await expect(restRequestRow(page, 'Delete a pet')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('explorer-orphaned-badge')).toHaveCount(0);

    // The API took its base URL from the old document's `servers[0]`; nothing has touched it, so it
    // is what must follow the new document.
    await openApiTab(page, 'Petstore Update');
    await expect(page.getByTestId('api-base-url')).toHaveValue('https://v1.pets.test');

    // One edit by hand: `limit`'s value on List pets. The merge must keep it even though the new
    // document changes that same parameter (it becomes required).
    await restRequestRow(page, 'List pets').dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await openRequestTab(page, 'Params');
    const limit = page.getByTestId('rest-query-value').first();
    await limit.fill('42');
    await limit.press('Tab');
    // The edit reaches main over IPC after the editor's own debounce; the update reads the project
    // main holds, so wait for the save rather than racing it.
    await saveRequest(page);

    // The same URL now answers with the new document, which is the situation the feature is for.
    documents['/update/openapi.yaml'] = fixture('petstore-update-next.yaml');

    await chooseContextMenuItem(page, apiRow(page, 'Petstore Update'), 'Update Definition…');
    const dialog = page.getByTestId('rest-update-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // The dialog plans on open, against the source the import recorded.
    await expect(page.getByTestId('rest-update-source')).toContainText(documentUrl, { timeout: 30_000 });

    // The report names exactly what the pair differs by.
    await expect(page.getByTestId('rest-update-added')).toContainText('GET /owners', { timeout: 30_000 });
    await expect(page.getByTestId('rest-update-removed')).toContainText('DELETE /pets/{id}');
    const changed = page.getByTestId('rest-update-changed');
    await expect(changed).toContainText('GET /pets: parameters');
    await expect(changed).toContainText('POST /pets: request-body');
    await expect(changed).toContainText('GET /pets/{id}: responses');
    const apiWide = page.getByTestId('rest-update-api');
    await expect(apiWide).toContainText('servers');
    await expect(apiWide).toContainText('version');

    await page.getByTestId('rest-update-apply').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // The toast is the only place the counts are said out loud.
    await expect(page.getByTestId('toast-viewport')).toContainText('1 added', { timeout: 20_000 });
    await expect(page.getByTestId('toast-viewport')).toContainText('1 orphaned');

    // The new operation brought one request, in the folder its `owners` tag names.
    await expandExplorer(page, 'List owners');
    await expect(folderRow(page, 'owners')).toBeVisible({ timeout: 20_000 });
    await expect(restRequestRow(page, 'List owners')).toBeVisible({ timeout: 20_000 });

    // Nothing is deleted: the dropped operation's request is still there, badged.
    await expect(restRequestRow(page, 'Delete a pet')).toBeVisible();
    await expect(page.getByTestId('explorer-orphaned-badge')).toHaveCount(1, { timeout: 20_000 });

    // The untouched base URL followed the new document's server.
    await openApiTab(page, 'Petstore Update');
    await expect(page.getByTestId('api-base-url')).toHaveValue('https://v2.pets.test', { timeout: 20_000 });

    // The edited value survived the rewrite of the very parameter it sits on.
    await restRequestRow(page, 'List pets').dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await openRequestTab(page, 'Params');
    await expect(page.getByTestId('rest-query-value').first()).toHaveValue('42', { timeout: 20_000 });
  });
});

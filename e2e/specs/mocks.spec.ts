import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, chooseContextMenuItem, importOpenApiByUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/**
 * A mock service (#59), end to end: an imported OpenAPI document becomes a mock from the API's menu,
 * the mock tab starts it on a free port, a request sent to it gets the document's example back, and
 * the tab's log shows that request.
 */
const DOCUMENT = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: The pets
          content:
            application/json:
              schema:
                type: array
                items: { type: object, properties: { name: { type: string } } }
              example: [{ name: Fido }]
`;

let server: TestRestServer;
let app: LaunchedApp;

test.beforeAll(async () => {
  server = await startTestRestServer({
    documents: { '/openapi.yaml': { body: DOCUMENT, contentType: 'application/yaml' } },
  });
});

test.afterAll(async () => {
  await server.close();
});

test.afterEach(async () => {
  await app.close();
});

test('a mock generated from an API answers with the document’s example and logs the request', async () => {
  app = await launchApp();
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Pets');
  await importOpenApiByUrl(page, `${server.url}/openapi.yaml`);

  await chooseContextMenuItem(page, apiRow(page, 'Pets'), 'New Mock');
  const tab = page.getByTestId('mock-tab');
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(tab.getByTestId('mock-operation-row')).toHaveCount(1);
  // The explorer's Mocks group starts closed, like Sequences; the new mock is its one row.
  await page.getByTestId('mocks-group-row').click();
  await expect(page.getByTestId('mock-row')).toHaveText(/Pets mock/, { timeout: 20_000 });

  await tab.getByTestId('mock-start').click();
  const url = tab.getByTestId('mock-url');
  await expect(url).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/$/, { timeout: 20_000 });
  await expect(page.getByTestId('mock-running-badge')).toBeVisible();

  const response = await fetch(`${(await url.textContent()) ?? ''}pets`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([{ name: 'Fido' }]);

  const row = tab.getByTestId('mock-log-row');
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toContainText('/pets');
  await expect(tab.getByTestId('mock-log-status')).toHaveText('200');

  await tab.getByTestId('mock-stop').click();
  await expect(tab.getByTestId('mock-start')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('mock-running-badge')).toHaveCount(0);
});

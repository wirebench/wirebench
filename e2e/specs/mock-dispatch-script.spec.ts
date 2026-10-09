import { expect, test } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, chooseContextMenuItem, importOpenApiByUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/**
 * A mock operation's dispatch script is type-checked as it is typed (#352): naming a response the
 * operation does not have shows as an error under the editor, and goes away once the name is one of
 * its responses.
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
              schema: { type: array, items: { type: string } }
              example: [Fido]
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

test('a dispatch script naming a response the operation lacks shows an error', async () => {
  app = await launchApp();
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Pets');
  await importOpenApiByUrl(page, `${server.url}/openapi.yaml`);

  await chooseContextMenuItem(page, apiRow(page, 'Pets'), 'New Mock');
  const tab = page.getByTestId('mock-tab');
  await expect(tab.getByTestId('mock-operation-row')).toHaveCount(1, { timeout: 20_000 });
  await tab.getByTestId('mock-dispatch').selectOption('script');
  await expect(tab.getByTestId('mock-script')).toBeVisible({ timeout: 20_000 });

  await setMonacoText(page, 'Dispatch script', "respond('No such response');");
  await expect(tab.getByTestId('mock-script-errors')).toContainText('1 error', { timeout: 30_000 });

  await setMonacoText(page, 'Dispatch script', 'const first = responses[0];\nif (first) respond(first.name);');
  await expect(tab.getByTestId('mock-script-errors')).toHaveCount(0, { timeout: 30_000 });
});

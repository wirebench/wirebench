/**
 * Importing an OpenAPI document, end to end.
 *
 * The unit suite proves the mapping and the channels; what only the real app can prove is that the
 * whole chain holds together — a document fetched over HTTP becomes explorer rows, one of those rows
 * opens a request whose generated body actually goes on the wire, and the definition the import
 * cached can be read back and exported byte for byte after the app has written it to disk.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, workspaceProjectDir } from '../helpers/project.js';
import {
  apiRow,
  folderRow,
  importOpenApiByUrl,
  openImportOpenApi,
  openResponseTab,
  responseStatus,
  restRequestRow,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

const craftedDir = fileURLToPath(new URL('../../fixtures/openapi/crafted/', import.meta.url));

/**
 * The `bodies` crafted fixture, with its declared server replaced by the running test server's URL.
 *
 * The substitution is what makes an imported request sendable: a fixture cannot know the port it
 * will be served on, and the base URL is what the import takes from `servers[0]`.
 */
function bodiesFixture(serverUrl: string): string {
  return readFileSync(join(craftedDir, 'bodies', 'openapi.yaml'), 'utf-8').replace('https://bodies.test', serverUrl);
}

/**
 * Starts a server serving the `bodies` fixture at `/openapi.yaml`, with the fixture's declared
 * server rewritten to the server's own URL.
 *
 * The document map is filled in after the server starts, which the helper reads live: that is the
 * only way a fixture can name the port it is about to be served on.
 */
async function serveBodies(): Promise<TestRestServer> {
  const documents: Record<string, { body: string; contentType: string }> = {};
  const started = await startTestRestServer({ documents });
  documents['/openapi.yaml'] = { body: bodiesFixture(started.url), contentType: 'application/yaml' };
  return started;
}

/** The `refs` fixture and the two documents it references, as the test server's document map. */
function refsDocuments(serverUrl: string): Record<string, { body: string; contentType: string }> {
  const read = (...parts: string[]): string => readFileSync(join(craftedDir, 'refs', ...parts), 'utf-8');
  return {
    '/refs/openapi.yaml': {
      body: read('openapi.yaml').replace('https://refs.test', serverUrl),
      contentType: 'application/yaml',
    },
    '/refs/shared/parameters.yaml': { body: read('shared', 'parameters.yaml'), contentType: 'application/yaml' },
    '/refs/shared/schemas.yaml': { body: read('shared', 'schemas.yaml'), contentType: 'application/yaml' },
  };
}

test.describe('OpenAPI import', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let userDataDir: string | undefined;
  let exportDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    await server?.close();
    server = undefined;
    for (const dir of [userDataDir, exportDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }
    userDataDir = undefined;
    exportDir = undefined;
  });

  test('imports a document by URL into the explorer tree the mapping describes', async () => {
    server = await serveBodies();

    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'OpenAPI');
    await createProject(page, 'Bodies');

    await openImportOpenApi(page);
    await page.getByTestId('import-openapi-url').fill(`${server.url}/openapi.yaml`);
    await page.getByTestId('import-openapi-submit').click();

    // The summary is the only place a user learns what the document said that was not imported.
    const summary = page.getByTestId('import-openapi-summary');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-openapi-counts')).toContainText('8 requests');
    await expect(page.getByTestId('import-openapi-skipped')).toContainText('Offers "text/plain" as well');
    await page.getByTestId('import-openapi-done').click();

    // One API, one folder per path segment, one request per operation.
    await expect(apiRow(page, 'Bodies')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'Bodies').click();
    for (const folder of ['json', 'form', 'multipart', 'binary']) {
      await expect(folderRow(page, folder)).toBeVisible({ timeout: 20_000 });
    }
    await folderRow(page, 'json').click();
    await expect(restRequestRow(page, 'JSON with an example')).toBeVisible({ timeout: 20_000 });
  });

  test('sends an imported request’s generated body over the base URL it was given', async () => {
    server = await serveBodies();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'OpenAPI');
    await createProject(page, 'Bodies');
    await importOpenApiByUrl(page, `${server.url}/openapi.yaml`);

    // The document's own `servers[0]` is the running server, so the imported API already points at
    // it — nothing to correct, which is the point of taking the base URL from the document.
    await apiRow(page, 'Bodies').dblclick();
    await expect(page.getByTestId('api-tab')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('api-base-url')).toHaveValue(server.url);

    await apiRow(page, 'Bodies').click();
    await folderRow(page, 'json').click();
    await restRequestRow(page, 'JSON with an example').dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    // The fixture's own path is not a route this server has, so the request is pointed at `/echo`;
    // the method and the generated body are left exactly as the import made them.
    await expect(page.getByTestId('rest-method')).toHaveValue('POST');
    await setMethodAndUrl(page, 'POST', '/echo');
    await sendRest(page);

    // The test server echoes what it received: the generated body really went out. Asserted
    // against the server's record rather than the response pane, which virtualises its lines —
    // the echo puts `body` after the headers, past what a short CI window renders (see
    // `curl.spec.ts` for the same fix and the failure it came from).
    await expect(responseStatus(page)).toContainText('200');
    await expect(page.getByTestId('rest-response-body')).toContainText('"method": "POST"', { timeout: 20_000 });
    expect(server.requests.at(-1)?.body.toString('utf8')).toContain('Fido');
    await openResponseTab(page, 'Headers');
  });

  test('follows a document’s references, and exports the cache byte for byte', async () => {
    const documents: Record<string, { body: string; contentType: string }> = {};
    server = await startTestRestServer({ documents });
    Object.assign(documents, refsDocuments(server.url));

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-openapi-'));
    exportDir = mkdtempSync(join(tmpdir(), 'wirebench-openapi-export-'));
    launched = await launchApp({ userDataDir });
    const page = launched.window;
    await createWorkspace(page, 'OpenAPI');
    await createProject(page, 'Refs');
    await importOpenApiByUrl(page, `${server.url}/refs/openapi.yaml`);

    // The definition card reads the cache main wrote, which is three documents for this fixture.
    await apiRow(page, 'Refs').dblclick();
    await expect(page.getByTestId('api-tab')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('api-definition-source')).toContainText('/refs/openapi.yaml');
    await page.getByTestId('api-definition-view').click();
    const select = page.getByTestId('api-definition-document');
    await expect(select).toBeVisible({ timeout: 20_000 });
    await expect(select.locator('option')).toHaveCount(3);

    // Export goes through main's own folder dialog, which the app stubs in e2e to `exportDir`.
    await launched.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, exportDir);
    await page.getByTestId('api-definition-export').click();

    await expect
      .poll(() => readdirSync(exportDir ?? '').sort(), { timeout: 20_000 })
      .toEqual(['openapi.yaml', 'parameters.yaml', 'schemas.yaml']);
    // Byte for byte: an exported definition is what was fetched, not a re-serialisation of it.
    const exported = readFileSync(join(exportDir, 'schemas.yaml'), 'utf-8');
    expect(exported).toBe(readFileSync(join(craftedDir, 'refs', 'shared', 'schemas.yaml'), 'utf-8'));
  });

  test('imports a file inside the project folder, which is a path main will read', async () => {
    server = await startTestRestServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-openapi-'));
    launched = await launchApp({ userDataDir });
    const page = launched.window;
    await createWorkspace(page, 'OpenAPI');
    await createProject(page, 'Local');

    // A renderer-named path is read only inside a project folder or after a Browse… pick, so the
    // document is put where the rule allows — which is also where a spec would live in practice.
    const path = join(workspaceProjectDir(userDataDir, 'Local'), 'openapi.yaml');
    writeFileSync(path, bodiesFixture(server.url));

    await openImportOpenApi(page);
    await page.getByRole('tab', { name: 'File' }).click();
    await page.getByTestId('import-openapi-path').fill(path);
    await page.getByTestId('import-openapi-name').fill('From disk');
    await page.getByTestId('import-openapi-submit').click();

    await expect(page.getByTestId('import-openapi-summary')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('import-openapi-done').click();
    await expect(apiRow(page, 'From disk')).toBeVisible({ timeout: 20_000 });
  });

  test('imports a Swagger 2.0 document by URL', async () => {
    server = await startTestRestServer({
      documents: {
        '/swagger.json': {
          body: JSON.stringify({
            swagger: '2.0',
            info: { title: 'Old Petstore', version: '1.0' },
            host: 'api.test',
            paths: {
              '/pets': {
                get: {
                  summary: 'Get Pets',
                  responses: { 200: { description: 'OK' } },
                },
              },
            },
          }),
          contentType: 'application/json',
        },
      },
    });
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'OpenAPI');
    await createProject(page, 'Old');

    await openImportOpenApi(page);
    await page.getByTestId('import-openapi-url').fill(`${server.url}/swagger.json`);
    await page.getByTestId('import-openapi-submit').click();

    await expect(page.getByTestId('import-openapi-summary')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-openapi-summary')).toContainText('Swagger 2.0');
    await page.getByTestId('import-openapi-done').click();
    await expect(apiRow(page, 'Old Petstore')).toBeVisible({ timeout: 20_000 });
  });
});

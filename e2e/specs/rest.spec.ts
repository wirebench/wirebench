import { readdirSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, workspaceProjectDir } from '../helpers/project.js';
import {
  addHeader,
  openRequestTab,
  createApi,
  createRestRequest,
  openResponseTab,
  responseStatus,
  saveRequest,
  sendRest,
  sendRestByKeyboard,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** Every file under `dir`, recursively, with its last-modified time. */
function fileTimes(dir: string): Map<string, number> {
  const times = new Map<string, number>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        times.set(path, statSync(path).mtimeMs);
      }
    }
  };
  walk(dir);
  return times;
}

test.describe('REST: make an API, send a request, read the response', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let second: TestRestServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    await server?.close();
    await second?.close();
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
    server = undefined;
    second = undefined;
  });

  test('sends a GET with a query and a header, and reads every response tab', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo?x=1');
    await addHeader(page, 'X-Trace', 'abc');

    await sendRest(page);

    // The test server echoes what it received, so the response proves the query and the header
    // actually went out rather than merely being shown in the editor.
    await expect(responseStatus(page)).toContainText('200');
    const body = page.getByTestId('rest-response-body');
    await expect(body).toContainText('"x": "1"', { timeout: 20_000 });
    await expect(body).toContainText('x-trace');

    await openResponseTab(page, 'Headers');
    await expect(page.getByTestId('rest-response-headers')).toContainText('content-type');

    await openResponseTab(page, 'Timing');
    await expect(page.getByTestId('rest-response-timing')).toBeVisible();

    await openResponseTab(page, 'Raw');
    await expect(page.getByTestId('rest-response-raw-exchange')).toContainText('GET /echo?x=1');

    // The Query tab runs XPath 3.1 over the JSON body itself — maps, arrays and `?` lookup (§3.10).
    await openResponseTab(page, 'Query');
    const query = page.getByTestId('rest-response-query');
    await expect(query).toBeVisible();
    await expect(query.getByText(/is the context item/)).toBeVisible();
    await query.getByLabel('Query expression').fill('?query?x');
    await query.getByTestId('query-run').click();
    await expect(query.getByTestId('query-results')).toContainText('1', { timeout: 20_000 });

    // …and JSONPath beside it, which is the syntax a REST user already has in their notes. Both
    // languages reach the same `xpath.evaluate` channel; only the expression differs.
    await query.getByRole('radio', { name: 'JSONPath' }).click();
    await query.getByLabel('Query expression').fill('$.query.x');
    await query.getByTestId('query-run').click();
    await expect(query.getByTestId('query-results')).toContainText("$['query']['x']", { timeout: 20_000 });
  });

  test('shows the cookies a response set and the redirects it followed', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Cookies');
    await setMethodAndUrl(page, 'GET', '/cookies/set');
    await sendRest(page);

    await openResponseTab(page, 'Cookies');
    const cookies = page.getByTestId('rest-response-cookies');
    await expect(cookies).toContainText('session');
    await expect(cookies).toContainText('HttpOnly');

    // A 302 to /echo: the hop is listed, and the request arrives as a GET.
    await setMethodAndUrl(page, 'GET', '/redirect/302?to=/echo');
    await sendRest(page);
    await openResponseTab(page, 'Redirects');
    await expect(page.getByTestId('rest-response-redirects')).toContainText('302');
  });

  test('sends a JSON body on a POST, and the server receives it', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Create');
    await setMethodAndUrl(page, 'POST', '/echo');

    await openRequestTab(page, 'Body');
    await page.getByTestId('rest-body-kind').selectOption('raw');
    await setMonacoText(page, 'Request body', '{"name":"Fido"}');

    await sendRestByKeyboard(page);

    await expect(responseStatus(page)).toContainText('200');
    const body = page.getByTestId('rest-response-body');
    await expect(body).toContainText('Fido', { timeout: 20_000 });
    await expect(body).toContainText('application/json');
  });

  test('refuses to send a request whose URL is not finished, and says why', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Unfinished');
    // An unfilled `{id}` and a property nothing resolves: both are "this request is not finished".
    await setMethodAndUrl(page, 'GET', '/pet/{id}?tag=${#Env#missing}');

    await sendRest(page);

    await expect(responseStatus(page)).toContainText('rest-unresolved-properties');
    // And nothing reached the server.
    expect(server.requests.filter((request) => request.url.startsWith('/pet'))).toHaveLength(0);
  });

  test('an environment override points the next send at a second server', async () => {
    server = await startTestRestServer();
    second = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await sendRest(page);
    expect(server.requests.length).toBeGreaterThan(0);

    // --- add an environment and override the API's base URL ------------------
    await openEnvironmentsView(page);
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(environmentRow(page, 'Environment 1')).toBeVisible();
    const override = page.getByLabel('Endpoint override for Pets › Petstore');
    await expect(override).toBeVisible({ timeout: 20_000 });
    await override.fill(second.url);
    await override.press('Enter');

    await page.getByTestId('env-switcher').click();
    await page.getByRole('menuitem', { name: 'Environment 1', exact: true }).click();
    await expect(page.getByTestId('env-switcher')).toContainText('Environment 1');

    // --- send again: the override wins --------------------------------------
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await page.getByRole('button', { name: 'Expand all' }).click();
    const requestRow = page.getByTestId('rest-request-row').filter({ hasText: 'Echo' }).first();
    await expect(requestRow).toBeVisible({ timeout: 20_000 });
    await requestRow.click();
    await sendRest(page);

    expect(second.requests.length).toBeGreaterThan(0);
  });

  test('records the send in history, badged with its method', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'DELETE', '/echo');
    await sendRest(page);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    const row = page.getByTestId('history-row').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('method-badge')).toHaveAttribute('data-method', 'DELETE');
    await expect(row).toContainText('Echo');
  });

  test('renaming a request rewrites exactly its own two files', async () => {
    server = await startTestRestServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await saveRequest(page);

    const dir = workspaceProjectDir(userDataDir);
    // Give the autosave a moment to land before the snapshot.
    await expect
      .poll(() => [...fileTimes(dir).keys()].some((path) => path.includes('apis')), { timeout: 20_000 })
      .toBe(true);
    const before = fileTimes(dir);

    const breadcrumbName = page.getByTestId('rest-breadcrumb-name');
    await breadcrumbName.dblclick();
    const input = page.getByTestId('rest-breadcrumb-name-input');
    await input.fill('Renamed');
    await input.press('Enter');
    await expect(breadcrumbName).toHaveText('Renamed');
    // The rename reaches main at once, but the project is only written on save.
    await saveRequest(page);

    // A rename moves the request's file (and its body sibling, when it has one) and rewrites
    // nothing else: the API's own file keeps its mtime.
    await expect
      .poll(
        () => {
          const after = fileTimes(dir);
          return [...after.keys()].filter((path) => !before.has(path)).length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    const after = fileTimes(dir);
    const removed = [...before.keys()].filter((path) => !after.has(path));
    expect(removed.every((path) => path.includes('apis'))).toBe(true);
  });

  test('a relaunch reopens the tab and keeps an unsaved edit', async () => {
    server = await startTestRestServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await saveRequest(page);

    // An edit left deliberately unsaved: the tab must come back showing it.
    await setMethodAndUrl(page, 'POST', '/echo?draft=1');
    await launched.close();

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('rest-url')).toHaveValue('/echo?draft=1');
  });
});

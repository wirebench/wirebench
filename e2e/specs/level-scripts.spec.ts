import { expect, test } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  apiRow,
  chooseContextMenuItem,
  createApi,
  folderRow,
  openApiTab,
  openResponseTab,
  responseStatus,
  saveRequest,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/**
 * API and folder scripts (#334), from the UI against a real server: a folder's script set in its
 * Scripts… dialog and an API's set on its tab both run around a request in the folder that has no
 * scripts of its own, API first, and the response's Script tab shows each under its heading.
 */
let server: TestRestServer;
let app: LaunchedApp;

test.beforeAll(async () => {
  server = await startTestRestServer({});
});

test.afterAll(async () => {
  await server.close();
});

test.afterEach(async () => {
  await app.close();
});

test('an API’s and a folder’s scripts run around a request in the folder, API first', async () => {
  app = await launchApp();
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Shop');
  await createApi(page, 'Shop API', server.url);

  // The folder's script, in its Scripts… dialog. A new folder lands in inline rename mode; Escape
  // keeps the name it was given, and the API row is opened to reveal it.
  await chooseContextMenuItem(page, apiRow(page, 'Shop API'), 'New folder');
  await page.keyboard.press('Escape');
  await apiRow(page, 'Shop API').click();
  await chooseContextMenuItem(page, folderRow(page, 'Folder 1'), 'Scripts…');
  const dialog = page.getByTestId('folder-scripts-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await setMonacoText(
    page,
    'Pre-request script for this folder',
    "request.headers.set('X-Order', request.headers.get('X-Order') + ',folder');\nlog(request.headers.get('X-Order'));",
  );
  await page.getByTestId('folder-scripts-done').click();
  await expect(dialog).toBeHidden();

  // The API's script, on its tab.
  await openApiTab(page, 'Shop API');
  await setMonacoText(page, 'Pre-request script for this API', "request.headers.set('X-Order', 'api');");

  // A request in the folder, with no scripts of its own.
  await chooseContextMenuItem(page, folderRow(page, 'Folder 1'), 'New request');
  await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
  const breadcrumbName = page.getByTestId('rest-breadcrumb-name');
  await breadcrumbName.dblclick();
  const input = page.getByTestId('rest-breadcrumb-name-input');
  await input.fill('Echo');
  await input.press('Enter');
  await expect(breadcrumbName).toHaveText('Echo');
  await setMethodAndUrl(page, 'GET', '/echo');
  await saveRequest(page);

  await sendRest(page);
  await expect(responseStatus(page)).toContainText('200', { timeout: 30_000 });
  await openResponseTab(page, 'Script');
  const levels = page.getByTestId('script-level');
  await expect(levels).toHaveCount(2);
  await expect(levels.nth(0)).toHaveAttribute('aria-label', 'API "Shop API" · pre-request');
  await expect(levels.nth(1)).toHaveAttribute('aria-label', 'Folder "Folder 1" · pre-request');
  await expect(levels.nth(1)).toContainText('api,folder');
});

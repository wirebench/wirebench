import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  chooseContextMenuItem,
  createApi,
  createRestRequest,
  responseStatus,
  restRequestRow,
  saveRequest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** The platform's own modifier, for the shortcuts a spec presses. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('REST: a saved request can be found', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  test('a new request is named in the tree, found with Quick Open and sent from its row', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'Findable');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    // The new request's row starts in rename mode in the tree, which is where the helper names it.
    await createRestRequest(page, 'Petstore', 'List pets');
    await setMethodAndUrl(page, 'GET', '/echo?pets=1');
    await saveRequest(page);

    // Close its tab, so only Quick Open can bring it back.
    await page.keyboard.press(`${MOD}+w`);
    await expect(page.getByTestId('rest-editor')).toBeHidden({ timeout: 20_000 });

    // ⌘P lists it as METHOD name, under project › API, and finds it by its URL path as well.
    await page.keyboard.press(`${MOD}+KeyP`);
    await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.type('echo');
    const item = page.locator('[data-testid="quick-open-item"][data-kind="rest"]').first();
    await expect(item).toContainText('GET List pets', { timeout: 20_000 });
    await expect(item).toContainText('Pets › Petstore');
    await item.click();
    await expect(page.getByTestId('rest-breadcrumb-name')).toHaveText('List pets', { timeout: 20_000 });

    // The tree follows the tab: its row is shown and selected.
    await expect(page.getByRole('treeitem', { selected: true })).toContainText('List pets', { timeout: 20_000 });

    // Send from the row's own menu.
    await chooseContextMenuItem(page, restRequestRow(page, 'List pets'), 'Send');
    await expect(responseStatus(page)).toContainText('200', { timeout: 20_000 });
    expect(server.requests.some((request) => request.url === '/echo?pets=1')).toBe(true);
  });
});

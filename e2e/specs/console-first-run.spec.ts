/**
 * A fresh REST workspace (#575): the console starts collapsed with no SOAP-only WS-I Report tab,
 * and the first send opens it on the HTTP Log.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { createApi, createRestRequest, responseStatus, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

test.describe('the console in a fresh REST workspace', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    await server?.close();
    launched = undefined;
    server = undefined;
  });

  test('starts collapsed without a WS-I tab and opens on the first send', async () => {
    server = await startTestRestServer();
    // The adaptive layout is the one a user gets: the fixed one opens the console for older specs.
    launched = await launchApp({ adaptiveLayout: true });
    const page = launched.window;
    await createWorkspace(page, 'Fresh');
    await createProject(page, 'Pets');
    await expect(page.getByTestId('console')).toBeHidden();
    // A window shorter than 720px keeps the console collapsed on the first send too (#636), and a
    // runner whose screen clamps the window that short has nothing to show here.
    test.skip((await page.evaluate(() => window.innerHeight)) < 720, 'The screen clamps the window below 720px');

    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo?x=1');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200', { timeout: 20_000 });

    const panel = page.getByTestId('console');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'HTTP Log' })).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'WS-I Report' })).toHaveCount(0);
  });
});

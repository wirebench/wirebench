/**
 * Request-level assertions in the editors (#192), end to end.
 *
 * The unit and IPC suites prove the check and the wire one layer at a time. What only the real app
 * proves is the chain: an assertion added in an editor is saved with the request, an editor Send
 * checks it, and the verdict reaches the response pane's Assertions tab. The second test seeds a
 * WebSocket request's assertion in its own file, so it also proves the loader reads it back.
 *
 * Everything is local: the REST and WebSocket echo servers are the in-process test servers.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProject,
  createWorkspace,
  expectReopenedWorkspace,
  saveAll,
  workspaceProjectDir,
} from '../helpers/project.js';
import { chooseContextMenuItem, createApi, createRestRequest, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import {
  startTestRestServer,
  startTestWsServer,
  type TestRestServer,
  type TestWsServer,
} from '../helpers/test-server.js';

test.describe('request assertions', () => {
  let launched: LaunchedApp | undefined;
  let restServer: TestRestServer | undefined;
  let wsServer: TestWsServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await restServer?.close();
    restServer = undefined;
    await wsServer?.close();
    wsServer = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test("a REST request's status assertion is checked on Send", async () => {
    restServer = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Assertions');
    await createProject(page, 'Checks');
    await createApi(page, 'Petstore', restServer.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');

    await page
      .getByRole('tablist', { name: 'Request tabs' })
      .getByRole('tab', { name: /^Assertions/ })
      .click();
    await page.getByTestId('request-add-assertion').click(); // defaults to status 200
    await expect(page.getByTestId('request-assertion-row')).toHaveCount(1);

    await sendRest(page);
    const response = page.getByTestId('rest-response');
    await response.getByRole('tab', { name: /Assertions.*1\/1/ }).click();
    await expect(page.getByTestId('assertion-result')).toHaveCount(1);
    await expect(page.getByTestId('assertion-result').first().getByLabel('Passed')).toBeVisible();
  });

  test("a WebSocket request's JSONPath assertion reads a JSON message", async () => {
    test.setTimeout(120_000);
    wsServer = await startTestWsServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-request-assertions-'));

    // --- first launch: make the WebSocket API and its request, and save them ---------------------
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await createWorkspace(page, 'WS');
    await createProject(page, 'Feeds');
    const projectRow = page.getByTestId('explorer-project-row').first();
    await chooseContextMenuItem(page, projectRow, 'New WebSocket API…');
    await expect(page.getByTestId('ws-api-tab')).toBeVisible({ timeout: 20_000 });
    const apiNameField = page.getByTestId('ws-api-name');
    await apiNameField.fill('Echo API');
    await apiNameField.press('Enter');
    const apiUrlField = page.getByTestId('ws-api-url');
    await apiUrlField.fill(`${wsServer.url}/echo`);
    await apiUrlField.press('Enter');
    const wsApiRow = page.getByTestId('ws-api-row').filter({ hasText: 'Echo API' });
    await expect(wsApiRow).toBeVisible({ timeout: 20_000 });
    await chooseContextMenuItem(page, wsApiRow, 'New request');
    await expect(page.getByTestId('ws-editor')).toBeVisible({ timeout: 20_000 });
    const breadcrumbName = page.getByTestId('ws-breadcrumb-name');
    await breadcrumbName.dblclick();
    const nameInput = page.getByTestId('ws-breadcrumb-name-input');
    await nameInput.fill('Echo');
    await nameInput.press('Enter');
    await expect(breadcrumbName).toHaveText('Echo');
    await saveAll(page);

    await launched.close();
    launched = undefined;

    // --- the request file gains the assertion, as a hand edit or a pull would give it -------------
    const projectDir = workspaceProjectDir(userDataDir, 'Feeds');
    const requestsDir = join(projectDir, 'apis', 'Echo API', 'requests');
    const fileName = readdirSync(requestsDir).find((name) => name.endsWith('.request.yaml'));
    expect(fileName).toBeDefined();
    const file = join(requestsDir, fileName!);
    const saved = readFileSync(file, 'utf8').replace(/^assertions: \[\]\n/m, '');
    writeFileSync(
      file,
      `${saved.endsWith('\n') ? saved : `${saved}\n`}assertions:
  - type: match
    language: jsonpath
    expression: $[0].type
    equals: ready
`,
      'utf8',
    );

    // --- second launch: the request loads with it; connect, send JSON, wait for the echo, close ---
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;
    await expectReopenedWorkspace(page, 'WS');
    // The explorer's open state persists per workspace: wait for the tree before deciding to expand.
    const reopenedApiRow = page.getByTestId('ws-api-row').filter({ hasText: 'Echo API' });
    await expect(reopenedApiRow).toBeVisible({ timeout: 20_000 });
    const requestRow = page.getByTestId('ws-request-row').filter({ hasText: 'Echo' });
    if (!(await requestRow.isVisible())) {
      await reopenedApiRow.click();
    }
    await expect(requestRow).toBeVisible({ timeout: 20_000 });
    await requestRow.click();
    await expect(page.getByTestId('ws-editor')).toBeVisible({ timeout: 20_000 });
    await expect(
      page
        .getByTestId('ws-editor')
        .getByRole('tab', { name: /^Assertions/ })
        .first(),
    ).toContainText('1');

    await page.getByTestId('ws-connect').click();
    await expect(page.getByTestId('ws-state')).toContainText('open', { timeout: 20_000 });
    await page.getByTestId('ws-composer-text').fill('{"type":"ready"}');
    await page.getByTestId('ws-composer-send').click();
    await expect(page.getByTestId('ws-frame-row')).toHaveCount(2, { timeout: 20_000 });
    await page.getByTestId('ws-connect').click(); // Disconnect: the session is checked when it closes
    await expect(page.getByTestId('ws-state')).toContainText('closed', { timeout: 20_000 });

    await page
      .getByTestId('ws-response')
      .getByRole('tab', { name: /Assertions.*1\/1/ })
      .click();
    await expect(page.getByTestId('assertion-result').first().getByLabel('Passed')).toBeVisible({ timeout: 20_000 });
  });
});

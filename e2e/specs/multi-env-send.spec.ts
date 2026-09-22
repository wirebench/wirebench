import { expect, test, type Page } from '@playwright/test';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createProjectWithCalculator, createWorkspace, openFirstRequest } from '../helpers/project.js';
import { createApi, createRestRequest, saveRequest, setMethodAndUrl } from '../helpers/rest.js';
import {
  startTestRestServer,
  startTestSoapServer,
  type TestRestServer,
  type TestSoapServer,
} from '../helpers/test-server.js';

/**
 * Adds a workspace environment from the Environments view, renames it to `name`, and points the
 * endpoint labelled `overrideLabel` at `url`. A fresh environment is always *Environment 1* here:
 * the default name is the lowest free number, and every earlier one has been renamed.
 */
async function addEnvironment(page: Page, name: string, overrideLabel: string, url: string): Promise<void> {
  await openEnvironmentsView(page);
  await page.getByRole('button', { name: 'Add environment' }).click();
  const created = environmentRow(page, 'Environment 1');
  await expect(created).toBeVisible();
  await created.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Rename Environment 1').fill(name);
  await page.getByLabel('Rename Environment 1').press('Enter');
  await expect(environmentRow(page, name)).toBeVisible();

  // "Add environment" already opened this environment's page, and only the active tab renders,
  // so the override field below is this environment's alone.
  const override = page.getByLabel(overrideLabel);
  await expect(override).toBeVisible({ timeout: 20_000 });
  await override.fill(url);
  await override.press('Enter');
}

/** Makes `name` the active environment through the status-bar switcher. */
async function activateEnvironment(page: Page, name: string): Promise<void> {
  await page.getByTestId('env-switcher').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  await expect(page.getByTestId('env-switcher')).toContainText(name);
}

/**
 * Opens the picker from the open request's editor, ticks `dev` (already ticked as the active one)
 * and `test`, sends, and waits for the compare tab.
 */
async function compareDevAndTest(page: Page): Promise<void> {
  const action = page.getByTestId('send-to-environments');
  await expect(action).toBeEnabled({ timeout: 20_000 });
  await action.click();

  const picker = page.getByTestId('env-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByLabel('Include dev', { exact: true })).toBeChecked();
  await picker.getByLabel('Include test', { exact: true }).check();
  await expect(picker.getByLabel('Baseline dev', { exact: true })).toBeChecked();
  await picker.getByTestId('env-picker-send').click();
  await expect(picker).toBeHidden();

  await expect(page.getByTestId('env-compare')).toBeVisible({ timeout: 30_000 });
}

/**
 * The compare tab shows one column per environment with its status, marks `test` as differing in
 * body from the `dev` baseline, and diffs the two bodies.
 */
async function expectDevAndTestCompared(page: Page): Promise<void> {
  const compare = page.getByTestId('env-compare');
  const columns = compare.getByTestId('env-compare-column');
  await expect(columns).toHaveCount(2);
  await expect(compare.getByTestId('env-compare-error')).toHaveCount(0);
  const column = (name: string) => compare.locator(`[data-testid="env-compare-column"][aria-label="${name}"]`);
  for (const name of ['dev', 'test']) {
    await expect(column(name)).toHaveCount(1);
    await expect(column(name).getByTestId('env-compare-status')).toContainText('200');
  }
  await expect(column('dev').getByTestId('env-compare-baseline')).toBeVisible();
  await expect(column('test').getByTestId('env-compare-baseline')).toHaveCount(0);

  const verdicts = compare.getByTestId('env-compare-verdict');
  await expect(verdicts).toHaveCount(1);
  await expect(verdicts).toHaveAttribute('data-verdict', 'body-differs');
  await expect(verdicts).toContainText('test');
  await expect(verdicts).toContainText('body differs');

  // The diff below compares the baseline with the only other environment.
  const testId = await column('test').getAttribute('data-environment-id');
  expect(testId).not.toBeNull();
  await expect(compare.getByTestId('env-compare-other')).toHaveValue(testId ?? '');
  await expect(compare.getByTestId('env-compare-headers')).toBeVisible();

  // Monaco computes the diff after mounting; a changed line is drawn as an insert/delete decoration.
  const diff = compare.getByTestId('env-compare-diff');
  await expect(diff.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => diff.locator('.line-insert, .line-delete, .char-insert, .char-delete').count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
}

test.describe('multi-environment send', () => {
  let launched: LaunchedApp | undefined;
  let soapServers: TestSoapServer[] = [];
  let restServers: TestRestServer[] = [];

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    for (const server of [...soapServers, ...restServers]) {
      await server.close();
    }
    soapServers = [];
    restServers = [];
  });

  test('a SOAP request goes to two workspace environments and the responses are compared', async () => {
    // `dev` answers the calculator's Add; `test` echoes the envelope back — two different bodies.
    const dev = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    const testServer = await startTestSoapServer({ fixture: 'calculator' });
    soapServers = [dev, testServer];

    launched = await launchApp();
    const page = launched.window;
    await createProjectWithCalculator(page, dev);

    await addEnvironment(page, 'dev', 'Endpoint override for Calculator', `${dev.url}/soap`);
    await addEnvironment(page, 'test', 'Endpoint override for Calculator', `${testServer.url}/soap`);
    await activateEnvironment(page, 'dev');

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await openFirstRequest(page);
    await compareDevAndTest(page);
    await expectDevAndTestCompared(page);

    expect(dev.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(testServer.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    // Sending to `test` did not make it the active environment.
    await expect(page.getByTestId('env-switcher')).toContainText('dev');
    await expect(page.getByTestId('env-switcher')).not.toContainText('test');
  });

  test('a REST request goes to two workspace environments and the responses are compared', async () => {
    // Both echo the request; the `host` header each one saw carries its own port, so the bodies differ.
    const dev = await startTestRestServer();
    const testServer = await startTestRestServer();
    restServers = [dev, testServer];

    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', dev.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await saveRequest(page);

    await addEnvironment(page, 'dev', 'Endpoint override for Pets › Petstore', dev.url);
    await addEnvironment(page, 'test', 'Endpoint override for Pets › Petstore', testServer.url);
    await activateEnvironment(page, 'dev');

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await page.getByRole('button', { name: 'Expand all' }).click();
    const requestRow = page.getByTestId('rest-request-row').filter({ hasText: 'Echo' }).first();
    await expect(requestRow).toBeVisible({ timeout: 20_000 });
    await requestRow.click();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await compareDevAndTest(page);
    await expectDevAndTestCompared(page);

    expect(dev.requests.filter((request) => request.url.startsWith('/echo'))).toHaveLength(1);
    expect(testServer.requests.filter((request) => request.url.startsWith('/echo'))).toHaveLength(1);
    await expect(page.getByTestId('env-switcher')).toContainText('dev');
    await expect(page.getByTestId('env-switcher')).not.toContainText('test');
  });
});

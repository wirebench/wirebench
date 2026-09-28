import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  addHeader,
  chooseContextMenuItem,
  createApi,
  createRestRequest,
  saveRequest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/**
 * A two-step REST sequence, built and run from the UI: the first step's response carries a token,
 * a secret transfer lifts it, and the second step sends it as `Bearer ${#Sequence#token}` to a route
 * that answers 200 only to that token. The run panel shows both steps passing, and the token only as
 * `(secret)`.
 */
// Carried under a neutral name: a URL parameter called `token` is, rightly, something the save's secret
// scan stops to ask about. The transfer marks the value secret all the same.
const TOKEN = 'e2e-sequence-value-4d1f';

let server: TestRestServer;
let app: LaunchedApp;

test.beforeAll(async () => {
  server = await startTestRestServer({ bearerToken: TOKEN });
});

test.afterAll(async () => {
  await server.close();
});

test.afterEach(async () => {
  await app.close();
});

test('a sequence carries a secret token from one step to the next', async () => {
  app = await launchApp();
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Shop');
  await createApi(page, 'Shop API', server.url);

  await createRestRequest(page, 'Shop API', 'Log in');
  await setMethodAndUrl(page, 'GET', `/echo?value=${TOKEN}`);
  await saveRequest(page);

  await createRestRequest(page, 'Shop API', 'Me');
  await setMethodAndUrl(page, 'GET', '/auth/bearer');
  await addHeader(page, 'Authorization', 'Bearer ${#Sequence#token}');
  await saveRequest(page);

  await chooseContextMenuItem(page, page.getByTestId('explorer-project-row').first(), 'New Sequence');
  const tab = page.getByTestId('sequence-tab');
  await expect(tab).toBeVisible({ timeout: 20_000 });

  for (const name of ['Log in', 'Me']) {
    await tab.getByTestId('sequence-add-step').click();
    await page.getByTestId('sequence-add-step-input').fill(name);
    await page.getByTestId('sequence-add-step-item').filter({ hasText: name }).first().click();
  }
  await expect(tab.getByTestId('sequence-step')).toHaveCount(2);

  // The first step lifts the token, as a secret.
  await tab.getByTestId('sequence-step-select').first().click();
  await tab.getByTestId('sequence-add-transfer').click();
  const name = tab.getByTestId('sequence-transfer-name');
  await name.fill('token');
  await name.press('Enter');
  const expression = tab.getByTestId('sequence-transfer-expression');
  await expression.fill('$.query.value');
  await expression.press('Enter');
  await tab.getByTestId('sequence-transfer-secret').check();
  await expect(tab.getByTestId('sequence-transfer-secret')).toBeChecked();

  await tab.getByTestId('sequence-run').click();
  await expect(tab.getByTestId('sequence-run-status')).toHaveText('Run passed', { timeout: 30_000 });
  const steps = tab.getByTestId('sequence-run-step');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(1)).toContainText('200');
  await expect(tab.getByTestId('sequence-run-transfer')).toHaveText('→ token = (secret)');
  await expect(tab).not.toContainText(TOKEN);
});

import { expect, test } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  addHeader,
  createApi,
  createRestRequest,
  openRequestTab,
  openResponseTab,
  responseStatus,
  saveRequest,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/**
 * Request scripts (#63), from the UI against a real server:
 * - a log-in request's post-response script keeps the token it got as a secret session value, the
 *   next single send reads it as `${#Sequence#token}` and passes, and the token is shown only as
 *   `(secret)`;
 * - a type error in a pre-request script shows under the editor and stops the send.
 */
// Carried under a neutral name: a URL parameter called `token` is, rightly, something the save's secret
// scan stops to ask about. The script marks the value secret all the same.
const TOKEN = 'e2e-script-value-8b2e';

const LOGIN_SCRIPT = [
  'const body = response.json() as { query: Record<string, string> };',
  "vars.set('token', body.query['value'] ?? '', { secret: true });",
  "log('logged in with', body.query['value']);",
  "test('logged in', () => expect(response.status).toBe(200));",
].join('\n');

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

test("a log-in script's token reaches the next single send, and is shown only masked", async () => {
  app = await launchApp();
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Shop');
  await createApi(page, 'Shop API', server.url);

  await createRestRequest(page, 'Shop API', 'Log in');
  await setMethodAndUrl(page, 'GET', `/echo?value=${TOKEN}`);
  await openRequestTab(page, 'Scripts');
  await page
    .getByRole('tablist', { name: 'Scripts' })
    .getByRole('tab', { name: /Post-response/ })
    .click();
  await setMonacoText(page, 'Post-response script', LOGIN_SCRIPT);
  await saveRequest(page);

  await sendRest(page);
  await expect(responseStatus(page)).toContainText('200');
  await openResponseTab(page, 'Script');
  const results = page.getByTestId('script-results');
  await expect(results).toContainText('logged in');
  await expect(page.getByTestId('script-log')).toContainText('logged in with');
  await expect(page.getByTestId('script-log')).not.toContainText(TOKEN);

  // The explorer lists the session value without it.
  await page.getByTestId('values-group-row').click();
  await expect(page.getByTestId('value-row')).toHaveText(/token \(secret\)/, { timeout: 10_000 });

  await createRestRequest(page, 'Shop API', 'Me');
  await setMethodAndUrl(page, 'GET', '/auth/bearer');
  await addHeader(page, 'Authorization', 'Bearer ${#Sequence#token}');
  await saveRequest(page);
  await sendRest(page);
  await expect(responseStatus(page)).toContainText('200');
});

test('a type error in a pre-request script shows in the editor and stops the send', async () => {
  app = await launchApp();
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Shop');
  await createApi(page, 'Shop API', server.url);

  await createRestRequest(page, 'Shop API', 'Echo');
  await setMethodAndUrl(page, 'GET', '/echo');
  await openRequestTab(page, 'Scripts');
  await setMonacoText(page, 'Pre-request script', "request.headers.set('x-count', 1);");

  await expect(page.getByTestId('script-errors')).toContainText('1 error', { timeout: 30_000 });

  await page.getByTestId('rest-send').click();
  await expect(responseStatus(page)).toContainText('script-type-error', { timeout: 30_000 });
});

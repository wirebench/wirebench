/**
 * Importing a HAR capture, end to end.
 *
 * The unit suites prove the mapping and the dialog; what only the real app can prove is that a
 * recorded response kept as an example lands on the request in the project and can be opened from
 * the response pane's Examples menu, under the banner that says it is not a live response.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, restRequestRow } from '../helpers/rest.js';

/** One HAR 1.2 entry: a GET to `url` answered with `status` and a JSON body. */
function harEntry(url: string, status: number, statusText: string, body: string) {
  return {
    startedDateTime: '2026-10-04T10:00:00.000Z',
    time: 12,
    request: {
      method: 'GET',
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [{ name: 'Accept', value: 'application/json' }],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status,
      statusText,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      content: { size: body.length, mimeType: 'application/json', text: body },
      redirectURL: '',
      headersSize: -1,
      bodySize: body.length,
    },
    cache: {},
    timings: { send: 1, wait: 10, receive: 1 },
  };
}

/** Two recordings of the same call, answered differently: one request, two examples. */
const HAR = {
  log: {
    version: '1.2',
    creator: { name: 'e2e', version: '1' },
    entries: [
      harEntry('https://api.example.com/pets', 200, 'OK', '[{"id":1}]'),
      harEntry('https://api.example.com/pets', 404, 'Not Found', '{"error":"none"}'),
    ],
  },
};

test.describe('HAR import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('imports a HAR with recorded responses as examples and shows one', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Traffic');

    await openImportDialog(page);
    await page.getByTestId('import-format-select').selectOption('har');
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(JSON.stringify(HAR));
    await page.getByTestId('import-har-responses-examples').check();
    await page.getByTestId('import-submit').click();

    const summary = page.getByTestId('import-har-summary');
    await expect(summary).toContainText('1 request', { timeout: 30_000 });
    await expect(summary).toContainText('examples saved');
    await page.getByTestId('import-done').click();

    await expect(apiRow(page, 'api.example.com')).toBeVisible({ timeout: 20_000 });
    await apiRow(page, 'api.example.com').click();
    await restRequestRow(page, 'GET /pets').dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('rest-examples-menu').click();
    await page.getByRole('menuitem', { name: /404 Not Found — recorded/ }).click();
    await expect(page.getByTestId('rest-example-banner')).toBeVisible();
  });
});

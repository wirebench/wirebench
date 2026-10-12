import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * The Runner (#336), from the explorer: Run… on an API opens its Runner tab, a CSV chosen through the
 * file dialog drives one iteration per row, each row's value reaches the request as `${#Data#user}` in a header,
 * and the results come back grouped by iteration. The tab names the data file and never its folder.
 */
let server: TestRestServer;
let app: LaunchedApp;

test.beforeAll(async () => {
  server = await startTestRestServer();
});

test.afterAll(async () => {
  await server.close();
});

test.afterEach(async () => {
  await app.close();
});

test('an API runs once per data row from its Runner tab', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-runner-'));
  const dataFile = join(dataDir, 'users.csv');
  writeFileSync(dataFile, 'user\nann\nbob\n');

  app = await launchApp({ extraEnv: { WIREBENCH_E2E_FILE_DIALOG_PATH: dataFile } });
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Shop');
  await createApi(page, 'Shop API', server.url);
  await createRestRequest(page, 'Shop API', 'Echo');
  await setMethodAndUrl(page, 'GET', '/echo');
  // A header, not the query: the URL field reads a `#` there as the start of a fragment.
  await addHeader(page, 'X-User', '${#Data#user}');
  await saveRequest(page);

  await chooseContextMenuItem(page, page.getByTestId('api-row').first(), 'Run…');
  const tab = page.getByTestId('runner-tab');
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(tab.getByTestId('runner-request')).toHaveCount(1);

  await tab.getByTestId('runner-data-choose').click();
  await expect(tab.getByTestId('runner-data')).toHaveText('users.csv — 2 rows: user');

  await tab.getByTestId('runner-run').click();
  await expect(tab.getByTestId('runner-status')).toContainText('2 passed, 0 failed, 0 errored, 2 iterations', {
    timeout: 30_000,
  });
  await expect(tab.getByTestId('runner-iteration')).toHaveCount(2);
  await expect(tab.getByTestId('runner-history-entry')).toHaveCount(1);
  await expect(tab).not.toContainText(dataDir);
});

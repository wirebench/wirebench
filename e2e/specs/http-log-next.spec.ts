import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { addHeader, createApi, createRestRequest, responseStatus, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';
import { logRows, selectLogRow } from '../helpers/http-log.js';

test.describe('HTTP Log: export, reuse, search, waterfall, compare', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    launched = undefined;
    if (server) {
      await server.close();
    }
    server = undefined;
  });

  test('S1: an unparseable base URL produces a "Failed · before send" row', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Broken', 'ht!tp://');
    await createRestRequest(page, 'Broken', 'Bad');
    await setMethodAndUrl(page, 'GET', '/x');
    await sendRest(page);
    // The engine refuses the URL while composing it, before any request is built.
    await expect(responseStatus(page)).toContainText(/rest-url-incomplete|invalid-url/);

    const row = logRows(page).last();
    await expect(row).toHaveAttribute('data-kind', 'failure');
    await expect(row.getByTestId('http-log-status')).toHaveText('Failed · before send');
    await selectLogRow(row);
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByTestId('log-detail-error')).toContainText('never went on the wire');
  });

  test('S2: a row copies as cURL with its method, URL and a masked credential', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await addHeader(page, 'Authorization', 'Bearer e2e-placeholder');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');

    const row = logRows(page).last();
    await row.click({ button: 'right', position: { x: 8, y: 8 } });
    await page.getByRole('menuitem', { name: 'Copy as cURL (POSIX)' }).click();
    const app = launched.app;
    await expect
      .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toContain(`${server.url}/echo`);
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain('Authorization: <redacted>');
    expect(copied).not.toContain('e2e-placeholder');
  });
  test('S3: Export HAR writes the shown rows with no secret in them', async () => {
    server = await startTestRestServer();
    const harPath = join(mkdtempSync(join(tmpdir(), 'wb-har-')), 'log.har');
    launched = await launchApp({ extraEnv: { WIREBENCH_E2E_DIALOG_SAVE: harPath } });
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await addHeader(page, 'Authorization', 'Bearer e2e-placeholder');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');

    await page.getByRole('button', { name: 'Export HAR' }).click();
    await expect.poll(() => existsSync(harPath)).toBe(true);
    const text = readFileSync(harPath, 'utf8');
    const har = JSON.parse(text) as { log: { version: string; entries: { request: { url: string } }[] } };
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0]?.request.url).toBe(`${server.url}/echo`);
    // The echo route returns the Authorization header in its JSON body too: both must be masked.
    expect(text).not.toContain('e2e-placeholder');
  });
});

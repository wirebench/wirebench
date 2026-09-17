import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { addHeader, createApi, createRestRequest, responseStatus, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';
import { selectLogRow } from '../helpers/http-log.js';

test.describe('HTTP Log: failed sends, filter bar and detail tabs', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    await server?.close();
    server = undefined;
  });

  test('a send to a closed port produces a connection-refused row, and the failed chip narrows to it', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');

    // One send that works, so the filter has something to hide.
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');

    // Port 1 is reserved and nothing listens on it: the connection is refused at once. The
    // response pane header behaves exactly as before — it shows the error — and the log now
    // keeps a row for it.
    await createApi(page, 'Dead', 'http://127.0.0.1:1');
    await createRestRequest(page, 'Dead', 'Nope');
    await setMethodAndUrl(page, 'GET', '/nope');
    // A credential header, so the row has something redacted and the Headers tab explains it.
    await addHeader(page, 'Authorization', 'Bearer e2e-placeholder');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('connection-refused');

    const rows = page.locator('[data-testid="http-log-row"]');
    await expect(rows).toHaveCount(2);
    const failed = rows.last();
    await expect(failed).toHaveAttribute('data-kind', 'failure');
    await expect(failed).toContainText('rest');
    await expect(failed).toContainText('GET');
    await expect(failed).toContainText('http://127.0.0.1:1/nope');
    await expect(failed.getByTestId('http-log-status')).toHaveText('connection-refused');
    await expect(failed.getByTestId('http-log-status')).toHaveClass(/text-status-danger/);
    await expect(failed).toContainText(/\d+(\.\d)? ms/);

    // The detail tabs: the engine's message on Response, the redaction note on Headers.
    await selectLogRow(failed);
    const tabs = page.getByRole('tablist', { name: 'Log detail' });
    await tabs.getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByTestId('log-detail-error')).toContainText('connection-refused');
    await expect(page.getByTestId('log-detail-error')).toContainText('Connection refused');
    await tabs.getByRole('tab', { name: 'Headers' }).click();
    await expect(page.getByTestId('log-detail-redaction-note')).toBeVisible();
    await expect(page.getByTestId('log-detail-request-headers')).toContainText('<redacted>');
    await expect(page.getByTestId('log-detail-request-headers')).not.toContainText('e2e-placeholder');

    // The filter bar: `failed` narrows to the one row, the count says so, Reset brings both back.
    const bar = page.getByTestId('http-log-filter');
    await expect(page.getByTestId('http-log-count')).toHaveText('2 of 2');
    await bar.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'failed' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-kind', 'failure');
    await expect(page.getByTestId('http-log-count')).toHaveText('1 of 2');
    await bar.getByRole('button', { name: 'Reset' }).click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('http-log-count')).toHaveText('2 of 2');
  });
});

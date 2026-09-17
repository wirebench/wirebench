import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';
import { selectLogRow } from '../helpers/http-log.js';

/**
 * Inspector strip end-to-end. TLS is deliberately absent here: the SSL Info inspector needs a
 * server whose CA the *packaged* app trusts, which would mean installing a test root into the
 * launched Electron process. The TLS capture it renders is covered by the engine's
 * `test/integration/http/tls.test.ts` instead; this spec covers the strip, headers and timings.
 */
test.describe('Inspectors (Headers, timings)', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    for (const dir of [userDataDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
  });

  test('a header added in the inspector is sent, and the response headers and timings come back', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await openFirstRequest(page);

    // The /headers route echoes the request headers back as JSON — so what the response pane
    // shows IS what the server received.
    await page.getByTestId('request-endpoint').fill(`${server.url}/headers`);

    // Request pane → Headers inspector → add X-Trace: abc.
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Headers' }).click();
    await page.getByLabel('New header name').fill('X-Trace');
    await page.getByLabel('New header value').fill('abc');
    await page.getByRole('button', { name: 'Add header' }).click();
    await expect(page.getByLabel('Name of header 1')).toHaveValue('X-Trace');

    await page.locator('[data-testid="request-send"]').click();
    await expect(page.locator('[data-testid="response-status"]')).toContainText('200', { timeout: 10_000 });

    // The echoed JSON proves the custom header went out on the wire.
    await expect(page.getByTestId('response-editor')).toContainText('"x-trace":"abc"', { timeout: 10_000 });

    // Response pane → Headers inspector lists what came back.
    await page.getByRole('tablist', { name: 'Response inspectors' }).getByRole('tab', { name: 'Headers' }).click();
    const responseHeaders = page.getByRole('table', { name: 'Response headers' });
    await expect(responseHeaders).toBeVisible({ timeout: 10_000 });
    await expect(responseHeaders).toContainText('content-type');

    // SSL Info says, honestly, that this exchange was plain HTTP.
    await page.getByRole('tablist', { name: 'Response inspectors' }).getByRole('tab', { name: 'SSL Info' }).click();
    await expect(page.getByText(/No TLS — plain HTTP/)).toBeVisible({ timeout: 10_000 });

    // The HTTP log's detail breaks the exchange down into a timings bar with a total.
    await selectLogRow(page.locator('[data-testid="http-log-row"]').first());
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Timing' }).click();
    await expect(page.getByTestId('timings-total')).toContainText(/total \d+ ms/, { timeout: 10_000 });
    await expect(page.getByTestId('timings-legend')).toContainText('ttfb');
    expect(await page.locator('[data-testid="timings-segment"]').count()).toBeGreaterThan(0);
  });
});

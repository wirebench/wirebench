/**
 * WS-Trust end to end (#41): an Issued Token entry asks a token service for a SAML assertion, the
 * session caches it, and each request to the service is one HTTP Log row.
 *
 * The token service is the engine's test STS (HTTPS, a CA made at run time and added through
 * Preferences → SSL, as the TLS trust spec does) answering with the recorded SAML 2.0 response,
 * whose lifetime is moved to 2099 so the cache keeps it. The SOAP service is the in-process stub.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startTestSts, type TestSts } from '@wirebench/engine/test-helpers';
import { logRows } from '../helpers/http-log.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'sts-secret-long-7d41';

/** The recorded response's lifetime has passed; push it far enough ahead that the cache keeps it. */
const ASSERTION = readFileSync(
  fileURLToPath(new URL('../../packages/engine/test/fixtures/ws-trust/rstrc-1.3-saml2.xml', import.meta.url)),
  'utf8',
).replace(/2026-10-05T/g, '2099-10-05T');

test.describe('ws-trust issued token', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let sts: TestSts | undefined;
  let userDataDir: string | undefined;
  let certsDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    if (sts) {
      await sts.close();
      sts = undefined;
    }
    for (const dir of [userDataDir, certsDir]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
    userDataDir = undefined;
    certsDir = undefined;
  });

  test('fetches once, reuses the cached token, and fetches again after Clear', async () => {
    sts = await startTestSts(() => ({ status: 200, body: ASSERTION }));
    server = await startTestSoapServer({ fixture: 'calculator' });
    certsDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-certs-'));
    const bundlePath = join(certsDir, 'sts-ca.pem');
    writeFileSync(bundlePath, sts.caPem);

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: bundlePath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'WS-Trust Project' });
    await openFirstRequest(page);

    // --- trust the token service's CA through Preferences → SSL -----------------------------
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('preferences-editor').getByRole('button', { name: 'SSL', exact: true }).click();
    await page.getByTestId('ssl-ca-bundle-browse').click();
    await expect(page.getByTestId('ssl-ca-bundle')).toHaveValue(bundlePath);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preferences-dialog')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Request 1' }).click();
    await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });

    // --- add an Issued Token entry pointing at the token service ----------------------------
    await page.getByRole('button', { name: 'WS-Security' }).click();
    await expect(page.getByTestId('wss-section')).toBeVisible();
    await page.getByTestId('wss-outgoing-add').click();
    const row = page.getByTestId('wss-outgoing-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { expanded: false }).click();
    const editor = page.getByTestId('wss-outgoing-editor');
    await expect(editor).toBeVisible();

    await editor.getByLabel('Add entry').selectOption('issued-token');
    await expect(page.getByTestId('wss-entry-row')).toHaveCount(1);
    await editor.getByLabel('STS URL').fill(sts.url);
    await editor.getByLabel('Credential', { exact: true }).selectOption('username');
    await editor.getByLabel('STS username').fill('alice');
    await editor.getByRole('button', { name: 'Set…' }).click();
    await editor.getByPlaceholder('Enter password').fill(PASSWORD);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor.getByText('••••••••')).toBeVisible();

    // --- select it on Request 1 and send twice ----------------------------------------------
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    await page.getByTestId('request-wss-outgoing').selectOption({ label: 'Outgoing WSS' });
    await page.getByTestId('request-endpoint').fill(`${server.url}/soap`);
    for (let sent = 0; sent < 2; sent += 1) {
      await page.getByTestId('request-send').click();
      await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });
    }

    // --- one token request: one STS row, whose name carries the request's ---------------------
    const stsRows = logRows(page).filter({ hasText: 'STS ·' });
    await expect(stsRows).toHaveCount(1);
    await expect(stsRows.first()).toContainText('STS · Request 1');
    expect(sts.requests).toHaveLength(1);

    // --- the entry's status line reads the cached token (re-open the entry to re-read it) -----
    // Clicking the active view closes it, so only click when the section is not showing.
    if (!(await page.getByTestId('wss-section').isVisible())) {
      await page.getByRole('button', { name: 'WS-Security' }).click();
    }
    await expect(page.getByTestId('wss-section')).toBeVisible();
    if (!(await editor.isVisible())) {
      await row.getByRole('button', { expanded: false }).click();
    }
    await expect(page.getByTestId('issued-token-state')).toContainText('Valid until', { timeout: 10_000 });

    // --- Clear drops it, and the next send asks the token service again ---------------------
    await page.getByTestId('issued-token-clear').click();
    await expect(page.getByTestId('issued-token-state')).toContainText('No token cached');
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });
    await expect(stsRows).toHaveCount(2);
    expect(sts.requests).toHaveLength(2);
  });
});

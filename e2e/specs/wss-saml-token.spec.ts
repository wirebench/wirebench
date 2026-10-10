/**
 * A form SAML token in outgoing WS-Security end to end: add a SAML Token entry (Form, Issuer
 * `urn:e2e`, Subject `alice`) to an outgoing configuration, select it on Request 1, send to the
 * in-process SOAP stub, and read the assertion off the wire in the HTTP Log's raw request.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { selectLogRow } from '../helpers/http-log.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('wss saml token', () => {
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
    if (userDataDir !== undefined) rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = undefined;
  });

  test('places a form SAML 2.0 assertion in wsse:Security, visible in the HTTP Log', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'WSS SAML Project' });
    await openFirstRequest(page);

    // --- build the outgoing configuration ---------------------------------------------------
    await page.getByRole('button', { name: 'WS-Security' }).click();
    await expect(page.getByTestId('wss-section')).toBeVisible();
    await page.getByTestId('wss-outgoing-add').click();

    const row = page.getByTestId('wss-outgoing-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { expanded: false }).click();
    const editor = page.getByTestId('wss-outgoing-editor');
    await expect(editor).toBeVisible();

    await editor.getByLabel('Add entry').selectOption('saml-token');
    await expect(page.getByTestId('wss-entry-row')).toHaveCount(1);
    await editor.getByRole('radio', { name: 'Form' }).check();
    await editor.getByLabel('Issuer', { exact: true }).fill('urn:e2e');
    await editor.getByLabel('Subject', { exact: true }).fill('alice');

    // --- select it on Request 1 and send ----------------------------------------------------
    await page.getByRole('tablist', { name: 'Request tabs' }).getByRole('tab', { name: 'Auth' }).click();
    await page.getByTestId('request-wss-outgoing').selectOption({ label: 'Outgoing WSS' });

    await page.getByTestId('request-endpoint').fill(`${server.url}/soap`);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    // --- the HTTP Log's raw request carries the assertion -----------------------------------
    await selectLogRow(page.locator('[data-testid="http-log-row"]').last());
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Request' }).click();
    const rawRequest = page.getByLabel('Raw request');
    await expect(rawRequest).toContainText('<saml2:Assertion', { timeout: 10_000 });
    await expect(rawRequest).toContainText('urn:e2e');
  });
});

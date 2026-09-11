/**
 * Per-endpoint certificate trust, end to end.
 *
 * A server signed by a CA the app does not know is unreachable by default — the send fails with
 * the `tls-untrusted` problem rather than quietly succeeding. Turning on the endpoint's "Trust
 * invalid certificates" makes it reachable and, from that moment, badges the endpoint in red in
 * all three places it can be seen: its row in the Endpoints dialog, the request toolbar and the
 * status bar. Turning it back off restores the failure, so the badge and the behaviour cannot
 * drift apart.
 *
 * Certificates are generated into a temp folder at run time; nothing is checked in.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { generateServerCert, generateTestCa } from '@wirebench/engine/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('endpoint TLS trust', () => {
  let launched: LaunchedApp | undefined;
  let plain: TestSoapServer | undefined;
  let secure: TestSoapServer | undefined;
  let userDataDir: string | undefined;
  let projectDir: string | undefined;
  let certsDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    for (const server of [plain, secure]) {
      if (server) await server.close();
    }
    plain = undefined;
    secure = undefined;
    for (const dir of [userDataDir, projectDir, certsDir]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
    userDataDir = undefined;
    projectDir = undefined;
    certsDir = undefined;
  });

  test('reaches a private-CA server once its CA bundle is configured in Preferences', async () => {
    const ca = generateTestCa();
    const serverCert = generateServerCert(ca, { commonName: 'localhost', sans: ['localhost', '127.0.0.1'] });

    certsDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-certs-'));
    const bundlePath = join(certsDir, 'corp-ca.pem');
    writeFileSync(bundlePath, ca.certPem);

    plain = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    secure = await startTestSoapServer({
      fixture: 'calculator',
      respondToCalculatorAdd: true,
      tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem },
    });

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'CA Project');
    launched = await launchApp({
      userDataDir,
      folderDialogPath: projectDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: bundlePath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, plain, { expectProjectName: 'CA Project' });
    await openFirstRequest(page);

    // --- configure the CA bundle through Preferences → SSL ----------------------------------
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('preferences-editor').getByRole('button', { name: 'SSL', exact: true }).click();
    // The path is never typed: Browse… asks main to run the picker (pinned here with
    // `WIREBENCH_E2E_OPEN_PATH`), and main records the pick and persists the path itself. The
    // field is read-only, so what it shows is what main stored.
    await page.getByTestId('ssl-ca-bundle-browse').click();
    await expect(page.getByTestId('ssl-ca-bundle')).toHaveValue(bundlePath);
    await expect(page.getByTestId('ssl-ca-bundle')).toHaveAttribute('readonly', '');
    // Verification itself is untouched: the anchor is added, nothing is trusted blindly.
    const trustAll = page.getByLabel('Trust all certificates');
    await expect(trustAll).not.toBeChecked();
    await expect(trustAll).toBeDisabled();

    // --- the private-CA server is now reachable, with no per-endpoint opt-out ----------------
    await page.getByRole('tab', { name: 'Request 1' }).click();
    await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('request-endpoint').fill(`${secure.url}/soap`);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });
    await expect(page.getByTestId('toolbar-trust-invalid')).toHaveCount(0);
  });

  test('refuses an untrusted certificate, and sends once the endpoint opts in — with a red badge', async () => {
    const ca = generateTestCa();
    const serverCert = generateServerCert(ca, { commonName: 'localhost', sans: ['localhost', '127.0.0.1'] });

    // The WSDL is imported over plain HTTP; the *send* goes to the TLS server, whose CA the app
    // is deliberately never told about.
    plain = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    secure = await startTestSoapServer({
      fixture: 'calculator',
      respondToCalculatorAdd: true,
      tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem },
    });

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'TLS Project');
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, plain, { expectProjectName: 'TLS Project' });
    await openFirstRequest(page);

    // --- point the interface's endpoint at the TLS server -----------------------------------
    // The flag belongs to the *endpoint*, not to a URL typed into the toolbar, so the endpoint
    // itself is edited rather than the request being given a one-off address.
    await page.getByTestId('request-endpoint-menu').click();
    await page.getByRole('menuitem', { name: 'Edit endpoints…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit' }).first().click();
    await dialog.getByRole('textbox', { name: 'Endpoint URL', exact: true }).fill(`${secure.url}/soap`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('request-endpoint')).toHaveValue(`${secure.url}/soap`);

    // --- by default the send fails, and says why --------------------------------------------
    await expect(page.getByTestId('toolbar-trust-invalid')).toHaveCount(0);
    await page.getByTestId('request-send').click();
    await page.getByTestId('status-bar-problems').click();
    await expect(
      page
        .getByTestId('problem-row')
        .filter({ hasText: /not trusted/i })
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });

    // --- turn on "Trust invalid certificates" for that endpoint -----------------------------
    await page.getByTestId('request-endpoint-menu').click();
    await page.getByRole('menuitem', { name: 'Edit endpoints…' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit' }).first().click();
    await dialog.getByTestId('endpoint-trust-invalid').check();
    // The badge appears on the endpoint's own row the moment the flag is set.
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByTestId('trust-invalid-badge')).toBeVisible();
    await page.keyboard.press('Escape');

    // --- the badge is permanent, in the toolbar and the status bar --------------------------
    await expect(page.getByTestId('toolbar-trust-invalid')).toBeVisible();
    await expect(page.getByTestId('status-bar-trust-invalid')).toBeVisible();

    // --- and the send now goes through ------------------------------------------------------
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    // --- turning it off puts the failure (and removes the badge) back ------------------------
    await page.getByTestId('request-endpoint-menu').click();
    await page.getByRole('menuitem', { name: 'Edit endpoints…' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit' }).first().click();
    await dialog.getByTestId('endpoint-trust-invalid').uncheck();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('toolbar-trust-invalid')).toHaveCount(0);
    await expect(page.getByTestId('status-bar-trust-invalid')).toHaveCount(0);
  });
});

/**
 * Client keystores end to end: add a PKCS#12 through the WS-Security view, see it load, select
 * it as a request's SSL keystore, and send to a server that demands a client certificate.
 *
 * The keystore is generated into a temp folder in this spec (no binary fixture is checked in)
 * and the file picker is pinned with `WIREBENCH_E2E_OPEN_PATH`, so the add goes through exactly
 * the containment path a real pick does.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  generateClientCert,
  generateClientPkcs12,
  generateServerCert,
  generateTestCa,
} from '@wirebench/engine/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'keystore-password';

test.describe('keystores', () => {
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

  test('adds a PKCS#12, lists its alias, and presents it to a server that demands a client certificate', async () => {
    const ca = generateTestCa();
    const serverCert = generateServerCert(ca, { commonName: 'localhost', sans: ['localhost', '127.0.0.1'] });
    const client = generateClientCert(ca);

    certsDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-certs-'));
    const keystorePath = join(certsDir, 'corp.p12');
    writeFileSync(keystorePath, generateClientPkcs12(ca, client, { password: PASSWORD }));
    // The test CA is trusted the way a user configures trust — as an extra anchor, with
    // verification left on. A keystore supplies a client *identity* and nothing else, so it can
    // never make an otherwise-untrusted server verify.
    const trustPath = join(certsDir, 'test-ca.pem');
    writeFileSync(trustPath, ca.certPem);

    // The WSDL is imported over plain HTTP; the *send* goes to the mutual-TLS server.
    plain = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    secure = await startTestSoapServer({
      fixture: 'calculator',
      respondToCalculatorAdd: true,
      tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem, requestCert: true },
    });

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Keystore Project');
    launched = await launchApp({
      userDataDir,
      folderDialogPath: projectDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: keystorePath, WIREBENCH_E2E_EXTRA_CA_FILE: trustPath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, plain, { expectProjectName: 'Keystore Project' });
    await openFirstRequest(page);

    // --- add the keystore through the WS-Security view --------------------------------------
    await page.getByRole('button', { name: 'WS-Security' }).click();
    await expect(page.getByTestId('wss-section')).toBeVisible();

    await page.getByLabel('Add keystore').click();
    await page.getByTestId('keystore-browse').click();
    await expect(page.getByTestId('keystore-path')).toHaveValue(keystorePath);
    await expect(page.getByTestId('keystore-name')).toHaveValue('corp');

    const dialog = page.getByTestId('keystore-add-dialog');
    await dialog.getByRole('button', { name: 'Set…' }).click();
    await dialog.getByPlaceholder('Enter password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('keystore-add-submit').click();

    // --- the row loads, and its alias is listed ---------------------------------------------
    const row = page.getByTestId('keystore-row');
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('keystore-status')).toHaveText('Loaded', { timeout: 15_000 });

    await row.getByRole('button', { expanded: false }).click();
    const alias = page.getByTestId('keystore-alias-row');
    await expect(alias).toHaveCount(1);
    await expect(alias.first()).toContainText('client');
    await expect(alias.first()).toContainText('CN=wirebench-client');

    // --- select it for Request 1 and send over mutual TLS ------------------------------------
    await page.getByTestId('request-endpoint').fill(`${secure.url}/soap`);
    await page.getByTestId('request-ssl-keystore').selectOption({ label: 'corp' });

    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    // The SSL inspector proves the identity was actually presented, not merely configured.
    await page.getByRole('tablist', { name: 'Response inspectors' }).getByRole('tab', { name: 'SSL Info' }).click();
    await expect(page.getByTestId('ssl-client-certificate')).toContainText('CN=wirebench-client', {
      timeout: 15_000,
    });
  });
});

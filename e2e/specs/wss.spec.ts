/**
 * Outgoing WS-Security end to end: build a configuration with a Timestamp and a digest
 * UsernameToken in the WS-Security view, select it on Request 1, and send it to the echoing
 * `/soap` route — which hands the secured envelope straight back, proving the header was on
 * the wire and not merely configured.
 *
 * Two secrecy claims ride along: the raw request view shows the password masked, and the
 * configuration on disk carries a `passwordRef` and never the password itself.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { monacoModelText } from '../helpers/editor.js';
import {
  generateClientCert,
  generateClientPkcs12,
  generateSigningCert,
  generateTestCa,
} from '@wirebench/engine/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest, saveAll, workspaceProjectDir } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'wss-secret';

/** Every file path under `dir`, recursively (files only). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    out.push(...(statSync(full).isDirectory() ? listFiles(full) : [full]));
  }
  return out;
}

test.describe('wss', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
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
    for (const dir of [userDataDir, certsDir]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
    userDataDir = undefined;
    certsDir = undefined;
  });

  test('applies a Timestamp and a digest UsernameToken at send time, with the password masked and never on disk', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'WSS Project' });
    const projectDir = workspaceProjectDir(userDataDir);
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

    await editor.getByLabel('Add entry').selectOption('timestamp');
    await editor.getByLabel('Add entry').selectOption('username-token');
    await expect(page.getByTestId('wss-entry-row')).toHaveCount(2);

    await editor.getByRole('textbox', { name: 'Username' }).fill('bob');
    await expect(editor.getByLabel('Password type')).toHaveValue('digest');
    const password = page.getByTestId('wss-entry-password');
    await password.getByRole('button', { name: 'Set…' }).click();
    await password.getByPlaceholder('Enter password').fill(PASSWORD);
    await password.getByRole('button', { name: 'Save' }).click();
    await expect(password.getByText('••••••••')).toBeVisible();

    // --- select it on Request 1 and send ----------------------------------------------------
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    await page.getByTestId('request-wss-outgoing').selectOption({ label: 'Outgoing WSS' });

    await page.getByTestId('request-endpoint').fill(`${server.url}/soap`);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    // The echo route hands the envelope back verbatim, so the response *is* what went out.
    const responseEditor = page.getByTestId('response-editor');
    await expect(responseEditor).toContainText('wsse:Security', { timeout: 15_000 });
    await expect(responseEditor).toContainText('wsu:Timestamp');
    await expect(responseEditor).toContainText('wsse:UsernameToken');
    await expect(responseEditor).toContainText('PasswordDigest');

    // --- the raw request masks the password -------------------------------------------------
    await page.getByRole('tab', { name: 'Raw' }).first().click();
    const requestRaw = page.getByLabel('Request raw bytes');
    await expect(requestRaw).toBeVisible({ timeout: 10_000 });
    await expect(requestRaw).toContainText('wsse:UsernameToken');
    await expect(requestRaw).not.toContainText(PASSWORD);

    // Saving is manual by default, so say when the project should be on disk before reading it.
    await saveAll(page);

    // --- and the configuration on disk carries only a reference ------------------------------
    const passwordRefPattern = /passwordRef:\s*['"]?([\w.:-]+)['"]?/;
    await expect
      .poll(
        () =>
          listFiles(projectDir)
            .filter((file) => file.includes(join('wss', 'outgoing')))
            .map((file) => readFileSync(file, 'utf8'))
            .find((text) => passwordRefPattern.test(text)),
        { timeout: 20_000 },
      )
      .not.toBeUndefined();
    for (const file of listFiles(projectDir)) {
      expect(readFileSync(file, 'utf8')).not.toContain(PASSWORD);
    }
  });

  test('signs the Body and the Timestamp with a keystore identity', async () => {
    const ca = generateTestCa();
    const client = generateClientCert(ca);
    certsDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-certs-'));
    const keystorePath = join(certsDir, 'signer.p12');
    writeFileSync(keystorePath, generateClientPkcs12(ca, client, { password: PASSWORD }));

    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: keystorePath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'WSS Sign Project' });
    await openFirstRequest(page);

    // --- add the signing keystore -----------------------------------------------------------
    await page.getByRole('button', { name: 'WS-Security' }).click();
    await expect(page.getByTestId('wss-section')).toBeVisible();
    await page.getByLabel('Add keystore').click();
    await page.getByTestId('keystore-browse').click();
    const addDialog = page.getByTestId('keystore-add-dialog');
    await addDialog.getByRole('button', { name: 'Set…' }).click();
    await addDialog.getByPlaceholder('Enter password').fill(PASSWORD);
    await addDialog.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('keystore-add-submit').click();
    await expect(page.getByTestId('keystore-status')).toHaveText('Loaded', { timeout: 15_000 });

    // --- a configuration with a Timestamp and a Signature -----------------------------------
    await page.getByTestId('wss-outgoing-add').click();
    const row = page.getByTestId('wss-outgoing-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { expanded: false }).click();
    const editor = page.getByTestId('wss-outgoing-editor');
    await expect(editor).toBeVisible();

    await editor.getByLabel('Add entry').selectOption('timestamp');
    await editor.getByLabel('Add entry').selectOption('signature');
    await expect(page.getByTestId('wss-entry-row')).toHaveCount(2);
    await editor.getByLabel('Signature keystore').selectOption({ label: 'signer' });
    await expect(editor.getByLabel('Signature alias')).toBeVisible();
    await expect(page.getByTestId('wss-part-row')).toHaveCount(2);

    // --- select it on Request 1 and send ----------------------------------------------------
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    await page.getByTestId('request-wss-outgoing').selectOption({ label: 'Outgoing WSS' });

    await page.getByTestId('request-endpoint').fill(`${server.url}/soap`);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    // The echo route hands the envelope back verbatim, so this *is* what went out.
    const responseEditor = page.getByTestId('response-editor');
    await expect(responseEditor).toContainText('ds:Signature', { timeout: 15_000 });
    await expect(responseEditor).toContainText('wsse:BinarySecurityToken');
    // Two references — one for the Body's generated wsu:Id, one for the Timestamp's.
    await expect.poll(() => monacoModelText(page)).toContain('<ds:Reference URI="#Id-');
    await expect.poll(() => monacoModelText(page)).toContain('<ds:Reference URI="#TS-');
  });

  test('encrypts the Body against a keystore certificate, so the plaintext never reaches the wire', async () => {
    const ca = generateTestCa();
    const client = generateClientCert(ca);
    certsDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-certs-'));
    const keystorePath = join(certsDir, 'recipient.p12');
    writeFileSync(keystorePath, generateClientPkcs12(ca, client, { password: PASSWORD }));

    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: keystorePath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'WSS Encrypt Project' });
    await openFirstRequest(page);

    // --- add the recipient keystore ---------------------------------------------------------
    await page.getByRole('button', { name: 'WS-Security' }).click();
    await expect(page.getByTestId('wss-section')).toBeVisible();
    await page.getByLabel('Add keystore').click();
    await page.getByTestId('keystore-browse').click();
    const addDialog = page.getByTestId('keystore-add-dialog');
    await addDialog.getByRole('button', { name: 'Set…' }).click();
    await addDialog.getByPlaceholder('Enter password').fill(PASSWORD);
    await addDialog.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('keystore-add-submit').click();
    await expect(page.getByTestId('keystore-status')).toHaveText('Loaded', { timeout: 15_000 });

    // --- a configuration with a single Encryption entry --------------------------------------
    await page.getByTestId('wss-outgoing-add').click();
    const row = page.getByTestId('wss-outgoing-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { expanded: false }).click();
    const editor = page.getByTestId('wss-outgoing-editor');
    await expect(editor).toBeVisible();

    await editor.getByLabel('Add entry').selectOption('encryption');
    await expect(page.getByTestId('wss-encryption-fields')).toBeVisible();
    await editor.getByLabel('Encryption keystore').selectOption({ label: 'recipient' });
    await expect(editor.getByLabel('Encryption alias')).toBeVisible();
    await editor.getByLabel('Embed key').check();

    // --- select it on Request 1 and send ----------------------------------------------------
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    await page.getByTestId('request-wss-outgoing').selectOption({ label: 'Outgoing WSS' });

    // The generated Calculator envelope carries `intA`/`intB` in the Body; encrypting the Body's
    // content must leave no trace of either on the wire.
    await expect(page.getByTestId('request-editor')).toContainText('intA', { timeout: 20_000 });
    await page.getByTestId('request-endpoint').fill(`${server.url}/soap`);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    // The echo route hands the envelope back verbatim, so this *is* what went out.
    const responseEditor = page.getByTestId('response-editor');
    await expect(responseEditor).toContainText('xenc:EncryptedKey', { timeout: 15_000 });
    // Monaco only renders the visible lines; the rest of the envelope is read from the model.
    await expect.poll(() => monacoModelText(page)).toContain('xenc:EncryptedData');
    await expect.poll(() => monacoModelText(page)).toContain('xenc:ReferenceList');

    // --- and the plaintext is nowhere on the wire --------------------------------------------
    await page.getByRole('tab', { name: 'Raw' }).first().click();
    const requestRaw = page.getByLabel('Request raw bytes');
    await expect(requestRaw).toBeVisible({ timeout: 10_000 });
    await expect(requestRaw).toContainText('xenc:EncryptedData');
    await expect(requestRaw).not.toContainText('intA');

    // --- and it replaced the Body's content, not something else ------------------------------
    const raw = (await requestRaw.textContent()) ?? '';
    const body = /<soapenv:Body[\s\S]*?<\/soapenv:Body>/.exec(raw)?.[0] ?? '';
    expect(body).toContain('xenc:EncryptedData');
  });

  test('verifies and decrypts a secured response, and flags a tampered one', async () => {
    const ca = generateTestCa();
    // The server signs with its own identity and encrypts to the client's certificate; the
    // client's PKCS#12 carries the issuing CA alongside its key, so the one keystore is both
    // the decryption key and the truststore the server's signer chains to.
    const serverIdentity = generateSigningCert(ca);
    const client = generateClientCert(ca);
    certsDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-certs-'));
    const keystorePath = join(certsDir, 'client.p12');
    writeFileSync(keystorePath, generateClientPkcs12(ca, client, { password: PASSWORD }));

    server = await startTestSoapServer({
      fixture: 'calculator',
      respondToCalculatorAdd: true,
      wss: { serverIdentity, clientCertPem: client.certPem },
    });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      extraEnv: { WIREBENCH_E2E_OPEN_PATH: keystorePath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'WSS Incoming Project' });
    await openFirstRequest(page);

    // --- add the keystore -------------------------------------------------------------------
    await page.getByRole('button', { name: 'WS-Security' }).click();
    await expect(page.getByTestId('wss-section')).toBeVisible();
    await page.getByLabel('Add keystore').click();
    await page.getByTestId('keystore-browse').click();
    const addDialog = page.getByTestId('keystore-add-dialog');
    await addDialog.getByRole('button', { name: 'Set…' }).click();
    await addDialog.getByPlaceholder('Enter password').fill(PASSWORD);
    await addDialog.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('keystore-add-submit').click();
    await expect(page.getByTestId('keystore-status')).toHaveText('Loaded', { timeout: 15_000 });

    // --- an incoming configuration ----------------------------------------------------------
    await page.getByTestId('wss-incoming-add').click();
    const row = page.getByTestId('wss-incoming-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { expanded: false }).click();
    const editor = page.getByTestId('wss-incoming-editor');
    await expect(editor).toBeVisible();
    await editor.getByLabel('Decryption keystore').selectOption({ label: 'client' });
    await editor.getByLabel('Signature truststore').selectOption({ label: 'client' });

    // --- select it on Request 1 and send to the signed+encrypted route -----------------------
    await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    await page.getByTestId('request-wss-incoming').selectOption({ label: 'Incoming WSS' });

    await page.getByTestId('request-endpoint').fill(`${server.url}/wss/sign-encrypt`);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 30_000 });

    const responseInspectors = page.getByRole('tablist', { name: 'Response inspectors' });
    await responseInspectors.getByRole('tab', { name: /^WSS/ }).click();
    const panel = page.getByTestId('inspector-panel-response');
    await expect(panel.getByTestId('wss-action-row')).toHaveCount(3, { timeout: 15_000 });
    await expect(panel.getByText('failed', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('trusted', { exact: true })).toBeVisible();
    await expect(responseInspectors.getByRole('tab', { name: 'WSS ✓' })).toBeVisible();

    // The envelope the views work against is the decrypted one — Query resolves AddResult to 5
    // (2 + 3) — while the bytes that actually arrived are still ciphertext.
    // Monaco renders only the lines in view, and the decrypted Body sits below a long
    // BinarySecurityToken — how far below depends on the window height, so scrolling to the
    // end and reading the DOM is a viewport test, not a content one. Read the model instead,
    // the way every other deep-content assertion in this spec does.
    await expect.poll(() => monacoModelText(page), { timeout: 15_000 }).toContain('AddResult');

    await page.getByRole('tab', { name: 'Raw' }).nth(1).click();
    const responseRaw = page.getByLabel('Response raw bytes');
    await expect(responseRaw).toBeVisible({ timeout: 10_000 });
    await expect(responseRaw).toContainText('xenc:EncryptedData');
    await expect(responseRaw).not.toContainText('AddResult');

    // --- and a tampered response is flagged --------------------------------------------------
    await page.getByTestId('request-endpoint').fill(`${server.url}/wss/tampered`);
    await page.getByTestId('request-send').click();
    await expect(responseInspectors.getByRole('tab', { name: 'WSS ✗' })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('failed', { exact: true })).toHaveCount(1);
    await expect(panel).toContainText('references failed validation');
  });
});

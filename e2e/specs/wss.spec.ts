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
import { generateClientCert, generateClientPkcs12, generateTestCa } from '@wirebench/engine/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
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
  let projectDir: string | undefined;
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
    for (const dir of [userDataDir, projectDir, certsDir]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
    userDataDir = undefined;
    projectDir = undefined;
    certsDir = undefined;
  });

  test('applies a Timestamp and a digest UsernameToken at send time, with the password masked and never on disk', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'WSS Project');
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server, { expectProjectName: 'WSS Project' });
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

    // --- and the configuration on disk carries only a reference ------------------------------
    const passwordRefPattern = /passwordRef:\s*['"]?([\w.:-]+)['"]?/;
    await expect
      .poll(
        () =>
          listFiles(projectDir!)
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
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'WSS Sign Project');
    launched = await launchApp({
      userDataDir,
      folderDialogPath: projectDir,
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
    await expect(responseEditor).toContainText('<ds:Reference URI="#Id-');
    await expect(responseEditor).toContainText('<ds:Reference URI="#TS-');
  });
});

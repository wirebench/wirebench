import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;
let home: string | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    if (home) rmSync(home, { recursive: true, force: true });
    launched = undefined;
    fixture = undefined;
    home = undefined;
  }
});

test('generate a key in the keychain, install it on a host and switch the host to it', async () => {
  test.skip(process.platform === 'win32', 'the fixture runs exec requests under /bin/sh');
  test.setTimeout(180_000);
  home = mkdtempSync(join(tmpdir(), 'wb-e2e-keys-'));
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, exec: { home } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Keys');

  await page.getByTestId('activity-hosts').click();
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('box');
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await dialog.getByRole('switch', { name: 'Override Port' }).click();
  await dialog.getByLabel('Port', { exact: true }).fill(String(fixture.port));
  await dialog.getByRole('switch', { name: 'Override User' }).click();
  await dialog.getByLabel('User', { exact: true }).fill('tester');
  await dialog.getByRole('radio', { name: 'Password', exact: true }).check();
  await dialog.getByRole('button', { name: 'Set value…' }).click();
  await dialog.getByLabel('Secret name', { exact: true }).fill('box_pw');
  await dialog.getByLabel('Secret value', { exact: true }).fill('pw');
  await dialog.getByRole('button', { name: 'Store' }).click();
  await expect(dialog.getByLabel('Password secret', { exact: true })).toHaveValue('box_pw');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // Generate an Ed25519 key: the keychain lists it by type and fingerprint, never by its value.
  await page.getByTestId('ssh-nav-keychain').click();
  await page.getByRole('button', { name: /Generate key/ }).click();
  const generate = page.getByTestId('generate-key-dialog');
  await generate.getByLabel('Secret name', { exact: true }).fill('box_key');
  await generate.getByRole('button', { name: 'Generate' }).click();
  await expect(generate).toBeHidden({ timeout: 30_000 });
  const row = page.getByTestId('secret-row-box_key');
  await expect(row).toContainText(/ed25519 · SHA256:/, { timeout: 30_000 });
  // The PEM armour, not the words: the panel's own description mentions private keys.
  expect(await page.content()).not.toContain('PRIVATE KEY-----');

  // Install it over the password sign-in; the host key is new, so it is trusted from the dialog first.
  await row.getByRole('button', { name: 'Install on host…' }).click();
  const install = page.getByTestId('install-key-dialog');
  await expect(install).toContainText('Signs in with password box_pw');
  await install.getByRole('button', { name: 'Install' }).click();
  await expect(install).toContainText(fixture.hostKey.fingerprint, { timeout: 30_000 });
  await install.getByRole('button', { name: 'Trust and install' }).click();
  await expect(install.getByTestId('install-key-result')).toHaveText('Added to ~/.ssh/authorized_keys on box.', {
    timeout: 30_000,
  });
  expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* \S+\n$/);

  // Switch the host to the key: the keychain row then lists the host as a user of it.
  await install.getByRole('button', { name: 'Switch' }).click();
  await expect(install.getByTestId('install-key-result')).toHaveText('box now signs in with box_key.');
  await install.getByRole('button', { name: 'Done' }).click();
  await expect(install).toBeHidden();
  await expect(row).toContainText('Used by box');
});

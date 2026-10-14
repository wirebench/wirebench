import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { showSshNav, trustHostKey } from '../helpers/ssh-host.js';

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    launched = undefined;
    fixture = undefined;
  }
});

test('a host signs in through an identity kept in the Keychain', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');

  // The identity: a user and a typed password, which goes to the secret store under its own name.
  await showSshNav(page, 'keychain');
  await page.getByRole('button', { name: 'New identity' }).click();
  const form = page.getByTestId('identity-form');
  await form.getByLabel('Identity name', { exact: true }).fill('Tester');
  await form.getByLabel('User', { exact: true }).fill('tester');
  await form.locator('input[type="password"]').fill('pw');
  await form.getByRole('button', { name: 'Add identity', exact: true }).click();
  await expect(page.getByTestId('identity-row-tester')).toContainText('Not used by any host');

  // A host that names it, with no user or password of its own.
  await showSshNav(page, 'hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('box');
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill(String(fixture.port));
  await dialog.getByRole('combobox', { name: 'Identity', exact: true }).selectOption('tester');
  await expect(dialog.getByText('tester · from identity Tester')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('connect-screen')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible();

  // The Keychain now lists the host against the identity.
  await showSshNav(page, 'keychain');
  await expect(page.getByTestId('identity-row-tester')).toContainText('Used by box');
});

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

test('a host with no user of its own connects as the default user from Settings → SSH', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');

  // Settings → SSH, found by searching for it, sets the default user.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  const editor = page.getByTestId('preferences-editor');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('settings-search').fill('keep-alive');
  await expect(page.getByTestId('settings-search-results')).toContainText('Workspace › SSH');
  await page.getByTestId('settings-search').fill('');
  await editor.getByRole('button', { name: 'SSH', exact: true }).click();
  const user = page.getByTestId('preferences-ssh-user');
  await user.fill('tester');
  await user.press('Enter');
  await expect(user).toHaveValue('tester');
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('settings-page')).toHaveCount(0);

  // A new host leaves the user to Preferences and only types the password.
  await showSshNav(page, 'hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('box');
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill(String(fixture.port));
  await expect(dialog.getByText('tester · from Preferences')).toBeVisible();
  await expect(dialog.getByRole('switch', { name: 'Override User' })).toHaveAttribute('aria-checked', 'false');
  await dialog.locator('input[type="password"]').fill('pw');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('connect-screen')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible();
});

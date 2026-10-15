import { expect, test } from '@playwright/test';
import { freePort, startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, trustHostKey } from '../helpers/ssh-host.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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

test('Connect to Host takes a server that is not saved, and Save as host… fills New host from it (#537)', async () => {
  test.setTimeout(120_000);
  // Nothing listens there: the connect fails (refused, or no agent to sign in with) whatever the machine.
  const port = await freePort();
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Quick');

  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.getByTestId('command-palette-input').fill('Connect to Host');
  await page
    .getByRole('option', { name: /Connect to Host/ })
    .first()
    .click();
  const input = page.getByTestId('quick-open-input');
  await expect(input).toBeVisible();
  await input.fill(`nobody@127.0.0.1:${String(port)}`);
  await expect(page.getByTestId('quick-connect')).toContainText(`Connect to nobody@127.0.0.1:${String(port)}`);
  await page.getByTestId('quick-connect').click();

  await expect(page.getByRole('tab', { name: new RegExp(`nobody@127\\.0\\.0\\.1:${String(port)}`) })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save as host…' });
  await expect(save).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ssh-pane-missing')).toHaveCount(0);
  await save.click();

  const dialog = page.getByTestId('host-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('127.0.0.1');
  await expect(dialog.getByLabel('Address', { exact: true })).toHaveValue('127.0.0.1');
  await expect(dialog.getByLabel('Port', { exact: true })).toHaveValue(String(port));
  await expect(dialog.getByLabel('User', { exact: true })).toHaveValue('nobody');
  await expect(dialog.getByRole('radio', { name: 'Agent', exact: true })).toBeChecked();
});

test('in a terminal the palette answers to Mod+Shift+P, and the status bar shows the session (#537)', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Keys');
  await addPasswordHost(page, fixture, { name: 'box' });

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('status-bar-session')).toContainText('box');
  await expect(page.getByTestId('status-bar-tls')).toHaveCount(0);

  await page.getByTestId('ssh-terminal').click();
  // Off a Mac the title bar says which chord reaches the palette from here.
  if (process.platform !== 'darwin') {
    await expect(page.getByTestId('title-bar-palette-shortcut')).toHaveText('Ctrl+Shift+P');
  }
  await page.keyboard.press(`${MOD}+Shift+P`);
  await expect(page.getByTestId('command-palette-input')).toBeVisible();
});

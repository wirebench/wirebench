import { expect, test } from '@playwright/test';
import { startTelnetFixture, type TelnetFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { openAdvanced, showSshNav } from '../helpers/ssh-host.js';

let launched: LaunchedApp | undefined;
let fixture: TelnetFixture | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    launched = undefined;
    fixture = undefined;
  }
});

test('a Telnet host signs in at the prompts, says it is not encrypted, and runs a command (#425)', async () => {
  test.setTimeout(120_000);
  fixture = await startTelnetFixture({ login: { user: 'admin', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');

  await showSshNav(page, 'hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('core-sw');
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill(String(fixture.port));
  await dialog.getByLabel('User', { exact: true }).fill('admin');
  await dialog.getByRole('radio', { name: 'Password', exact: true }).check();
  await dialog.locator('input[type="password"]').fill('pw');
  await openAdvanced(dialog);
  const protocol = dialog.getByRole('region', { name: 'Protocol' });
  await protocol.getByRole('combobox', { name: 'Protocol' }).selectOption('telnet');
  await expect(protocol.getByRole('note')).toContainText('not encrypted');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // The card says Telnet and shows the not-encrypted mark, as the tab does (#688).
  const row = page.getByTestId('host-row-core-sw');
  await expect(row).toContainText(`Telnet · admin@127.0.0.1:${String(fixture.port)}`);
  await expect(row.getByRole('img', { name: 'Not encrypted' })).toBeVisible();

  // No host key to trust: Telnet has none.
  await row.dblclick();
  const connected = page.getByTestId('editor-area').getByLabel('connected', { exact: true });
  await expect(connected).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ssh-plain-text')).toContainText('Not encrypted');
  // Files is SFTP: the toolbar offers none for a Telnet host (#688).
  await expect(page.getByTestId('editor-area').getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
  const terminal = page.getByTestId('ssh-terminal');
  await expect(terminal).toContainText('Welcome', { timeout: 30_000 });
  await terminal.click();
  await page.keyboard.type('show version');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('you said: show version', { timeout: 30_000 });
  expect(fixture.clients[0]?.terminalType).toBe('xterm-256color');
});

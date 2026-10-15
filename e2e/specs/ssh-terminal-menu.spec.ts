import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, showSshNav, trustHostKey } from '../helpers/ssh-host.js';

/**
 * The terminal's right-click menu, its find bar docked above the pane, and the recording dot of a logged
 * session with every host's logs in one list (#534).
 */

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

test('right-click → Find docks the find bar above the pane; a logged session shows the recording dot', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  await addPasswordHost(page, fixture, { name: 'box' });

  // Logging on for the host, from its details.
  await page.getByTestId('host-row-box').click();
  await page.getByTestId('rail-host-details').click();
  const details = page.getByTestId('host-details');
  const logSwitch = details.getByRole('switch', { name: 'Log sessions' });
  await logSwitch.click();
  await expect(logSwitch).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  const editor = page.getByTestId('editor-area');
  await expect(editor.getByLabel('connected', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(editor.getByTestId('recording-mark')).toBeVisible();

  const terminal = page.getByTestId('ssh-terminal');
  await terminal.click();
  await page.keyboard.type('echo needle and needle');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('echo needle and needle', { timeout: 30_000 });

  await terminal.click({ button: 'right' });
  const menu = page.getByTestId('terminal-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^Copy/,
    /^Paste/,
    /^Select all/,
    /^Find…/,
    /^Clear/,
    /^Split right/,
    /^Split down/,
    /^Run snippet…/,
    /^Open files/,
    /^Reconnect/,
  ]);
  await menu.getByRole('menuitem', { name: 'Find…' }).click();
  await expect(menu).toBeHidden();

  const find = page.getByTestId('terminal-find');
  await expect(find).toBeVisible();
  await expect(find.getByRole('textbox', { name: 'Find' })).toBeFocused();
  // A strip above the terminal: the terminal starts below it, not under it.
  const bar = await find.boundingBox();
  const holder = await terminal.boundingBox();
  expect(bar).not.toBeNull();
  expect(holder).not.toBeNull();
  if (bar !== null && holder !== null) expect(holder.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  await find.getByRole('textbox', { name: 'Find' }).fill('needle');
  await expect(find.getByTestId('terminal-find-count')).toHaveText(/^\d of 2$/);
  await page.keyboard.press('Escape');
  await expect(find).toBeHidden();

  // Every host's logs in one list, the running one among them, from the palette (pressed outside the
  // terminal: there the chord would go to the shell).
  await showSshNav(page, 'hosts');
  await page.keyboard.press(`${MOD}+Shift+P`);
  const palette = page.getByTestId('command-palette-input');
  await expect(palette).toBeVisible({ timeout: 20_000 });
  await palette.fill('Session Logs');
  await page
    .getByRole('option', { name: /Session Logs…/ })
    .first()
    .click();
  const logs = page.getByTestId('session-logs-dialog');
  await expect(logs).toBeVisible();
  await expect(logs.getByTestId('session-log-row')).toHaveCount(1);
  await expect(logs.getByTestId('session-log-row')).toContainText(/^box\d\d:\d\d · \d+(\.\d)? (B|KB) · running$/);
});

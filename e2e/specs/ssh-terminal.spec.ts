import { expect, test, type Page } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

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

/** Opens the command palette, types `query` and leaves it open for the caller to look at. */
async function searchPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.getByTestId('command-palette-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(query);
}

test('connect to a host, trust its key, type, see the echo, end the session', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');

  // The area is on by default: its palette command is there.
  await searchPalette(page, 'Connect to Host');
  await expect(page.getByRole('option', { name: /Connect to Host/ }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette-input')).toBeHidden();

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

  // SSH secrets belong to the workspace, not to a project: the value is stored from the dialog itself.
  await dialog.getByRole('radio', { name: 'Password', exact: true }).check();
  await dialog.getByRole('button', { name: 'Set value…' }).click();
  await dialog.getByLabel('Secret name', { exact: true }).fill('box_pw');
  await dialog.getByLabel('Secret value', { exact: true }).fill('pw');
  await dialog.getByRole('button', { name: 'Store' }).click();
  await expect(dialog.getByLabel('Password secret', { exact: true })).toHaveValue('box_pw');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await page.getByTestId('host-row-box').dblclick();
  const trust = page.getByTestId('trust-dialog');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  await expect(trust).toContainText(fixture.hostKey.fingerprint);
  await trust.getByRole('button', { name: 'Trust and connect' }).click();

  // The fixture's shell echoes every byte it is sent, so what the terminal shows is the typed line.
  const terminal = page.getByTestId('ssh-terminal');
  await expect(terminal.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  // The terminal is drawn before its session opens, and keys typed before then go nowhere: wait for the
  // tab's status dot to say the session is open.
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await terminal.click();
  await page.keyboard.type('echo hi');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('echo hi', { timeout: 30_000 });

  // The terminal's tab belongs to Hosts: Explorer's strip does not show it, and coming back finds
  // the same session still open.
  const connected = page.getByTestId('editor-area').getByLabel('connected', { exact: true });
  await page.getByTestId('activity-bar').getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(connected).toHaveCount(0);
  await expect(page.getByTestId('editor-empty')).toBeVisible();
  await page.getByTestId('activity-hosts').click();
  await expect(connected).toBeVisible();
  await terminal.click();

  // The echo returns the cursor to column 0 without a line feed, so `exit 0` overwrites the first line.
  await page.keyboard.type('exit 0');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Session ended (code 0)')).toBeVisible({ timeout: 30_000 });
});

test('WIREBENCH_AREAS=ssh=off hides the area and its commands', async () => {
  launched = await launchApp({ extraEnv: { WIREBENCH_AREAS: 'ssh=off' } });
  const page = launched.window;
  await createWorkspace(page, 'Quiet');
  await expect(page.getByTestId('activity-bar')).toBeVisible();
  await expect(page.getByTestId('activity-hosts')).toHaveCount(0);

  await searchPalette(page, 'Connect to Host');
  // The list has settled once the empty state shows; only then is "no option" more than "not yet rendered".
  await expect(page.getByText('No matching command.')).toBeVisible();
  await expect(page.getByRole('option', { name: /Connect to Host/ })).toHaveCount(0);
});

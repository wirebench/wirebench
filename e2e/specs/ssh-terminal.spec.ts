import { expect, test, type Page } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { fillNewHost } from '../helpers/ssh-host.js';

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
  // Essentials first: the rest waits under a closed Advanced, and a disabled Save says what it needs.
  await expect(dialog.getByLabel('Tags (comma separated)')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(dialog.getByRole('list', { name: 'Needed to save' })).toContainText('Address is required');
  // No group supplies a user, so User is a plain field (no Override switch), prefilled with the login name.
  await expect(dialog.getByRole('switch', { name: 'Override User' })).toHaveCount(0);
  await expect(dialog.getByLabel('User', { exact: true })).not.toHaveValue('');
  // The password is typed inline; Save stores it as the workspace secret box_password.
  await fillNewHost(dialog, { name: 'box', port: fixture.port, user: 'tester', password: 'pw' });
  await expect(dialog.getByRole('list', { name: 'Needed to save' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // Picking the card shows its details on the right; Escape puts them away.
  await page.getByTestId('host-row-box').click();
  await expect(page.getByTestId('host-details')).toContainText(`ssh -p ${String(fixture.port)} tester@127.0.0.1`);
  // Edit opens the host's form in the same panel; Cancel returns to the details.
  await page.getByTestId('host-details').getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByTestId('host-edit').getByLabel('Name', { exact: true })).toHaveValue('box');
  await page.getByTestId('host-edit').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('host-details')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('host-details')).toBeHidden();

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

  // ⌘F (Ctrl+F elsewhere) in the focused terminal finds in the scrollback; Escape gives the keys back.
  // The line overwrites `echo hi`, as above.
  await page.keyboard.type('find needle and needle');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('find needle and needle', { timeout: 30_000 });
  await page.keyboard.press(`${MOD}+f`);
  const find = page.getByTestId('terminal-find');
  await expect(find).toBeVisible();
  await expect(find.getByRole('textbox', { name: 'Find' })).toBeFocused();
  await page.keyboard.type('needle');
  await expect(find.getByTestId('terminal-find-count')).toHaveText(/^\d of 2$/);
  await find.getByRole('button', { name: 'Match whole word' }).click();
  await expect(find.getByTestId('terminal-find-count')).toHaveText(/^\d of 2$/);
  await find.getByRole('textbox', { name: 'Find' }).fill('needles');
  await expect(find.getByTestId('terminal-find-count')).toHaveText('No results');
  await find.getByRole('textbox', { name: 'Find' }).press('Escape');
  await expect(find).toBeHidden();
  await expect(terminal.locator('textarea.xterm-helper-textarea')).toBeFocused();

  // The terminal's tab belongs to Hosts: Explorer's strip does not show it, and coming back finds
  // the same session still open.
  const connected = page.getByTestId('editor-area').getByLabel('connected', { exact: true });
  await page.getByTestId('activity-bar').getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(connected).toHaveCount(0);
  await expect(page.getByTestId('editor-empty')).toBeVisible();
  await page.getByTestId('activity-hosts').click();
  await expect(connected).toBeVisible();

  // The menu shows its pick in the area's fixed first tab, here the key just trusted; the session
  // stays open behind it.
  await page.getByTestId('ssh-nav-known-hosts').click();
  await expect(page.getByTestId(`known-host-127.0.0.1:${String(fixture.port)}`)).toContainText(
    fixture.hostKey.fingerprint,
  );
  await page.getByRole('tab', { name: /box/ }).click();
  await expect(connected).toBeVisible();

  // A connection the network drops reconnects on its own, into the same terminal: the scrollback stays.
  // The countdown shows on the connection screen, over the terminal, until an attempt opens a session.
  fixture.drop();
  await expect(page.getByTestId('ssh-terminal-notice')).toContainText('Reconnecting', { timeout: 30_000 });
  await expect(terminal).toContainText('reconnected', { timeout: 30_000 });
  // The find step's line is the last one typed before the drop (it overwrote `echo hi`).
  await expect(terminal).toContainText('find needle and needle');
  await expect(page.getByTestId('ssh-terminal-notice')).toBeHidden();
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

  // Nor are the Port forwarding and Layouts views, their commands, or the status bar's forwarding item.
  for (const command of ['Show Port Forwarding', 'Open Layout']) {
    await page.getByTestId('command-palette-input').fill(command);
    await expect(page.getByText('No matching command.')).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ssh-nav-forwarding')).toHaveCount(0);
  await expect(page.getByTestId('ssh-nav-layouts')).toHaveCount(0);
  await expect(page.getByTestId('status-bar')).toBeVisible();
  await expect(page.getByTestId('status-bar-forwards')).toHaveCount(0);
});

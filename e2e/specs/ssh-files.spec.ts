import { mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sftpServerPath, startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;
const dirs: string[] = [];

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    launched = undefined;
    fixture = undefined;
    for (const dir of dirs.splice(0)) removeDirSync(dir);
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** One of the Files tab's two panes, by what it shows. */
function pane(page: Page, place: 'local' | 'remote'): Locator {
  return page.locator(`[data-testid="files-pane"][data-place="${place}"]`);
}

function row(of: Locator, name: string): Locator {
  return of.locator(`[data-testid="files-row"][data-name="${name}"]`);
}

/** Types `path` into a pane's path bar and goes there. */
async function goTo(of: Locator, path: string): Promise<void> {
  await of.getByTestId('files-path-bar').click();
  const input = of.getByTestId('files-path-input');
  await input.fill(path);
  await input.press('Enter');
  await expect(input).toBeHidden();
}

/** Right-clicks `target` and picks `item` from the pane's menu. */
async function menu(page: Page, target: Locator, item: string): Promise<void> {
  await target.click({ button: 'right' });
  await page.getByTestId('files-menu').getByRole('menuitem', { name: item, exact: true }).click();
}

// The fixture's SFTP subsystem is OpenSSH's sftp-server. Linux CI must have it, so there a missing one fails
// the spec instead of skipping it; Windows runners have none at a path the fixture knows.
const sftpMissing = sftpServerPath() === undefined && !(process.platform === 'linux' && process.env['CI']);

test('Files: new folder, copy both ways, rename, chmod, cancel a large copy, cross to the terminal', async () => {
  test.skip(sftpMissing, 'no OpenSSH sftp-server is installed');
  test.setTimeout(240_000);
  const remoteRoot = tempDir('wb-sftp-remote-');
  const localDir = tempDir('wb-sftp-local-');
  const bytes = Buffer.from('hello from this machine\né\u0000ÿ', 'latin1');
  writeFileSync(join(localDir, 'a.txt'), bytes);
  // Sparse, so it costs no disk on the host side, and large enough to be still running when cancelled.
  writeFileSync(join(remoteRoot, 'big.bin'), '');
  truncateSync(join(remoteRoot, 'big.bin'), 1024 * 1024 * 1024);

  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, sftp: { root: remoteRoot } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');

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

  // Open files from the host card: the Files tab's own connection asks to trust the key, as a terminal does.
  await page.getByTestId('host-row-box').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open files', exact: true }).click();
  const trust = page.getByTestId('trust-dialog');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  await expect(trust).toContainText(fixture.hostKey.fingerprint);
  await trust.getByRole('button', { name: 'Trust and connect' }).click();

  const files = page.getByTestId('ssh-files');
  const remote = pane(page, 'remote');
  const local = pane(page, 'local');
  await expect(files).toBeVisible();
  // The host's pane starts where the server's sftp-server starts: the fixture's root.
  await expect(row(remote, 'big.bin')).toBeVisible({ timeout: 30_000 });
  await goTo(local, localDir);
  await expect(row(local, 'a.txt')).toBeVisible();

  // New folder makes `New folder` and renames it in place.
  await menu(page, remote.getByTestId('files-list'), 'New folder');
  const naming = remote.getByTestId('files-rename');
  await expect(naming).toBeVisible();
  await naming.fill('up');
  await naming.press('Enter');
  await expect(row(remote, 'up')).toBeVisible();
  expect(statSync(join(remoteRoot, 'up')).isDirectory()).toBe(true);

  // Drag a.txt from this machine onto the `up` folder in the host's pane.
  await row(local, 'a.txt').dragTo(row(remote, 'up'));
  const transfer = (name: string): Locator => page.getByTestId('files-transfer').filter({ hasText: name });
  await expect(transfer('a.txt')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await row(remote, 'up').dblclick();
  await expect(row(remote, 'a.txt')).toBeVisible();
  expect(readFileSync(join(remoteRoot, 'up', 'a.txt')).equals(bytes)).toBe(true);

  // F2 renames in place.
  await row(remote, 'a.txt').click();
  await page.keyboard.press('F2');
  await naming.fill('b.txt');
  await naming.press('Enter');
  await expect(row(remote, 'b.txt')).toBeVisible();
  await expect(row(remote, 'a.txt')).toHaveCount(0);

  // Permissions… 600: the column reads rw-------.
  await menu(page, row(remote, 'b.txt'), 'Permissions…');
  const permissions = page.getByTestId('files-permissions');
  await expect(permissions).toBeVisible();
  await permissions.getByLabel('Octal mode').fill('600');
  await permissions.getByRole('button', { name: 'Apply' }).click();
  await expect(permissions).toBeHidden();
  await expect(row(remote, 'b.txt')).toContainText('rw-------');
  expect(statSync(join(remoteRoot, 'up', 'b.txt')).mode & 0o777).toBe(0o600);

  // Copy it back to this machine: the bytes on disk are the ones uploaded.
  await menu(page, row(remote, 'b.txt'), 'Copy to other pane');
  await expect(transfer('b.txt')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(row(local, 'b.txt')).toBeVisible();
  expect(readFileSync(join(localDir, 'b.txt')).equals(bytes)).toBe(true);

  // A large copy cancelled while it runs ends Cancelled and leaves no part file behind.
  await remote.getByRole('button', { name: 'Back' }).click();
  await expect(row(remote, 'big.bin')).toBeVisible();
  await menu(page, row(remote, 'big.bin'), 'Copy to other pane');
  const big = transfer('big.bin');
  await expect(big).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
  await big.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(big).toHaveAttribute('data-state', 'cancelled', { timeout: 30_000 });
  await expect(big).toContainText('Cancelled');
  await expect
    .poll(() => readdirSync(localDir).filter((name) => name.endsWith('.wirebench-part')), { timeout: 10_000 })
    .toEqual([]);
  expect(readdirSync(localDir).sort()).toEqual(['a.txt', 'b.txt']);

  // Open terminal goes to the host's terminal tab; its Files button comes back to this tab.
  await files.getByRole('button', { name: 'Open terminal' }).click();
  await expect(page.getByTestId('ssh-terminal').locator('.xterm')).toBeVisible({ timeout: 30_000 });
  await expect(files).toBeHidden();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(files).toBeVisible();
  await expect(page.getByRole('tab', { name: /box · Files/ })).toHaveAttribute('aria-selected', 'true');
});

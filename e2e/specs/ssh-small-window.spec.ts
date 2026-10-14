import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { sftpServerPath, startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, showSshNav, trustHostKey } from '../helpers/ssh-host.js';

/*
 * The SSH area in a small window (1024×700): the Files panes keep their names, and a split terminal tab
 * stays inside the editor area, its find bar inside its pane.
 */

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

/** Sizes the window's content area, as a user dragging its frame would. */
async function contentSize(app: LaunchedApp, width: number, height: number): Promise<void> {
  await app.app.evaluate(
    async ({ BrowserWindow }, size) => {
      const [window] = BrowserWindow.getAllWindows();
      window?.setContentSize(size.width, size.height);
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
    { width, height },
  );
}

/** The scrollable boxes under `root` wider than they show: what a sideways scrollbar would scroll. */
async function sidewaysScrollers(root: Locator): Promise<string[]> {
  return root.evaluate((element) =>
    [element, ...Array.from(element.querySelectorAll('*'))]
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      .filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX))
      .map((el) => `${el.dataset['testid'] ?? el.tagName} by ${String(el.scrollWidth - el.clientWidth)}px`),
  );
}

async function box(of: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await of.boundingBox();
  if (found === null) throw new Error('not laid out');
  return found;
}

// The fixture's SFTP subsystem is OpenSSH's sftp-server; see ssh-files.spec.ts.
const sftpMissing = sftpServerPath() === undefined && !(process.platform === 'linux' && process.env['CI']);

test('Files at 1024×700 shows each name and never scrolls sideways', async () => {
  test.skip(sftpMissing, 'no OpenSSH sftp-server is installed');
  test.setTimeout(120_000);
  const remoteRoot = tempDir('wb-small-remote-');
  mkdirSync(join(remoteRoot, 'etc'));
  writeFileSync(join(remoteRoot, 'app.log'), 'y'.repeat(5000));
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, sftp: { root: remoteRoot } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  await addPasswordHost(page, fixture, { name: 'box' });
  await contentSize(launched, 1024, 700);

  await showSshNav(page, 'hosts');
  await page.getByTestId('host-row-box').getByRole('button', { name: 'More actions for box' }).click();
  await page.getByRole('menuitem', { name: 'Open files', exact: true }).click();
  await trustHostKey(page, fixture);

  const remote = page.locator('[data-testid="files-pane"][data-place="remote"]');
  const row = remote.locator('[data-testid="files-row"][data-name="app.log"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The name is drawn, inside its pane, with room to read it.
  const name = row.getByText('app.log', { exact: true });
  await expect(name).toBeVisible();
  const nameBox = await box(name);
  const paneBox = await box(remote);
  expect(nameBox.width).toBeGreaterThan(20);
  expect(nameBox.x).toBeGreaterThanOrEqual(paneBox.x);
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
  expect(await sidewaysScrollers(page.getByTestId('ssh-files'))).toEqual([]);
});

test('a split tab at 1024×700 stays in the editor area and keeps its find bar in its pane', async () => {
  test.setTimeout(120_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Panes');
  await addPasswordHost(page, fixture, { name: 'box' });

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Split at the default size, where the pane is wide enough to halve.
  await page.getByRole('button', { name: 'Split right' }).click();
  await expect(page.getByTestId('ssh-pane-host-input')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ssh-pane-header').getByLabel('connected', { exact: true })).toHaveCount(2, {
    timeout: 30_000,
  });

  await contentSize(launched, 1024, 700);
  const left = page.getByTestId('ssh-pane').first();
  await left.getByTestId('ssh-terminal').click();
  await page.keyboard.press('Control+f');
  const find = left.getByTestId('terminal-find');
  await expect(find).toBeVisible();

  const editor = await box(page.getByTestId('editor-area'));
  const pane = await box(left);
  const bar = await box(find);
  expect(pane.x).toBeGreaterThanOrEqual(editor.x);
  expect(bar.x).toBeGreaterThanOrEqual(pane.x);
  expect(bar.x + bar.width).toBeLessThanOrEqual(pane.x + pane.width);
  expect(await sidewaysScrollers(page.getByTestId('editor-area'))).toEqual([]);
  await page.keyboard.press('Escape');

  // Each half is now too narrow to halve again: the split is refused with a toast. Retried, since the
  // pane's size is the one its last fit measured, which follows the window a moment later.
  await expect(async () => {
    if (await page.getByTestId('ssh-pane-host-input').isVisible()) await page.keyboard.press('Escape');
    await left.getByTestId('ssh-terminal').click();
    await page.getByRole('button', { name: 'Split right' }).click();
    await expect(page.getByTestId('toast-viewport')).toContainText('Too narrow to split', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByTestId('ssh-pane')).toHaveCount(2);
});

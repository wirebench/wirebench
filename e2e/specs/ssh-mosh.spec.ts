import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, openAdvanced, trustHostKey } from '../helpers/ssh-host.js';

/** Whether mosh (server and client) is installed here: CI's Linux runner installs it; elsewhere this skips. */
function moshInstalled(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v mosh-server && command -v mosh-client'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;
let home: string | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    launched = undefined;
    fixture = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  }
});

async function chooseMosh(dialog: Locator, server?: string): Promise<void> {
  await openAdvanced(dialog);
  const section = dialog.getByRole('region', { name: 'Protocol' });
  await section.getByRole('combobox', { name: 'Protocol' }).selectOption('mosh');
  if (server !== undefined) await section.getByLabel('Server command').fill(server);
}

test.skip(!moshInstalled(), 'mosh is not installed on this machine');

test('a Mosh host starts mosh-server over SSH and runs its shell over UDP; a missing server says so', async () => {
  test.setTimeout(180_000);
  // The fixture runs exec requests for real: `mosh-server new` starts a real server on this machine.
  home = mkdtempSync(join(tmpdir(), 'wb-e2e-mosh-'));
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, exec: { home } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');

  await addPasswordHost(page, fixture, {
    name: 'roam',
    beforeSave: (dialog) => chooseMosh(dialog),
  });
  await page.getByTestId('host-row-roam').click();
  await page.getByTestId('rail-host-details').click();
  await expect(page.getByTestId('host-details').getByText('Protocol').locator('..')).toContainText('Mosh');
  await page.keyboard.press('Escape');

  await page.getByTestId('host-row-roam').dblclick();
  await trustHostKey(page, fixture);
  const connected = page.getByTestId('editor-area').getByLabel('connected', { exact: true });
  await expect(connected).toBeVisible({ timeout: 30_000 });
  const terminal = page.getByTestId('ssh-terminal');
  await terminal.click();
  // A real shell behind mosh-server: the arithmetic proves it ran, not just echoed.
  await page.keyboard.type('echo mosh-ok-$((6*7))');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('mosh-ok-42', { timeout: 30_000 });

  // A server command that is not there stops at the shell step with what to do.
  await addPasswordHost(page, fixture, {
    name: 'bare',
    beforeSave: (dialog) => chooseMosh(dialog, 'no-such-mosh-server'),
  });
  await page.getByTestId('host-row-bare').dblclick();
  await expect(page.getByTestId('connect-error')).toContainText('no-such-mosh-server was not found', {
    timeout: 30_000,
  });
});

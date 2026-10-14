import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, trustHostKey } from '../helpers/ssh-host.js';

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

/** A port nothing listens on: bound, read, closed again. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('the connection screen walks the steps, then gives way to the terminal', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  await addPasswordHost(page, fixture, { name: 'box' });

  await page.getByTestId('host-row-box').dblclick();
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(screen).toContainText(`tester@127.0.0.1:${String(fixture.port)}`);
  // A first-seen key holds the host-key step on the trust prompt; the steps before it are done.
  await expect(page.getByTestId('connect-step-host-key')).toHaveAttribute('data-state', 'waiting', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('connect-step-connect')).toHaveAttribute('data-state', 'done');
  // The log stays folded while it connects.
  await expect(page.getByTestId('connect-log')).toHaveCount(0);
  await trustHostKey(page, fixture);

  // Connected: the screen fades out and the shell takes the keys.
  await expect(screen).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible();
  const terminal = page.getByTestId('ssh-terminal');
  await terminal.click();
  await page.keyboard.type('echo hi');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('echo hi', { timeout: 30_000 });
});

test('a wrong password fails Authenticating with a plain sentence and opens the log', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'right-pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  await addPasswordHost(page, fixture, { name: 'box', password: 'wrong-pw' });

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(page.getByTestId('connect-step-auth')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('connect-error')).toContainText('refused the password for tester');
  const log = page.getByTestId('connect-log');
  await expect(log).toBeVisible();
  await expect(log).toContainText('Trying password for tester');
  await expect(log).toContainText('Server allows:');
  // Neither password is ever written to the log.
  await expect(log).not.toContainText('wrong-pw');
  await expect(log).not.toContainText('right-pw');
  await expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();

  // Edit host opens the host's form.
  await screen.getByRole('button', { name: 'Edit host' }).click();
  await expect(page.getByTestId('host-edit').getByLabel('Name', { exact: true })).toHaveValue('box');
});

test('a port nothing listens on fails Connecting as refused, and Close closes the tab', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  const port = await freePort();
  await addPasswordHost(page, fixture, { name: 'box', port });

  await page.getByTestId('host-row-box').dblclick();
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(page.getByTestId('connect-step-resolve')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('connect-step-connect')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('connect-error')).toContainText(`refused the connection on port ${String(port)}`);
  await expect(page.getByTestId('connect-log')).toContainText('connection refused');

  await screen.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('ssh-pane')).toHaveCount(0);
});

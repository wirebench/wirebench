import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, fillNewHost, showSshNav, trustHostKey } from '../helpers/ssh-host.js';

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

/**
 * The slice of `window.wirebench` the no-user test calls. Declared locally: `e2e/tsconfig.json` has no DOM
 * lib, so a `page.evaluate` callback reaches `window` through a shape of its own.
 */
interface HostsApi {
  readonly ssh: {
    listHosts(request: undefined): Promise<{ readonly ok: boolean; readonly value?: { readonly file: HostsFile } }>;
    saveHosts(request: { readonly file: HostsFile }): Promise<{ readonly ok: boolean }>;
  };
}
interface HostsFile {
  readonly hosts: { readonly id: string; readonly ssh: Record<string, unknown> }[];
}

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
  await expect(screen.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();

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

test('a refused password is fixed on the screen: Save and retry stores it and connects (#532)', async () => {
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
  // Retrying would fail the same way: the password field leads, Retry is secondary.
  const retry = screen.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  await expect(retry).not.toHaveClass(/bg-accent/);
  const save = screen.getByRole('button', { name: 'Save and retry' });
  await expect(save).toHaveClass(/bg-accent/);
  // The log opened at its end, the failing line highlighted.
  await expect(page.getByTestId('connect-log').locator('[data-failing="true"]')).toBeInViewport();

  const password = screen.getByLabel('Password for tester', { exact: true });
  await expect(password).toBeFocused();
  await password.fill('right-pw');
  await save.click();

  await expect(screen).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible();
  const terminal = page.getByTestId('ssh-terminal');
  await terminal.click();
  await page.keyboard.type('echo fixed');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('echo fixed', { timeout: 30_000 });
});

test('a password left empty is asked for as a sign-in step, used once and not stored (#721)', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  await showSshNav(page, 'hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  // No password typed: the form says it is asked for when connecting.
  await fillNewHost(dialog, { name: 'box', port: fixture.port, user: 'tester' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const ask = async (): Promise<void> => {
    await page.getByTestId('host-row-box').dblclick();
    const screen = page.getByTestId('connect-screen');
    await expect(screen).toHaveAttribute('data-state', 'sign-in', { timeout: 30_000 });
    await expect(screen.getByRole('heading', { name: 'Sign in to box' })).toBeVisible();
    await expect(screen.getByRole('alert')).toHaveCount(0);
    await expect(screen.getByLabel('Remember on this machine')).not.toBeChecked();
    await screen.getByLabel('Password for tester', { exact: true }).fill('pw');
    await screen.getByRole('button', { name: 'Connect', exact: true }).click();
  };
  await ask();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Nothing was stored: a new session asks again.
  await page.getByRole('tab', { name: /box/ }).getByTestId('editor-tab-close').click();
  await page.getByTestId('live-close-confirm').click();
  await showSshNav(page, 'hosts');
  await ask();
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
});

test('a host with no user asks who to sign in as, saves it to the host and connects (#532)', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  await addPasswordHost(page, fixture, { name: 'box' });
  // The same host without its user, written as an edit of the hosts file would.
  const cleared = await page.evaluate(async () => {
    const api = (globalThis as unknown as { wirebench: HostsApi }).wirebench;
    const listed = await api.ssh.listHosts(undefined);
    const file = listed.value?.file;
    if (file === undefined) return false;
    const hosts = file.hosts.map((host) => {
      if (host.id !== 'box') return host;
      const { user, ...ssh } = host.ssh;
      void user;
      return { ...host, ssh };
    });
    return (await api.ssh.saveHosts({ file: { ...file, hosts } })).ok;
  });
  expect(cleared).toBe(true);

  await page.getByTestId('host-row-box').dblclick();
  const screen = page.getByTestId('connect-screen');
  await expect(screen).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  // A settings problem: no step ran, so none is listed, and Resolving address did not fail.
  await expect(screen).toContainText('Host settings');
  await expect(page.getByTestId('connect-error')).toContainText('no user to sign in as');
  await expect(page.getByTestId('connect-step-resolve')).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId('connect-step-resolve')).toBeHidden();
  await expect(screen.getByRole('button', { name: 'Retry', exact: true })).not.toHaveClass(/bg-accent/);

  const user = screen.getByLabel('Sign in as', { exact: true });
  await expect(user).toBeFocused();
  await user.fill('tester');
  await screen.getByRole('checkbox', { name: 'Save to host' }).check();
  await screen.getByRole('button', { name: 'Connect', exact: true }).click();
  await trustHostKey(page, fixture);

  await expect(screen).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible();
  // Saved: the host itself now signs in as the user.
  const saved = await page.evaluate(async () => {
    const api = (globalThis as unknown as { wirebench: HostsApi }).wirebench;
    const listed = await api.ssh.listHosts(undefined);
    return listed.value?.file.hosts.find((host) => host.id === 'box')?.ssh['user'];
  });
  expect(saved).toBe('tester');
});

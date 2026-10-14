import { expect, type Locator, type Page } from '@playwright/test';
import type { SshFixture } from '@wirebench/ssh/test-helpers';

/**
 * Adds host `name` for the fixture's password user from the Hosts view's New host dialog, storing the
 * password as a workspace secret. `password` and `port` default to the fixture's (`pw`, its port); a
 * different one makes a host that fails to sign in or to connect. `beforeSave` fills more of the dialog
 * (forwarding rules) before Save.
 */
export async function addPasswordHost(
  page: Page,
  fixture: SshFixture,
  options: {
    readonly name: string;
    readonly password?: string;
    readonly port?: number;
    readonly beforeSave?: (dialog: Locator) => Promise<void>;
  },
): Promise<void> {
  await showSshNav(page, 'hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(options.name);
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await dialog.getByRole('switch', { name: 'Override Port' }).click();
  await dialog.getByLabel('Port', { exact: true }).fill(String(options.port ?? fixture.port));
  await dialog.getByRole('switch', { name: 'Override User' }).click();
  await dialog.getByLabel('User', { exact: true }).fill('tester');
  await dialog.getByRole('radio', { name: 'Password', exact: true }).check();
  await dialog.getByRole('button', { name: 'Set value…' }).click();
  await dialog.getByLabel('Secret name', { exact: true }).fill(`${options.name}_pw`);
  await dialog.getByLabel('Secret value', { exact: true }).fill(options.password ?? 'pw');
  await dialog.getByRole('button', { name: 'Store' }).click();
  await expect(dialog.getByLabel('Password secret', { exact: true })).toHaveValue(`${options.name}_pw`);
  await options.beforeSave?.(dialog);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Opens an entry of the SSH menu (`hosts`, `snippets`, …). The activity button toggles the sidebar, so it is
 * clicked only while the menu is not showing.
 */
export async function showSshNav(page: Page, entry: string): Promise<void> {
  const item = page.getByTestId(`ssh-nav-${entry}`);
  if (!(await item.isVisible())) await page.getByTestId('activity-hosts').click();
  await item.click();
}

/** Accepts the first-use host key prompt, which a connect or a forward start opens for a new host. */
export async function trustHostKey(page: Page, fixture: SshFixture): Promise<void> {
  const trust = page.getByTestId('trust-dialog');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  await expect(trust).toContainText(fixture.hostKey.fingerprint);
  await trust.getByRole('button', { name: 'Trust and connect' }).click();
  await expect(trust).toBeHidden();
}

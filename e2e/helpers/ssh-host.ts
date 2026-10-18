import { expect, type Locator, type Page } from '@playwright/test';
import type { SshFixture } from '@wirebench/ssh/test-helpers';

/**
 * Fills the essentials of an open New host form (in the details panel, test id `host-dialog`): name, address
 * 127.0.0.1, port, user and an inline password, which Save stores as the workspace secret `<name>_password`.
 * Leaves the form open.
 */
export async function fillNewHost(
  dialog: Locator,
  options: { readonly name: string; readonly port: number; readonly user: string; readonly password?: string },
): Promise<void> {
  await dialog.getByLabel('Name', { exact: true }).fill(options.name);
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill(String(options.port));
  // No group supplies a user: a plain field, prefilled with this machine's login name.
  await dialog.getByLabel('User', { exact: true }).fill(options.user);
  await dialog.getByRole('radio', { name: 'Password', exact: true }).check();
  if (options.password !== undefined) await dialog.locator('input[type="password"]').fill(options.password);
}

/** Unfolds a host form's Advanced section, where tags, terminal and forwarding settings live. */
export async function openAdvanced(dialog: Locator): Promise<void> {
  const advanced = dialog.getByTestId('host-advanced');
  if (!(await advanced.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await advanced.getByText('Advanced', { exact: true }).click();
  }
}

/**
 * Adds host `name` for the fixture's password user from the Hosts view's New host form, which opens in the
 * details panel, typing the password inline; Save stores it as the workspace secret `<name>_password`.
 * `password` and `port` default to the fixture's (`pw`, its port); a different one makes a host that fails
 * to sign in or to connect. `beforeSave` fills more of the form (forwarding rules, under Advanced) before Save.
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
  await fillNewHost(dialog, {
    name: options.name,
    port: options.port ?? fixture.port,
    user: 'tester',
    password: options.password ?? 'pw',
  });
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

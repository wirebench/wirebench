import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startFakeServer, startNotWirebenchServer, type FakeServer } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';

const ALICE = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };

/** Opens the Sign in dialog from the palette and gets past the server step. */
async function openSignIn(page: Page, url: string): Promise<void> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await dialog.getByTestId('sign-in-continue').click();
}

test.describe('server accounts', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-account-'));
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('sign in with a password, the status bar shows the email, a restart keeps the session, sign out clears it', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ALICE] });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await expect(page.getByTestId('status-bar-account')).toHaveCount(0);

    await openSignIn(page, server.url);
    const dialog = page.getByTestId('sign-in-dialog');
    await dialog.getByTestId('sign-in-email').fill(ALICE.email);
    await dialog.getByTestId('sign-in-password').fill('wrong password here');
    await dialog.getByTestId('sign-in-submit').click();
    await expect(dialog.getByTestId('sign-in-error')).toHaveText('Wrong email or password.');
    await dialog.getByTestId('sign-in-password').fill(ALICE.password);
    await dialog.getByTestId('sign-in-submit').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('status-bar-account')).toContainText(ALICE.email);

    // The file names a ref, never the token.
    const accounts = readFileSync(join(userDataDir, 'accounts.yaml'), 'utf8');
    expect(accounts).toContain('tokenRef: sec_');
    expect(accounts).not.toContain(server.tokens[0]!);

    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;
    await expect(page.getByTestId('status-bar-account')).toContainText(ALICE.email, { timeout: 20_000 });

    await page.getByTestId('status-bar-account').click();
    await page.getByTestId(`account-sign-out-${new URL(server.url).host}`).click();
    await expect(page.getByTestId('status-bar-account')).toContainText('Sign in', { timeout: 20_000 });
    expect(server.signOuts).toEqual([server.tokens[0]]);
  });

  test('accepting an invitation code creates the account and signs in', async () => {
    test.setTimeout(90_000);
    const secret = 'I'.repeat(43);
    server = await startFakeServer({ invitations: { [secret]: { email: 'bob@example.com' } } });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await openSignIn(page, server.url);
    const dialog = page.getByTestId('sign-in-dialog');
    await dialog.getByTestId('sign-in-have-code').click();
    await dialog.getByTestId('sign-in-code').fill(secret);
    await dialog.getByTestId('sign-in-code-continue').click();
    await expect(dialog.getByTestId('sign-in-invited-email')).toContainText('bob@example.com');
    await dialog.getByTestId('sign-in-display-name').fill('Bob');
    await dialog.getByTestId('sign-in-new-password').fill('a password of length');
    await dialog.getByTestId('sign-in-confirm-password').fill('a password of length');
    await dialog.getByTestId('sign-in-accept').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('status-bar-account')).toContainText('bob@example.com');
    expect(server.tokens).toHaveLength(1);
  });

  test('a server that is not Wirebench shows the inline error', async () => {
    const other = await startNotWirebenchServer();
    try {
      launched = await launchApp({ userDataDir, keepUserDataDir: true });
      const page = launched.window;
      await openSignIn(page, other.url);
      await expect(page.getByTestId('sign-in-dialog').getByTestId('sign-in-error')).toHaveText(
        'That address is not a Wirebench Server.',
      );
      await expect(page.getByTestId('sign-in-url')).toBeVisible();
    } finally {
      await other.close();
    }
  });
});

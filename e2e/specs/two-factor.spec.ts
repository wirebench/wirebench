/**
 * Two-step sign-in in the desktop (two-step sign-in spec §4.2) against the fake server: a correct password moves the
 * Sign in dialog to its second step, a wrong code says so and keeps the field, the right one signs in; *Use a passkey*
 * starts the hand-off and opens the server's passkey page in the system browser (here `shell.openExternal`, replaced
 * by a recorder), and *Cancel* brings the dialog back to the code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startFakeServer, type FakeServer } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';

const ALICE = {
  email: 'alice@example.com',
  password: 'correct horse battery',
  displayName: 'Alice',
  twoFactorCode: '246810',
};

async function passwordStep(page: Page, url: string): Promise<void> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await dialog.getByTestId('sign-in-continue').click();
  await dialog.getByTestId('sign-in-email').fill(ALICE.email);
  await dialog.getByTestId('sign-in-password').fill(ALICE.password);
  await dialog.getByTestId('sign-in-submit').click();
  await expect(dialog.getByTestId('two-factor-step')).toBeVisible({ timeout: 20_000 });
}

test.describe('two-step sign-in in the desktop', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-two-factor-'));
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('the password leads to the second step; a wrong code says so, the right one signs in', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ALICE] });
    launched = await launchApp({ userDataDir });
    const page = launched.window;
    await passwordStep(page, server.url);
    const dialog = page.getByTestId('sign-in-dialog');
    // No token for the password alone.
    expect(server.tokens).toEqual([]);
    await dialog.getByTestId('two-factor-code').fill('000000');
    await dialog.getByTestId('two-factor-verify').click();
    await expect(dialog.getByTestId('two-factor-error')).toBeVisible();
    await expect(dialog.getByTestId('two-factor-code')).toHaveValue('000000');
    await dialog.getByTestId('two-factor-code').fill(ALICE.twoFactorCode);
    await dialog.getByTestId('two-factor-verify').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('status-bar-account')).toHaveAttribute('title', ALICE.email);
    expect(server.tokens).toHaveLength(1);
  });

  test('Use a passkey opens the server’s passkey page in the browser, and Cancel comes back', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ALICE] });
    launched = await launchApp({ userDataDir });
    await launched.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __opened?: string[] }).__opened = opened;
      // The system browser, recorded: the test answers no loopback, so the dialog waits until Cancel.
      shell.openExternal = (target: string) => {
        opened.push(target);
        return Promise.resolve();
      };
    });
    const page = launched.window;
    await passwordStep(page, server.url);
    const dialog = page.getByTestId('sign-in-dialog');
    await dialog.getByTestId('two-factor-passkey').click();
    await expect(dialog.getByTestId('two-factor-waiting')).toContainText('Finish in your browser');
    const opened = (): Promise<string[]> =>
      launched!.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);
    await expect.poll(opened).toEqual([`${server.url}/sign-in/two-factor/passkey?flow=FLOW1`]);
    expect(server.passkeyStarts).toHaveLength(1);
    expect(server.passkeyStarts[0]!.loopbackPort).toBeGreaterThan(0);
    await dialog.getByTestId('two-factor-cancel-passkey').click();
    await expect(dialog.getByTestId('two-factor-step')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByTestId('two-factor-error')).toHaveCount(0);
    expect(server.tokens).toEqual([]);
  });
});

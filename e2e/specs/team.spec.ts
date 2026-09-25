import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };
/** The fake server's user id for an email. */
const uid = (email: string): string => `u-${email}`;

async function openSignIn(page: Page, url: string): Promise<Locator> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await dialog.getByTestId('sign-in-continue').click();
  return dialog;
}

async function signIn(page: Page, url: string, user: FakeUser): Promise<void> {
  const dialog = await openSignIn(page, url);
  await dialog.getByTestId('sign-in-email').fill(user.email);
  await dialog.getByTestId('sign-in-password').fill(user.password);
  await dialog.getByTestId('sign-in-submit').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function openTeams(page: Page): Promise<Locator> {
  await runCommand(page, 'Account: Manage teams');
  const dialog = page.getByTestId('team-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

test.describe('teams and workspace roles', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-team-'));
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a team admin creates a workspace, grants a member editor, and invites someone who then sees the team read-only', async () => {
    test.setTimeout(180_000);
    server = await startFakeServer({
      users: [ALICE, BOB],
      teams: [{ name: 'Payments QA', members: { [ALICE.email]: 'admin', [BOB.email]: 'member' } }],
    });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ALICE);

    let dialog = await openTeams(page);
    await expect(dialog.getByTestId('team-name')).toHaveValue('Payments QA');
    await expect(dialog.getByTestId(`member-row-${uid(BOB.email)}`)).toBeVisible();

    // A workspace: Alice is already the team's admin, so her role there is fixed, not granted.
    await dialog.getByRole('tab', { name: 'Workspaces' }).click();
    await dialog.getByTestId('workspace-new').click();
    await dialog.getByTestId('workspace-new-name').fill('Integration');
    await dialog.getByTestId('workspace-new-submit').click();
    await expect(dialog.locator('[data-testid^="workspace-role-"]')).toHaveText('Admin (team admin)');

    // Access: Bob starts at the default and becomes an editor; Alice, a team admin, is fixed.
    await dialog.locator('[data-testid^="workspace-access-"]').click();
    await expect(dialog.getByTestId(`access-effective-${uid(BOB.email)}`)).toHaveText('Viewer (workspace default)');
    await expect(dialog.getByTestId(`access-grant-${uid(ALICE.email)}`)).toBeDisabled();
    await dialog.getByTestId(`access-grant-${uid(BOB.email)}`).selectOption('editor');
    await expect(dialog.getByTestId(`access-effective-${uid(BOB.email)}`)).toHaveText('Editor (granted)');
    await dialog.getByTestId('access-back').click();

    // An invitation: the link is shown once, and Copy puts it on the clipboard.
    await dialog.getByRole('tab', { name: 'Members' }).click();
    await dialog.getByTestId('member-invite').click();
    const invite = page.getByTestId('invite-dialog');
    await invite.getByTestId('invite-email').fill('carol@example.com');
    await invite.getByTestId('invite-submit').click();
    const link = await invite.getByTestId('invite-link').inputValue();
    expect(link.startsWith(`${server.url}/invite/`)).toBe(true);
    await invite.getByTestId('invite-copy').click();
    await expect
      .poll(async () => launched!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe(link);
    await invite.getByRole('button', { name: 'Done' }).click();
    await dialog.getByRole('tab', { name: 'Invitations' }).click();
    await expect(dialog.locator('[data-testid^="invitation-row-"]')).toContainText('carol@example.com');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Carol accepts through the local path and lands on the team as a member.
    await page.getByTestId('status-bar-account').click();
    await page.getByTestId(`account-sign-out-${new URL(server.url).host}`).click();
    await expect(page.getByTestId('status-bar-account')).toContainText('Sign in', { timeout: 20_000 });
    const signInDialog = await openSignIn(page, server.url);
    await signInDialog.getByTestId('sign-in-have-code').click();
    await signInDialog.getByTestId('sign-in-code').fill(link);
    await signInDialog.getByTestId('sign-in-code-continue').click();
    await expect(signInDialog.getByTestId('sign-in-invited-email')).toContainText('carol@example.com');
    await signInDialog.getByTestId('sign-in-display-name').fill('Carol');
    await signInDialog.getByTestId('sign-in-new-password').fill('a password of length');
    await signInDialog.getByTestId('sign-in-confirm-password').fill('a password of length');
    await signInDialog.getByTestId('sign-in-accept').click();
    await expect(signInDialog).toBeHidden({ timeout: 20_000 });

    dialog = await openTeams(page);
    await expect(dialog.getByTestId('team-name')).toHaveValue('Payments QA');
    await expect(dialog.getByTestId('team-name')).toHaveAttribute('readonly', '');
    await expect(dialog.getByTestId(`member-row-${uid('carol@example.com')}`)).toBeVisible();
    await expect(dialog.locator('[data-testid^="member-role-"]')).toHaveCount(0);
    await expect(dialog.getByTestId('member-add')).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Invitations' })).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Workspaces' }).click();
    await expect(dialog.locator('[data-testid^="workspace-role-"]')).toHaveText('Viewer (workspace default)');
    await expect(dialog.locator('[data-testid^="workspace-access-"]')).toHaveCount(0);
  });

  test('a server admin creates a team and adds its first admin', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT, ALICE] });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ROOT);

    const dialog = await openTeams(page);
    await expect(dialog.getByTestId('team-list')).toContainText('You are not on a team on this server yet.');
    await dialog.getByTestId('team-new').click();
    await dialog.getByTestId('team-new-name').fill('Platform');
    await dialog.getByTestId('team-new-submit').click();
    await expect(dialog.getByTestId('team-name')).toHaveValue('Platform');
    await expect(dialog.getByTestId('team-delete')).toBeVisible();

    await dialog.getByTestId('member-add').click();
    await dialog.getByTestId('member-add-email').fill(ALICE.email);
    await dialog.getByTestId('member-add-role').selectOption('admin');
    await dialog.getByTestId('member-add-submit').click();
    await expect(dialog.getByTestId(`member-role-${uid(ALICE.email)}`)).toHaveValue('admin');
  });
});

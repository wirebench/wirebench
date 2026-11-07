/**
 * The Domain tab (hosted edition spec §23.6) against the fake server, playing a hosted team with the
 * `custom-domains` feature. The real server refuses hosted mode until the hosted edition is switched on, and a
 * hosted team is reached at `<slug>.<app-domain>`, which needs DNS the e2e machine does not have; the routes' own
 * behaviour is covered by the server's integration tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import { signIn } from '../helpers/server.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };
const NAME = 'wirebench.customer.test';

async function openTeams(page: Page) {
  await runCommand(page, 'Account: Manage team');
  const dialog = page.getByTestId('team-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

test.describe('custom domain (hosted edition spec §23.6)', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-domain-'));
  });
  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a server admin claims a name, checks its records, sees it go live and removes it', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT], customDomains: { appDomain: 'app.test' } });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ROOT);

    let dialog = await openTeams(page);
    await dialog.getByRole('tab', { name: 'Domain' }).click();
    await dialog.getByTestId('domain-name-input').fill(NAME);
    await dialog.getByTestId('domain-claim').click();
    await expect(dialog.getByTestId('domain-state')).toHaveText('Waiting for the DNS records');
    await expect(dialog.getByTestId('domain-record-0-value')).toHaveText('custom.app.test');
    await expect(dialog.getByTestId('domain-record-1-name')).toHaveText(`_wirebench.${NAME}`);
    await expect(dialog.getByTestId('domain-record-1-value')).toHaveText(/^wirebench-domain-verification=/);

    await dialog.getByTestId('domain-check').click();
    await expect(dialog.getByTestId('domain-state')).toHaveText('Records found');
    await expect(dialog.getByTestId('domain-last-result')).toContainText('holds this claim');
    await dialog.getByTestId('domain-check').click();
    await expect(dialog.getByTestId('domain-error')).toHaveText(
      'This name was checked less than a minute ago. Try again in 60 seconds.',
    );

    // The job moves a verified name on once its certificate is live; the dialog reads it when it opens again.
    server.setDomainState('active');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    dialog = await openTeams(page);
    await dialog.getByRole('tab', { name: 'Domain' }).click();
    await expect(dialog.getByTestId('domain-state')).toHaveText('Active');
    await expect(dialog.getByTestId('domain-idp-notice')).toContainText('redirect URI');

    await dialog.getByTestId('domain-remove').click();
    await page.getByTestId('domain-remove-confirm-button').click();
    await expect(dialog.getByTestId('domain-name-input')).toBeVisible();
    expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/api/v1/tenant/domain')).toBe(true);
  });

  test('a self-hosted server shows no Domain tab', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT] });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ROOT);

    const dialog = await openTeams(page);
    await expect(dialog.getByRole('tab', { name: 'License' })).toBeVisible();
    await expect.poll(() => server!.requests.some((r) => r.path === '/api/v1/tenant/domain')).toBe(true);
    await expect(dialog.getByRole('tab', { name: 'Domain' })).toHaveCount(0);
  });
});

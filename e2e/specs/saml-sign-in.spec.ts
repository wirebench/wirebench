import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';

const ROOT: FakeUser = {
  email: 'root@example.com',
  password: 'correct horse battery',
  displayName: 'Root',
  serverAdmin: true,
};
const ENTERPRISE = `wbl1.${Buffer.from(
  JSON.stringify({
    id: '01J9ZK3V8Q0000000000000000',
    customer: 'Example AG',
    edition: 'enterprise',
    seats: null,
    issuedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2099-09-01T00:00:00Z',
  }),
).toString('base64url')}.c2lnbmF0dXJl`;

/**
 * The desktop half of SAML sign-in (saml-scim spec §3.2, §3.7). The fake server stands in for the server, the
 * IdP and the ACS at once; validating real assertions is the server integration tests' job. The browser is
 * played by replacing `shell.openExternal` with a fetch that follows the IdP's redirect to the loopback.
 */
test.describe('SAML sign-in and the Provisioning tab', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-saml-'));
  });
  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('Continue with SSO signs in through the browser; an admin creates a SCIM token and links a group', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({
      users: [ROOT],
      saml: { email: ROOT.email, displayName: 'Contoso' },
      teams: [{ name: 'Platform', members: { [ROOT.email]: 'admin' } }],
      scimGroups: [{ displayName: 'Engineering', memberCount: 2 }],
    });
    launched = await launchApp({ userDataDir });
    const page = launched.window;
    await launched.app.evaluate(({ shell }) => {
      shell.openExternal = async (target: string) => {
        const answer = await fetch(target);
        if (!answer.ok) throw new Error(`the fake browser got ${String(answer.status)}`);
      };
    });

    await runCommand(page, 'Account: Sign in to a server');
    const signIn = page.getByTestId('sign-in-dialog');
    await expect(signIn).toBeVisible({ timeout: 20_000 });
    await signIn.getByTestId('sign-in-url').fill(server.url);
    await signIn.getByTestId('sign-in-continue').click();
    await expect(signIn.getByTestId('sign-in-saml')).toHaveText('Continue with Contoso');
    await signIn.getByTestId('sign-in-saml').click();
    await expect(signIn).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('status-bar-account')).toContainText(ROOT.email);
    expect(server.requests.some((r) => r.method === 'POST' && r.path === '/api/v1/auth/saml/complete')).toBe(true);

    await runCommand(page, 'Account: Manage teams');
    const dialog = page.getByTestId('team-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('tab', { name: 'Provisioning' }).click();
    await expect(dialog.getByTestId('provisioning-gated')).toBeVisible();

    await dialog.getByRole('tab', { name: 'License' }).click();
    await dialog.getByTestId('license-input').fill(ENTERPRISE);
    await dialog.getByTestId('license-install').click();
    await expect(dialog.getByTestId('license-edition')).toHaveText('Enterprise');

    await dialog.getByRole('tab', { name: 'Provisioning' }).click();
    await expect(dialog.getByTestId('provisioning-saml-configured')).toHaveText('Configured');
    await expect(dialog.getByTestId('provisioning-scim-url')).toHaveText(`${server.url}/scim/v2`);

    await dialog.getByTestId('provisioning-token-name').fill('Entra ID');
    await dialog.getByTestId('provisioning-token-create').click();
    await expect(dialog.getByTestId('provisioning-created-token')).toHaveValue(/^wbscim_[A-Za-z0-9_-]{43}$/);
    await dialog.getByTestId('provisioning-created-done').click();
    await expect(dialog.getByTestId('provisioning-created')).toHaveCount(0);
    await expect(dialog.getByTestId('provisioning-tokens')).toContainText('Entra ID');

    const team = dialog.getByRole('combobox', { name: 'Team for Engineering' });
    await expect(team).toHaveValue('');
    await team.selectOption({ label: 'Platform' });
    await expect(team).not.toHaveValue('');
    expect(
      server.requests.some((r) => r.method === 'PUT' && /^\/api\/v1\/scim-groups\/[^/]+\/team$/.test(r.path)),
    ).toBe(true);
  });
});

/**
 * Settings › Server › Sign-in (hosted edition spec §22.13) against the fake server, playing a hosted team, and a fake
 * OIDC issuer on loopback. The real server refuses hosted mode until the hosted edition is switched on, so the fake
 * plays the tenant settings routes; their checks (discovery over `https`, the metadata parse) are covered by the
 * server's integration tests. What this checks is the app's half: the group shows for a server admin, the card sends
 * the typed secret once, and shows it afterwards only as Set.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { signIn } from '../helpers/server.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };

/** An issuer that answers its discovery document, and nothing else. */
async function startIssuer(): Promise<{ readonly url: string; readonly hits: () => number; close(): Promise<void> }> {
  let hits = 0;
  let url = '';
  const server: Server = createServer((request, response) => {
    if (request.url === '/.well-known/openid-configuration') {
      hits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          jwks_uri: `${url}/jwks`,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe('Settings › Server (hosted edition spec §22.13)', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let issuer: Awaited<ReturnType<typeof startIssuer>> | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-server-settings-'));
  });
  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    await issuer?.close();
    issuer = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a server admin saves the team’s OIDC provider, checked against its issuer', async () => {
    test.setTimeout(120_000);
    issuer = await startIssuer();
    server = await startFakeServer({ users: [ROOT], tenantSettings: true });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ROOT);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
    const editor = page.getByTestId('preferences-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByTestId('settings-nav-server')).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByTestId('settings-nav-server-billing')).toBeVisible();
    await editor.getByTestId('settings-nav-server-sign-in').click();

    const card = page.getByTestId('server-oidc');
    await expect(card.getByTestId('server-oidc-state')).toHaveText('Not set up');
    await card.getByTestId('server-oidc-issuer').fill(issuer.url);
    await card.getByTestId('server-oidc-client-id').fill('wirebench');
    await card.getByTestId('server-oidc-secret-input').fill('client-secret-value');
    await card.getByTestId('server-oidc-display-name').fill('Sign in with Acme SSO');
    await card.getByTestId('server-oidc-save').click();

    await expect(card.getByTestId('server-oidc-state')).toHaveText('Connected');
    await expect(card.getByTestId('server-oidc-secret-state')).toHaveText('Set');
    await expect(card.getByTestId('server-oidc-secret-input')).toHaveCount(0);
    expect(issuer.hits()).toBe(1);
    expect(server.requests.some((r) => r.method === 'PUT' && r.path === '/api/v1/tenant/settings/oidc')).toBe(true);
    // The secret is never put back on the page.
    await expect(page.getByText('client-secret-value')).toHaveCount(0);

    // An issuer that does not answer is refused, in the server's words, and nothing changes.
    await card.getByTestId('server-oidc-issuer').fill('http://127.0.0.1:9');
    await card.getByTestId('server-oidc-secret-replace').click();
    await card.getByTestId('server-oidc-secret-input').fill('another');
    await card.getByTestId('server-oidc-save').click();
    await expect(card.getByTestId('server-oidc-error')).toContainText('did not answer');
  });
});

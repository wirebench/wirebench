/**
 * OAuth2, end to end, against the stub authorization server.
 *
 * The unit and main-process suites cover the grants themselves; what only the real app can show is
 * that the whole chain holds: a client secret typed into the inspector reaches the keychain and
 * nowhere else, main obtains a token with it, a request that merely *inherits* that configuration
 * goes out with the token, and clearing it makes the next send obtain a new one.
 *
 * The authorization-code grant is covered in main's own tests (it needs a browser); here it is
 * asserted only where the UI is the thing under test — the redirect URI a provider must register.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  createApi,
  createRestRequest,
  oauth2State,
  openApiTab,
  openRequestTab,
  responseStatus,
  sendRest,
  setApiOAuth2ClientCredentials,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

const CLIENT = { id: 'app', secret: 's3cret' };

test.describe('OAuth2', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
  });

  test('obtains a token from the API tab, sends with it, and obtains again after Clear', async () => {
    server = await startTestRestServer({ oauthClient: CLIENT });
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'OAuth2');
    await createProject(page, 'Secure');
    await createApi(page, 'Secure', server.url);
    await openApiTab(page, 'Secure');
    await setApiOAuth2ClientCredentials(page, {
      tokenUrl: `${server.url}/oauth2/token`,
      clientId: CLIENT.id,
      clientSecret: CLIENT.secret,
      scopes: 'read',
    });

    // No token until one is asked for: the app never contacts an issuer on its own.
    await expect(oauth2State(page)).toHaveText('No token yet');
    await page.getByTestId('oauth2-get-token').click();
    await expect(oauth2State(page)).toHaveText('Token held', { timeout: 20_000 });
    await expect(page.getByTestId('oauth2-status')).toContainText('expires in');
    // With show-secrets off, the token exists but is not on screen.
    await expect(page.getByTestId('oauth2-token')).toBeHidden();
    expect(server.issuedTokens).toHaveLength(1);

    // A request that configures nothing of its own inherits the API's OAuth2 and sends with it.
    await createRestRequest(page, 'Secure', 'Whoami');
    await setMethodAndUrl(page, 'GET', '/auth/bearer');
    await openRequestTab(page, 'Auth');
    await expect(page.getByTestId('rest-auth-source')).toContainText('Inherited');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    await expect(page.getByTestId('rest-response-body')).toContainText('bearer', { timeout: 20_000 });

    // Clearing throws the token away; the next send has to obtain another one.
    await openApiTab(page, 'Secure');
    await page.getByTestId('oauth2-clear-token').click();
    await expect(oauth2State(page)).toHaveText('No token yet');

    await page.getByTestId('oauth2-get-token').click();
    await expect(oauth2State(page)).toHaveText('Token held', { timeout: 20_000 });
    expect(server.issuedTokens).toHaveLength(2);
    expect(server.issuedTokens[0]).not.toBe(server.issuedTokens[1]);
  });

  test('shows the redirect URI a provider must register for the authorization-code grant', async () => {
    server = await startTestRestServer({ oauthClient: CLIENT });
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'OAuth2');
    await createProject(page, 'Secure');
    await createApi(page, 'Secure', server.url);
    await openApiTab(page, 'Secure');
    await page.getByLabel('API authentication type').selectOption('oauth2');

    // Client credentials has no authorization request, so neither field is shown for it.
    await expect(page.getByTestId('oauth2-redirect-uri')).toBeHidden();
    await expect(page.getByLabel('API authorize url')).toBeHidden();

    await page.getByLabel('API oauth2 grant').selectOption('authorization-code');
    await expect(page.getByLabel('API authorize url')).toBeVisible();
    await expect(page.getByLabel('API pkce')).toBeChecked();
    // Loopback only, and a path the listener actually serves (see `main/oauth2.ts`). With no fixed
    // port configured the port is chosen per flow, so the URI shown is a template plus how to pin it.
    await expect(page.getByTestId('oauth2-redirect-uri')).toHaveText('http://127.0.0.1:<random port>/callback');
    await expect(page.getByTestId('oauth2-status')).toContainText('fixed callback port');
  });

  test('reports a refused grant instead of pretending it holds a token', async () => {
    server = await startTestRestServer({ oauthClient: CLIENT });
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'OAuth2');
    await createProject(page, 'Secure');
    await createApi(page, 'Secure', server.url);
    await openApiTab(page, 'Secure');
    await setApiOAuth2ClientCredentials(page, {
      tokenUrl: `${server.url}/oauth2/token`,
      clientId: CLIENT.id,
      clientSecret: 'wrong-secret',
    });

    await page.getByTestId('oauth2-get-token').click();

    await expect(oauth2State(page)).toHaveText('No token yet', { timeout: 20_000 });
    expect(server.issuedTokens).toHaveLength(0);
  });
});

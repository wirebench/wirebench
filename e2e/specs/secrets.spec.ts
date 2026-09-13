import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expandExplorer, saveAll, workspaceProjectDir } from '../helpers/project.js';
import {
  apiRow,
  createApi,
  createRestRequest,
  folderRow,
  openApiTab,
  openRequestTab,
  saveRequest,
  setApiOAuth2ClientCredentials,
  setMethodAndUrl,
} from '../helpers/rest.js';
import {
  startTestRestServer,
  startTestSoapServer,
  type TestRestServer,
  type TestSoapServer,
} from '../helpers/test-server.js';

const PASSWORD = 's3cret!';

/** Every file path under `dir`, recursively (files only). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

test.describe('secrets', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let restServer: TestRestServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    await restServer?.close();
    restServer = undefined;
    for (const dir of [userDataDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
  });

  test('a password entered for Basic auth on import never reaches the project folder or secrets.json in plaintext', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await createWorkspace(page);
    await createProject(page, 'Secrets');

    await page.getByRole('button', { name: 'Import WSDL…' }).click();
    await page.getByTestId('import-url-input').fill(server.wsdlUrl);
    await page.getByLabel('Use Basic auth').check();
    await page.getByLabel('Username').fill('alice');
    await page.getByRole('button', { name: 'Set…' }).click();
    await page.getByPlaceholder('Enter password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('Password')).toHaveText('••••••••');

    await page.getByTestId('import-submit').click();
    await expandExplorer(page, 'Request 1');

    // The test server ignores auth but records every request's headers, including the WSDL
    // fetch itself — so the recorded Authorization header proves the credentials were sent.
    const wsdlFetch = server.requests.find((r) => r.url.includes('wsdl'));
    expect(wsdlFetch).toBeDefined();
    const authHeader = wsdlFetch?.headers['authorization'];
    expect(authHeader).toBeDefined();
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(String(authHeader).replace(/^Basic /, ''), 'base64').toString('utf8');
    expect(decoded).toBe(`alice:${PASSWORD}`);

    // Saving is manual by default. Without this the folder holds nothing yet and the assertions
    // below would pass for the wrong reason — there is no plaintext because there is no file.
    await saveAll(page);

    // Nothing in the saved project folder may contain the plaintext password.
    for (const file of listFiles(workspaceProjectDir(userDataDir))) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} must not contain the plaintext password`).not.toContain(PASSWORD);
    }

    // `secrets.json` in the userData dir must not contain the plaintext password either, unless
    // OS-keychain encryption was unavailable and the store fell back to a flagged, unencrypted
    // (but still not human-readable-as-the-password) representation — base64 of the plaintext
    // does not contain the raw password string either way, but we still assert directly.
    const secretsPath = join(userDataDir, 'secrets.json');
    const secretsText = readFileSync(secretsPath, 'utf8');
    const secretsFile = JSON.parse(secretsText) as {
      version: number;
      entries: Record<string, { encrypted: boolean }>;
    };
    expect(secretsFile.version).toBe(2);
    if (Object.values(secretsFile.entries).every((entry) => entry.encrypted)) {
      expect(secretsText).not.toContain(PASSWORD);
    } else {
      // Headless CI without an OS keychain: the fallback still base64-encodes the value, so a
      // literal plaintext match still cannot appear, but we log rather than hard-fail on the
      // assumption that some environment could special-case this differently in the future.
      expect(secretsText).not.toContain(PASSWORD);
      console.log('[secrets.spec] OS keychain encryption unavailable in this environment; fallback path exercised.');
    }
  });

  test('the HTTP log redacts the Authorization header until show-secrets is toggled on', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    const isMac = await launched.app.evaluate(() => process.platform === 'darwin');

    await createWorkspace(page);
    await createProject(page, 'Secrets');

    await page.getByRole('button', { name: 'Import WSDL…' }).click();
    await page.getByTestId('import-url-input').fill(server.wsdlUrl);
    await page.getByLabel('Use Basic auth').check();
    await page.getByLabel('Username').fill('alice');
    await page.getByRole('button', { name: 'Set…' }).click();
    await page.getByPlaceholder('Enter password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Save' }).click();
    // The interface's credentials are reused when sending, which is what puts an
    // `Authorization` header on the exchange the HTTP log shows.
    await page.getByLabel('Use these credentials for requests too').check();
    await page.getByTestId('import-submit').click();
    await expandExplorer(page, 'Request 1');

    const requestRow = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first();
    await expect(requestRow).toBeVisible({ timeout: 20_000 });
    await requestRow.click();
    await expect(page.locator('[data-testid="request-editor"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="request-send"]').click();
    await expect(page.locator('[data-testid="response-status"]')).toContainText(/\d{3}/, { timeout: 15_000 });

    await page.locator('[data-testid="http-log-row"]').first().click();
    const rawRequest = page.getByLabel('Raw request');
    await expect(rawRequest).toContainText('Authorization: <redacted>');
    await expect(rawRequest).not.toContainText('Basic ');

    // Toggling show-secrets through the palette re-reads the cached exchange from main.
    await page.keyboard.press(isMac ? 'Meta+k' : 'Control+k');
    await page.getByRole('option').filter({ hasText: 'Show Secrets' }).first().click();

    await expect(rawRequest).toContainText('Authorization: Basic ', { timeout: 10_000 });
  });

  test('every REST credential a project holds is a reference, not a value', async () => {
    // One of each scheme, on the three levels that can hold one, so a single grep proves the rule
    // for all of them: an API with OAuth2, a folder with a Bearer token, a request with an API key.
    const TOKEN = 'folder-bearer-token-value';
    const KEY = 'request-api-key-value';
    const CLIENT_SECRET = 'api-client-secret-value';

    restServer = await startTestRestServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await createWorkspace(page);
    await createProject(page, 'Secrets');
    await createApi(page, 'Secure', restServer.url);

    // The API: OAuth2, whose client secret is the secret under test.
    await openApiTab(page, 'Secure');
    await setApiOAuth2ClientCredentials(page, {
      tokenUrl: `${restServer.url}/oauth2/token`,
      clientId: 'app',
      clientSecret: CLIENT_SECRET,
    });
    // And a remembered refresh token, which reserves a keychain slot of its own.
    await page.getByTestId('auth-remember-refresh').check();

    // A folder: a Bearer token.
    await apiRow(page, 'Secure').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New folder' }).click();
    // A new folder lands in inline rename mode; Escape keeps the name it was given. The API row is
    // still folded shut, so the folder has to be revealed before it can be right-clicked.
    await page.keyboard.press('Escape');
    await apiRow(page, 'Secure').click();
    await folderRow(page, 'Folder 1').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Auth…' }).click();
    const dialog = page.getByTestId('folder-auth-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Folder authentication type').selectOption('bearer');
    await dialog.getByRole('button', { name: 'Set…' }).click();
    await page.getByLabel('Folder token').fill(TOKEN);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('folder-auth-done').click();

    // A request: an API key.
    await createRestRequest(page, 'Secure', 'Keyed');
    await setMethodAndUrl(page, 'GET', '/echo');
    await openRequestTab(page, 'Auth');
    await page.getByLabel('Request authentication type').selectOption('api-key');
    await page.getByLabel('Request name').fill('X-Api-Key');
    await page.getByRole('button', { name: 'Set…' }).click();
    await page.getByLabel('Request value').fill(KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    // An edit made in an editor tab is staged until the request itself is saved — the API and the
    // folder were written straight through, this one needs its own Mod+S.
    await saveRequest(page);

    await saveAll(page);

    // Not one of the three values may appear anywhere in the saved project.
    for (const file of listFiles(workspaceProjectDir(userDataDir))) {
      const text = readFileSync(file, 'utf8');
      for (const secret of [TOKEN, KEY, CLIENT_SECRET]) {
        expect(text, `${file} must not contain a credential value`).not.toContain(secret);
      }
    }
    // What the files *do* hold is references, which is what makes the project shareable.
    const project = listFiles(workspaceProjectDir(userDataDir))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(project).toContain('tokenRef');
    expect(project).toContain('valueRef');
    expect(project).toContain('clientSecretRef');
    expect(project).toContain('refreshTokenRef');

    // And the keychain file holds them encrypted (or at least never as the literal string).
    const secretsText = readFileSync(join(userDataDir, 'secrets.json'), 'utf8');
    for (const secret of [TOKEN, KEY, CLIENT_SECRET]) {
      expect(secretsText).not.toContain(secret);
    }
  });
});

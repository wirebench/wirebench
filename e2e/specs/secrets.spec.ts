import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

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
  let userDataDir: string | undefined;
  let projectDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    for (const dir of [userDataDir, projectDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
    projectDir = undefined;
  });

  test('a password entered for Basic auth on import never reaches the project folder or secrets.json in plaintext', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Secrets');

    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;

    await page.getByTestId('welcome-new-project').click();
    await page.getByTestId('new-project-create').click();

    await page.getByTestId('welcome-import').click();
    await page.getByTestId('import-url-input').fill(server.wsdlUrl);
    await page.getByLabel('Use Basic auth').check();
    await page.getByLabel('Username').fill('alice');
    await page.getByRole('button', { name: 'Set…' }).click();
    await page.getByPlaceholder('Enter password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('Password')).toHaveText('••••••••');

    await page.getByTestId('import-submit').click();
    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first()).toBeVisible({
      timeout: 20_000,
    });

    // The test server ignores auth but records every request's headers, including the WSDL
    // fetch itself — so the recorded Authorization header proves the credentials were sent.
    const wsdlFetch = server.requests.find((r) => r.url.includes('wsdl'));
    expect(wsdlFetch).toBeDefined();
    const authHeader = wsdlFetch?.headers['authorization'];
    expect(authHeader).toBeDefined();
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(String(authHeader).replace(/^Basic /, ''), 'base64').toString('utf8');
    expect(decoded).toBe(`alice:${PASSWORD}`);

    // Nothing in the saved project folder may contain the plaintext password.
    for (const file of listFiles(projectDir)) {
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
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Secrets Log');

    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    const isMac = await launched.app.evaluate(() => process.platform === 'darwin');

    await page.getByTestId('welcome-new-project').click();
    await page.getByTestId('new-project-create').click();

    await page.getByTestId('welcome-import').click();
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

    const requestRow = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first();
    await expect(requestRow).toBeVisible({ timeout: 20_000 });
    await requestRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
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
});

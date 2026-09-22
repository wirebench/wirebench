import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { selectLogRow } from '../helpers/http-log.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const TOKEN = 'soap-interface-bearer-e2e';

/**
 * A Bearer token configured on a SOAP interface reaches the wire on a request that configures no
 * credentials of its own — and the HTTP log shows the header redacted, not the token.
 */
test.describe('SOAP owner token auth', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
  });

  test('a Bearer token on the interface is sent, and redacted in the HTTP log', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    launched = await launchApp();
    const page = launched.window;
    await createProjectWithCalculator(page, server);

    // Scoped to an `iface:` row: a binding row carries the interface's name as a prefix.
    const row = page.locator('[data-testid="explorer-tree-row"][data-tree-id^="iface:"]', { hasText: 'Calculator' });
    await row.first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show Interface Viewer' }).click();
    const overview = page.getByTestId('interface-overview');
    await expect(overview).toBeVisible({ timeout: 20_000 });

    await overview.getByLabel('Interface authentication type').selectOption('bearer');
    await overview.getByRole('button', { name: 'Set…' }).click();
    await overview.getByPlaceholder('Enter password').fill(TOKEN);
    await overview.getByRole('button', { name: 'Save' }).click();
    await expect(overview.getByLabel('Interface token')).toHaveText('••••••••');

    await openFirstRequest(page);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText(/\d{3}/, { timeout: 20_000 });

    const sent = server.requests.filter((request) => !request.url.includes('wsdl')).at(-1);
    expect(sent?.headers['authorization']).toBe(`Bearer ${TOKEN}`);

    await selectLogRow(page.locator('[data-testid="http-log-row"]').first());
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Request' }).click();
    const rawRequest = page.getByLabel('Raw request');
    await expect(rawRequest).toContainText('Authorization: <redacted>');
    await expect(rawRequest).not.toContainText(TOKEN);
  });
});

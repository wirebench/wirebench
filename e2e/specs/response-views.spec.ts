import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { monacoEditor } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('Response views (Raw, Query, Fault)', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
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
    for (const dir of [userDataDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
  });

  test('Raw shows the exact bytes sent/received, and Query resolves AddResult', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await openFirstRequest(page);

    // Set intA/intB to known values via the Outline so AddResult is deterministic.
    await page.getByRole('tab', { name: 'Outline' }).first().click();
    const outlineTree = page.getByRole('tree', { name: 'Request outline' });
    await expect(outlineTree).toBeVisible({ timeout: 10_000 });

    const intARow = page.locator('[data-testid="outline-row"]', { hasText: 'intA' }).first();
    await intARow.getByRole('button').last().click();
    const intAInput = intARow.locator('input');
    await intAInput.fill('1');
    await intAInput.press('Enter');

    const intBRow = page.locator('[data-testid="outline-row"]', { hasText: 'intB' }).first();
    await intBRow.getByRole('button').last().click();
    const intBInput = intBRow.locator('input');
    await intBInput.fill('2');
    await intBInput.press('Enter');

    await page.locator('[data-testid="request-send"]').click();
    const status = page.locator('[data-testid="response-status"]');
    await expect(status).toContainText(/200/, { timeout: 10_000 });

    // Request Raw: the bytes actually sent, headers included.
    await page.getByRole('tab', { name: 'Raw' }).first().click();
    const requestRaw = page.getByLabel('Request raw bytes');
    await expect(requestRaw).toBeVisible({ timeout: 10_000 });
    await expect(requestRaw).toContainText('POST');
    await expect(requestRaw).toContainText('<tem:intA>1</tem:intA>');

    // Response Raw: status line and the body.
    await page.getByRole('tab', { name: 'Raw' }).last().click();
    const responseRaw = page.getByLabel('Response raw bytes');
    await expect(responseRaw).toBeVisible({ timeout: 10_000 });
    await expect(responseRaw).toContainText('HTTP/1.1 200');
    await expect(responseRaw).toContainText('AddResult');

    // Query: XPath 3.1 over the response resolves AddResult to 3 (1 + 2).
    await page.getByRole('tab', { name: 'Query' }).click();
    const expression = page.getByLabel('Query expression');
    await expect(expression).toBeVisible({ timeout: 10_000 });
    await expression.fill('//tem:AddResult/text()');
    await expression.press('Enter');

    const results = page.getByTestId('query-results');
    await expect(results).toContainText('3', { timeout: 10_000 });
  });

  test('a SOAP fault auto-selects the Fault tab, showing the code and detail', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await openFirstRequest(page);

    // Point this request at the test server's /fault route via the endpoint's Custom… option.
    await page.getByTestId('request-endpoint').fill(`${server.url}/fault`);

    await page.locator('[data-testid="request-send"]').click();
    const status = page.locator('[data-testid="response-status"]');
    await expect(status).toContainText('SOAP Fault', { timeout: 10_000 });

    const faultTab = page.getByRole('tab', { name: 'Fault' });
    await expect(faultTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    const responseEditor = page.getByTestId('response-editor');
    await expect(responseEditor).toContainText('soapenv:Server');
    await expect(responseEditor).toContainText('Simulated fault');
    const detail = monacoEditor(page, 'Fault detail XML');
    await expect(detail).toBeVisible({ timeout: 10_000 });
    // Monaco's real editor renders text in `.view-line` spans, not as the container's own
    // textContent (see `editor.spec.ts`); assert against those instead.
    await expect(page.locator('.view-line', { hasText: '42' }).first()).toBeVisible({ timeout: 10_000 });
  });
});

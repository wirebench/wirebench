import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expandExplorer } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('walking skeleton: import -> open request -> send -> response', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    if (server) {
      await server.close();
    }
  });

  test('imports a WSDL, sends Add, and shows the response', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    // Interfaces are saved into a project of a workspace, so the skeleton starts by creating both.
    launched = await launchApp();
    const { window, app } = launched;

    const isMac = await app.evaluate(() => process.platform === 'darwin');

    await createWorkspace(window, 'Skeleton');
    await createProject(window, 'Skeleton Project');

    // Prefer the shortcut; fall back to the explorer's button if it didn't open the dialog
    // (keeps the spec resilient to focus-target quirks across platforms/CI).
    await window.keyboard.press(isMac ? 'Meta+i' : 'Control+i');
    const urlInput = window.locator('[data-testid="import-url-input"]');
    if (!(await urlInput.isVisible().catch(() => false))) {
      await window.getByRole('button', { name: 'Import WSDL…' }).click();
    }
    await expect(urlInput).toBeVisible();

    await urlInput.fill(server.wsdlUrl);
    await window.locator('[data-testid="import-submit"]').click();

    await expect(window.getByText('Calculator', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    // An imported interface arrives folded shut; unfold the tree down to its requests.
    await expandExplorer(window, 'Request 1');

    // The import already generated one `Request 1` per operation and saved it to disk; open
    // the one under Add, which a single click opens.
    const addRow = window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Add' }).first();
    await expect(addRow).toBeVisible({ timeout: 10_000 });
    const requestRow = window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first();
    await expect(requestRow).toBeVisible({ timeout: 10_000 });
    await requestRow.click();

    await expect(window.locator('[data-testid="request-editor"]')).toBeVisible({ timeout: 10_000 });

    await window.locator('[data-testid="request-send"]').click();

    const status = window.locator('[data-testid="response-status"]');
    await expect(status).toContainText(/200/, { timeout: 10_000 });

    // The test server's calculator responder computes a real AddResponse/AddResult (see
    // `packages/engine/test/helpers/test-soap-server.ts`), so this asserts the actual answer
    // rather than an echo of the request body.
    await expect(window.locator('[data-testid="response-editor"]')).toContainText('AddResult');

    await expect(window.locator('[data-testid="http-log-row"]')).toHaveCount(1);
    await expect(window.locator('[data-testid="http-log-row"]').first()).toContainText('200');

    await expect(window.locator('[data-testid="status-bar"]')).toContainText('200');
  });
});

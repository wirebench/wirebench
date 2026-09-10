import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('request properties and preferences', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  // Assigned in `beforeEach`; kept non-optional so `launchApp` (under
  // `exactOptionalPropertyTypes`) does not have to be handed `string | undefined`.
  let userDataDir = '';
  let projectDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Preferences');
  });

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
      if (dir.length > 0) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = '';
    projectDir = '';
  });

  test('a 100 ms request timeout beats a 500 ms endpoint, and is reported as a timeout', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    // The Details panel follows the active request tab, so the grid is already showing.
    const timeout = page.getByTestId('request-timeout');
    await expect(timeout).toBeVisible({ timeout: 20_000 });
    await timeout.fill('100');
    await timeout.press('Enter');

    // Point the request at a route that answers half a second later than that.
    await page.getByTestId('request-endpoint').fill(`${server!.url}/delay/500`);

    await page.getByTestId('request-send').click();

    await expect(page.getByTestId('response-status')).toContainText('timeout', {
      ignoreCase: true,
      timeout: 20_000,
    });

    // …and the failure is a Problems entry, not just a transient status line.
    await page.getByRole('tab', { name: /Problems/ }).click();
    await expect(page.getByRole('list', { name: 'Problems' })).toContainText('timeout', { ignoreCase: true });
  });

  test('the Editor tab size drives a recreated envelope, and the UI theme drives the shell', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    // ⌘, / Ctrl+, opens the Preferences tab.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
    await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('preferences-editor').getByRole('button', { name: 'Editor', exact: true }).click();
    const tabSize = page.getByTestId('preferences-tab-size');
    await tabSize.fill('2');
    await tabSize.press('Enter');

    // --- the theme, from the same editor --------------------------------------
    await page.getByTestId('preferences-editor').getByRole('button', { name: 'UI', exact: true }).click();
    await page.getByTestId('preferences-theme').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 10_000 });

    // --- back to the request, and recreate it with the new indent -------------
    await page.getByRole('tab', { name: 'Request 1' }).click();
    // Recreate lives in the request pane's context menu since Task 32b.
    await page.getByTestId('request-pane-surface').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Recreate request (keep values)' }).click();

    await expect
      .poll(
        async () => {
          const lines = await page
            .locator('[aria-label="Request envelope XML"]')
            .locator('xpath=ancestor::*[contains(@class, "monaco-editor")][1]')
            .locator('.view-line')
            .allTextContents();
          // Monaco renders leading indentation as non-breaking spaces; normalise them so the
          // assertion is about the *number* of spaces, not their encoding.
          return lines.map((line) => line.replace(/ /g, ' '));
        },
        { timeout: 20_000 },
      )
      // Two spaces before `<soapenv:Header`, and never the three the default indent produces.
      .toEqual(expect.arrayContaining([expect.stringMatching(/^ {2}<soapenv:Header/)]));
  });
});

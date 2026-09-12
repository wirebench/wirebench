import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('WS-I Basic Profile reports', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let exportDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    exportDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-wsi-export-'));
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
    for (const dir of [exportDir]) {
      if (dir.length > 0) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    exportDir = '';
  });

  test('checks a sent exchange, shows the report, and exports it as HTML', async () => {
    const exportPath = join(exportDir, 'report.html');
    launched = await launchApp({
      // Playwright cannot drive a native Save-as panel; `wsi.exportHtml` honours the same
      // override as `dialogs.saveFile`.
      extraEnv: { WIREBENCH_E2E_DIALOG_SAVE: exportPath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    // The message assertions judge bytes on the wire, so there has to be an exchange first.
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('response-status')).toContainText(/200/, { timeout: 20_000 });

    await page.getByTestId('request-pane-surface').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Check WS-I compliance' }).click();

    // The console reveals its WS-I Report tab, with a clean summary for a conforming send.
    const report = page.getByTestId('wsi-report');
    await expect(report).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('wsi-label')).toContainText('Add');
    await expect(page.getByTestId('wsi-summary-failed')).toHaveText('Failed: 0');
    await expect(page.getByTestId('wsi-summary-warning')).toHaveText('Warning: 0');
    await expect(page.getByTestId('wsi-no-rows')).toContainText('No failures or warnings.');

    // "Failed only" off shows every assertion that ran.
    await page.getByTestId('wsi-filter-failed').click();
    await expect(page.getByTestId('wsi-row').first()).toBeVisible();

    await page.getByTestId('wsi-export-html').click();
    await expect
      .poll(
        () => {
          try {
            return readFileSync(exportPath, 'utf-8');
          } catch {
            return '';
          }
        },
        { timeout: 20_000 },
      )
      .toContain('<table');

    const html = readFileSync(exportPath, 'utf-8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Add');
    expect(html).not.toContain('<script');
  });

  test('checks the WSDL from the explorer and names the interface', async () => {
    const exportPath = join(exportDir, 'wsdl-report.html');
    launched = await launchApp({
      extraEnv: { WIREBENCH_E2E_DIALOG_SAVE: exportPath },
    });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);

    const interfaceRow = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Calculator' }).first();
    await expect(interfaceRow).toBeVisible({ timeout: 20_000 });
    await interfaceRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Check WSDL WS-I compliance' }).click();

    await expect(page.getByTestId('wsi-report')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('wsi-label')).toContainText('Calculator');

    // A clean description has no failing rows, so the export needs the full table.
    await page.getByTestId('wsi-filter-failed').click();
    await page.getByTestId('wsi-export-html').click();
    await expect
      .poll(
        () => {
          try {
            return readFileSync(exportPath, 'utf-8');
          } catch {
            return '';
          }
        },
        { timeout: 20_000 },
      )
      .toContain('<table');
    expect(readFileSync(exportPath, 'utf-8')).toContain('Calculator');
  });
});

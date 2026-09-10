import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('Form view', () => {
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

  test('filling the Calculator form writes the XML and sends the right values', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Form');

    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await openFirstRequest(page);

    // The first "Form" tab belongs to the request pane (the response pane has its own strip).
    await page.getByRole('tab', { name: 'Form' }).first().click();
    await expect(page.getByTestId('form-view')).toBeVisible({ timeout: 20_000 });

    const intA = page.getByLabel('tem:intA value');
    await expect(intA).toBeVisible({ timeout: 20_000 });
    await intA.fill('20');
    const intB = page.getByLabel('tem:intB value');
    await intB.fill('22');

    // "Required only" keeps both required fields on screen — nothing is filtered away here.
    await page.getByRole('radio', { name: 'Required only' }).click();
    await expect(page.getByLabel('tem:intA value')).toBeVisible();

    // Switching back to XML shows the edits landed at exactly the right spans. Monaco renders
    // its own `.view-line` spans rather than exposing the text as container `textContent`.
    await page.getByRole('tab', { name: 'XML' }).first().click();
    await expect(page.locator('[aria-label="Request envelope XML"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.view-line', { hasText: 'intA' }).first()).toContainText('<tem:intA>20</tem:intA>', {
      timeout: 10_000,
    });
    await expect(page.locator('.view-line', { hasText: 'intB' }).first()).toContainText('<tem:intB>22</tem:intB>');

    await page.locator('[data-testid="request-send"]').click();
    await expect(page.locator('[data-testid="response-status"]')).toContainText(/200/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="response-editor"]')).toContainText('42');
  });
});

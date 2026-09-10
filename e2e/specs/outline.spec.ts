import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { monacoEditor } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('Outline view', () => {
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

  test('editing intA/intB in the Outline writes back to the XML and sends the right values', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Outline');

    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await openFirstRequest(page);

    // Switch the request pane to Outline (the first "Outline" tab belongs to the request pane).
    await page.getByRole('tab', { name: 'Outline' }).first().click();

    const outlineTree = page.getByRole('tree', { name: 'Request outline' });
    await expect(outlineTree).toBeVisible({ timeout: 10_000 });

    // intA/intB render as editable value cells; edit each to a known value.
    const intARow = page.locator('[data-testid="outline-row"]', { hasText: 'intA' }).first();
    await intARow.getByRole('button').last().click();
    const intAInput = intARow.locator('input');
    await intAInput.fill('5');
    await intAInput.press('Enter');

    const intBRow = page.locator('[data-testid="outline-row"]', { hasText: 'intB' }).first();
    await intBRow.getByRole('button').last().click();
    const intBInput = intBRow.locator('input');
    await intBInput.fill('7');
    await intBInput.press('Enter');

    // Switching back to XML shows the edits landed at the right spot, nowhere else. Monaco
    // renders its own `.view-line` spans rather than exposing the text as the container's own
    // textContent (see `editor.spec.ts`), so assert against those.
    await page.getByRole('tab', { name: 'XML' }).first().click();
    const editor = monacoEditor(page, 'Request envelope XML');
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.view-line', { hasText: 'intA' }).first()).toContainText('<tem:intA>5</tem:intA>', {
      timeout: 10_000,
    });
    await expect(page.locator('.view-line', { hasText: 'intB' }).first()).toContainText('<tem:intB>7</tem:intB>');

    // Sending computes the real answer from the edited values, not the original 1/2.
    await page.locator('[data-testid="request-send"]').click();
    const status = page.locator('[data-testid="response-status"]');
    await expect(status).toContainText(/200/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="response-editor"]')).toContainText('12');
  });
});

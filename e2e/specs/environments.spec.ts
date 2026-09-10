import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('environments', () => {
  let launched: LaunchedApp | undefined;
  let imported: TestSoapServer | undefined;
  let deployed: TestSoapServer | undefined;
  let userDataDir: string | undefined;
  let projectDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    for (const server of [imported, deployed]) {
      if (server) {
        await server.close();
      }
    }
    imported = undefined;
    deployed = undefined;
    for (const dir of [userDataDir, projectDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
    projectDir = undefined;
  });

  test('an environment override redirects the send, and an unresolved property is a problem', async () => {
    // Two deployments of the same service: the WSDL is imported from the first, but the
    // environment points every request at the second.
    imported = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    deployed = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Environments');

    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, imported);

    // --- add `uat` through the sidebar section ------------------------------
    await page.getByRole('button', { name: 'Add environment' }).click();
    await page.getByLabel('New environment name').fill('uat');
    await page.getByLabel('New environment name').press('Enter');
    const row = page.getByTestId('environment-row').filter({ hasText: 'uat' });
    await expect(row).toBeVisible();

    // --- point it at the second server --------------------------------------
    await row.dblclick();
    const override = page.getByLabel('Endpoint override for Calculator');
    await expect(override).toBeVisible({ timeout: 20_000 });
    await override.fill(`${deployed.url}/soap`);
    await override.press('Enter');

    // --- activate it from the status bar ------------------------------------
    await page.getByTestId('env-switcher').click();
    await page.getByRole('menuitem', { name: 'uat', exact: true }).click();
    await expect(page.getByTestId('env-switcher')).toContainText('uat');

    // --- send: the override wins over the imported address ------------------
    await openFirstRequest(page);
    await expect(page.getByTestId('endpoint-env-badge')).toBeVisible();
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('status-bar')).toContainText('200', { timeout: 20_000 });

    expect(deployed.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    // The first server only ever served the definition; nothing was sent to it.
    expect(imported.requests.filter((request) => request.method === 'POST')).toHaveLength(0);

    // --- an unresolvable property reference is reported in Problems ---------
    const line = page.locator('.view-line').filter({ hasText: 'intA' }).first();
    await line.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.type('<tem:intA>${#Env#missing}</tem:intA>');
    await expect(page.getByTestId('request-editor')).toContainText('#Env#missing');
    // The debounced editor write has to reach disk before the pre-send dry run reads it back.
    await page.waitForTimeout(1_000);

    await page.getByTestId('request-send').click();
    await page.getByRole('tab', { name: /Problems/ }).click();
    await expect(page.getByTestId('problem-row').first()).toContainText('${#Env#missing}', { timeout: 20_000 });
  });
});

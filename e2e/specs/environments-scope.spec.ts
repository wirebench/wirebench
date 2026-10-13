import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { environmentRow, openEnvironment, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProject,
  createWorkspace,
  expectExplorerRow,
  expectProjectCount,
  importCalculator,
  openRequestByQuickOpen,
} from '../helpers/project.js';
import { chooseContextMenuItem } from '../helpers/rest.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** Adds a workspace environment through the Environments view and renames it. */
async function addEnvironment(page: Page, name: string): Promise<void> {
  await openEnvironmentsView(page);
  await page.getByRole('button', { name: 'Add environment' }).click();
  const created = page.getByTestId('environment-row').filter({ hasText: 'Environment ' }).last();
  await expect(created).toBeVisible();
  await created.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('textbox', { name: /^Rename Environment / });
  await field.fill(name);
  await field.press('Enter');
  await expect(environmentRow(page, name)).toBeVisible();
}

/** Picks `name` in the title-bar switcher, which acts for the project of the focused request. */
async function pickEnvironment(page: Page, name: string): Promise<void> {
  await page.getByTestId('env-switcher').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  await expect(page.getByTestId('env-switcher')).toContainText(name);
}

test.describe('project-scoped environments', () => {
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
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    userDataDir = undefined;
  });

  test('a scoped environment is offered to its project only, each project keeps its own pick', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    // --- two projects, each with the Calculator imported --------------------------------
    await createWorkspace(page);
    await createProject(page, 'Alpha API');
    await importCalculator(page, server);
    await createProject(page, 'Beta API');
    await importCalculator(page, server);
    await expectProjectCount(page, 2);

    // Until a request tab has been focused the switcher has no project to act for.
    await expect(page.getByTestId('env-switcher')).toBeDisabled();

    // --- two environments: `Shared` for every project, `Billing sandbox` for Alpha only -
    await addEnvironment(page, 'Shared');
    await addEnvironment(page, 'Billing sandbox');
    await openEnvironment(page, 'Billing sandbox');
    const appliesTo = page.getByTestId('environment-applies-to');
    await expect(appliesTo).toBeVisible({ timeout: 20_000 });
    // The controls show the saved scope, so they change only once main has written it: click,
    // then wait, rather than check()/uncheck(), which expect the state to flip on the click.
    await appliesTo.getByLabel('Selected projects').click();
    await expect(appliesTo.getByLabel('Selected projects')).toBeChecked();
    // Narrowing starts from every project ticked.
    await expect(appliesTo.getByLabel('Applies to Alpha API')).toBeChecked();
    await expect(appliesTo.getByLabel('Applies to Beta API')).toBeChecked();
    await appliesTo.getByLabel('Applies to Beta API').click();
    await expect(appliesTo.getByLabel('Applies to Beta API')).not.toBeChecked();
    await expect(environmentRow(page, 'Billing sandbox').getByTestId('environment-scope-chip')).toHaveText([
      'Alpha API',
    ]);

    // --- a Beta request does not offer it -----------------------------------------------
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await openRequestByQuickOpen(page, 'Beta API');
    await page.getByTestId('env-switcher').click();
    await expect(page.getByRole('menuitem', { name: 'Shared', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Billing sandbox', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Shared', exact: true }).click();
    await expect(page.getByTestId('env-switcher')).toContainText('Shared');
    await expect(page.getByTestId('env-switcher-project')).toHaveText('Beta API');

    // --- pick it on Alpha; Beta keeps its own pick ---------------------------------------
    await openRequestByQuickOpen(page, 'Alpha API');
    await expect(page.getByTestId('env-switcher-project')).toHaveText('Alpha API');
    await pickEnvironment(page, 'Billing sandbox');
    await openRequestByQuickOpen(page, 'Beta API');
    await expect(page.getByTestId('env-switcher-project')).toHaveText('Beta API');
    await expect(page.getByTestId('env-switcher')).toContainText('Shared');
    await expect(page.getByTestId('env-switcher')).not.toContainText('Billing sandbox');

    // --- back on Alpha it is still Billing sandbox ---------------------------------------
    await openRequestByQuickOpen(page, 'Alpha API');
    await expect(page.getByTestId('env-switcher')).toContainText('Billing sandbox');

    // --- removing Alpha leaves the environment with no project ---------------------------
    const alphaRow = page.getByTestId('explorer-project-row').filter({ hasText: 'Alpha API' });
    await expectExplorerRow(alphaRow, page);
    await chooseContextMenuItem(page, alphaRow, 'Remove from workspace');
    await expect(page.getByTestId('remove-project-orphaned-environments')).toContainText('Billing sandbox');
    await page.getByTestId('remove-project-confirm').click();
    await expectProjectCount(page, 1);
    await openEnvironmentsView(page);
    await expect(environmentRow(page, 'Billing sandbox').getByTestId('environment-scope-chip')).toHaveText([
      'No project',
    ]);
  });
});

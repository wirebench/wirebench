import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  addEnvironment as addNamedEnvironment,
  environmentRow,
  openEnvironment,
  openEnvironmentsView,
} from '../helpers/environments.js';
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

/** Adds a workspace environment through the Environments view and names it (#746). */
async function addEnvironment(page: Page, name: string): Promise<void> {
  await openEnvironmentsView(page);
  await addNamedEnvironment(page, name);
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

    // Until a request tab has been focused the switcher asks which project to act for (#686 E19).
    await expect(page.getByTestId('env-switcher')).toContainText('Pick a project');

    // --- two environments: `Shared` for every project, `Billing sandbox` for Alpha only -
    await addEnvironment(page, 'Shared');
    await addEnvironment(page, 'Billing sandbox');
    await openEnvironment(page, 'Billing sandbox');
    // The Projects panel (#393) holds the selection; the rail's icon opens it.
    await page.getByTestId('rail-environment-projects').click();
    const projects = page.getByRole('complementary', { name: 'Projects' }).getByTestId('environment-projects');
    await expect(projects).toBeVisible({ timeout: 20_000 });
    // The controls show the saved scope, so they change only once main has written it: click,
    // then wait, rather than check()/uncheck(), which expect the state to flip on the click.
    await expect(projects.getByLabel('All projects')).toBeChecked();
    await expect(projects.getByLabel('Applies to Alpha API')).toBeChecked();
    await expect(projects.getByLabel('Applies to Beta API')).toBeChecked();
    // Clearing a box under All projects narrows the environment to every other project.
    await projects.getByLabel('Applies to Beta API').click();
    await expect(projects.getByLabel('Applies to Beta API')).not.toBeChecked();
    await expect(projects.getByLabel('All projects')).not.toBeChecked();
    await expect(projects.getByLabel('Applies to Alpha API')).toBeChecked();
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

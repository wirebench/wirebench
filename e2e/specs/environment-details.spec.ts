import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { environmentRow, openEnvironment, openEnvironmentsView } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, expectProjectCount, expectReopenedWorkspace } from '../helpers/project.js';

/** The right slide-over while it holds the open environment's details. */
function detailsPanel(page: Page) {
  return page.getByRole('complementary', { name: 'Environment details' });
}

test.describe('environment details panel', () => {
  let launched: LaunchedApp | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    userDataDir = undefined;
  });

  test('has no Code panel; colour and Applies to are set in the panel and survive a relaunch', async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await createWorkspace(page);
    await createProject(page, 'Alpha API');
    await createProject(page, 'Beta API');
    await expectProjectCount(page, 2);
    // Where requests are, the rail offers Code.
    await expect(page.getByTestId('rail-code')).toBeVisible();

    // --- an environment tab in front has no Code toggle --------------------------------------
    // Environments share the request strip (#607), so it is the tab in front, not the area, that
    // swaps Code for the environment's details.
    await openEnvironmentsView(page);
    await page.getByRole('button', { name: 'Add environment' }).click();
    await expect(environmentRow(page, 'Environment 1')).toBeVisible();
    await openEnvironment(page, 'Environment 1');
    await expect(page.getByTestId('rail-code')).toHaveCount(0);

    // --- the panel opens beside the page, with the environment's details --------------------
    const panel = detailsPanel(page);
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rail-environment-details')).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByTestId('environment-details-name')).toHaveText('Environment 1');
    // The page no longer carries colour or Applies to itself.
    await expect(page.getByTestId('environment-page').getByTestId('environment-look')).toHaveCount(0);

    // --- change colour and Applies to -------------------------------------------------------
    // The controls show the saved state, so they change once main has written it: click, then wait.
    await panel.getByRole('button', { name: 'Colour red' }).click();
    await expect(panel.getByRole('button', { name: 'Colour red' })).toHaveAttribute('aria-pressed', 'true');
    await panel.getByLabel('Selected projects').click();
    await expect(panel.getByLabel('Applies to Beta API')).toBeChecked();
    await panel.getByLabel('Applies to Beta API').click();
    await expect(panel.getByLabel('Applies to Beta API')).not.toBeChecked();
    await expect(environmentRow(page, 'Environment 1').getByTestId('environment-scope-chip')).toHaveText(['Alpha API']);

    // --- Escape puts it away; the rail's icon brings it back ---------------------------------
    await panel.getByLabel('Applies to Alpha API').focus();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await page.getByTestId('rail-environment-details').click();
    await expect(panel).toBeVisible();

    // --- relaunch: both are saved in the environment's file ----------------------------------
    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const reopened = launched.window;
    await expectReopenedWorkspace(reopened);
    await openEnvironmentsView(reopened);
    await openEnvironment(reopened, 'Environment 1');
    const again = detailsPanel(reopened);
    await expect(again).toBeVisible({ timeout: 20_000 });
    await expect(again.getByRole('button', { name: 'Colour red' })).toHaveAttribute('aria-pressed', 'true');
    await expect(again.getByLabel('Selected projects')).toBeChecked();
    await expect(again.getByLabel('Applies to Alpha API')).toBeChecked();
    await expect(again.getByLabel('Applies to Beta API')).not.toBeChecked();
    await expect(reopened.getByTestId('rail-code')).toHaveCount(0);
  });
});

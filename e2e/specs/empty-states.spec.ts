/**
 * Empty places offer their next step (#565): an empty project's Start page, the Start page once there is
 * an API, the empty Environments view, and the Search view's input taking focus when it opens.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';

test.describe('empty states', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
  });

  test('an empty project, the Start page, Environments and Search each offer the next step', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Pets');

    // The new project is selected and has nothing in it: the Start page offers the three ways in.
    const emptyProject = page.getByTestId('start-empty-project');
    await expect(emptyProject).toBeVisible({ timeout: 20_000 });
    await expect(emptyProject).toContainText('Pets has no APIs yet');
    for (const name of ['New REST API…', 'Import definition…', 'Import cURL…']) {
      await expect(emptyProject.getByRole('button', { name, exact: true })).toBeVisible();
    }

    // Import cURL… makes an API to hold the request; cancelling leaves no empty API behind (#575).
    await emptyProject.getByRole('button', { name: 'Import cURL…', exact: true }).click();
    const curlDialog = page.getByRole('dialog', { name: 'Import cURL' });
    await expect(curlDialog).toBeVisible({ timeout: 20_000 });
    await curlDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(curlDialog).toBeHidden();
    await expect(page.getByTestId('api-row')).toHaveCount(0, { timeout: 20_000 });
    await expect(emptyProject).toBeVisible({ timeout: 20_000 });

    await emptyProject.getByRole('button', { name: 'New REST API…', exact: true }).click();
    await expect(page.getByTestId('api-tab')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('api-row')).toHaveCount(1, { timeout: 20_000 });

    // Back on Start, the project has an API, so the page offers a new request in it.
    await page.getByRole('tab', { name: 'Start' }).click();
    const start = page.getByTestId('start-actions');
    await expect(start).toBeVisible();
    await expect(start.getByRole('button', { name: 'New request', exact: true })).toBeVisible();
    await expect(start.getByRole('button', { name: 'Import…', exact: true })).toBeVisible();

    // No environments yet: the view offers to make the first one.
    await page.getByTestId('activity-environments').click();
    const environments = page.getByTestId('environments-empty');
    await expect(environments).toBeVisible();
    await environments.getByRole('button', { name: 'New environment', exact: true }).click();
    await expect(page.locator('[data-testid="environment-row"][data-kind="environment"]')).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(environments).toBeHidden();

    // Opening Search puts the caret in its input.
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByTestId('search-input')).toBeFocused();
  });
});

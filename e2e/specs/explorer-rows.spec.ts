/**
 * A click on a project or API row opens its tab and leaves its children where they are (#680): folding is
 * the chevron's and a double-click's job. The row a context menu was opened on is outlined while the menu
 * is up, and an item from the menu selects that row before acting on it.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, createApi, createRestRequest, restRequestRow } from '../helpers/rest.js';

function projectRow(page: Page, name: string): Locator {
  return page.getByTestId('explorer-project-row').filter({ hasText: name });
}

/** The `treeitem` around a row, which carries `aria-selected` and `aria-expanded`. */
function treeItem(row: Locator): Locator {
  return row.locator('xpath=ancestor::*[@role="treeitem"][1]');
}

test.describe('Explorer rows: click, fold and the context menu target', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('a click opens without folding, a double-click folds, and the menu marks and selects its row', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Alpha');
    await createApi(page, 'Pets', 'http://localhost:9');
    await createRestRequest(page, 'Pets', 'List pets');
    await createRestRequest(page, 'Pets', 'Add pet');
    await expect(restRequestRow(page, 'Add pet')).toBeVisible({ timeout: 20_000 });

    // A click on the project row opens its tab; the API and its requests stay in view.
    await projectRow(page, 'Alpha').click();
    await expect(page.getByTestId('project-tab')).toBeVisible({ timeout: 20_000 });
    await expect(apiRow(page, 'Pets')).toBeVisible();
    await expect(restRequestRow(page, 'List pets')).toBeVisible();

    // Same for the API row.
    await apiRow(page, 'Pets').click();
    await expect(page.getByTestId('api-tab')).toBeVisible({ timeout: 20_000 });
    await expect(restRequestRow(page, 'List pets')).toBeVisible();
    await expect(treeItem(apiRow(page, 'Pets'))).toHaveAttribute('aria-expanded', 'true');

    // A double-click folds the API shut, and open again.
    await apiRow(page, 'Pets').dblclick();
    await expect(restRequestRow(page, 'List pets')).toHaveCount(0);
    await apiRow(page, 'Pets').dblclick();
    await expect(restRequestRow(page, 'List pets')).toBeVisible({ timeout: 20_000 });

    // The selection is on one request; the menu opens on the other, which wears the outline.
    await restRequestRow(page, 'List pets').click();
    await expect(treeItem(restRequestRow(page, 'List pets'))).toHaveAttribute('aria-selected', 'true');
    const target = restRequestRow(page, 'Add pet');
    await target.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible({ timeout: 20_000 });
    await expect(target).toHaveAttribute('data-menu-open', 'true');
    await expect(restRequestRow(page, 'List pets')).not.toHaveAttribute('data-menu-open', 'true');
    await expect(treeItem(target)).not.toHaveAttribute('aria-selected', 'true');

    // The action selects its target row first, so the copy is of the row under the pointer.
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(target).not.toHaveAttribute('data-menu-open', 'true');
    await expect(restRequestRow(page, 'Add pet copy')).toBeVisible({ timeout: 20_000 });
    await expect(treeItem(restRequestRow(page, 'List pets'))).not.toHaveAttribute('aria-selected', 'true');
  });
});
